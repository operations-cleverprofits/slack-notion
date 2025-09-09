require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const notion = require("./notion");
const {
  buildCreateBlocks,
  buildCreatePickerBlocks,
  buildEditSelectBlocks,
  buildEditBlocks,
  parseSubmission,
  collectRelationTargets,
  convertPageToInitials,
  buildParentSummaryBlocks,
} = require("./blocks");

/** ====== ExpressReceiver + Health ====== */
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

// Logs de tráfico para debug (verás una línea por request)
receiver.app.use((req, _res, next) => {
  if (req.path === "/slack/events") {
    console.log("[/slack/events] incoming", new Date().toISOString(), req.method);
  }
  next();
});

// Healthchecks
receiver.app.get("/", (_req, res) => res.status(200).send("OK - Slack ↔ Notion"));
receiver.app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/** ====== App Bolt ====== */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Manejo global de errores Bolt
app.error((err) => {
  console.error("⚠️ Bolt error:", err);
});

/** ====== Constantes ====== */
const A = {
  MODE: "mode_select",            // create | edit | subtask
  DB: "db_select",
  PAGE: "page_select",
  PROP_PREFIX: "prop::",
  CHOOSE_PROPS: "choose_props",
};

const VIEW = {
  STEP1: "v_step1",
  CREATE_PICK: "v_create_pick",
  CREATE_FORM: "v_create_form",
  EDIT_PICK: "v_edit_pick",
  EDIT_FORM: "v_edit_form",
};

// Permite configurar el Callback ID del shortcut por env (default: push_to_notion)
const SHORTCUT_ID = process.env.SLACK_SHORTCUT_ID || "push_to_notion";

/** ====== Shortcut: abre Step 1 ====== */
app.shortcut(SHORTCUT_ID, async ({ shortcut, ack, client }) => {
  // Ack inmediato para evitar timeouts 499
  await ack();

  try {
    console.log("shortcut received:", shortcut.callback_id);
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: "modal",
        callback_id: VIEW.STEP1,
        title: { type: "plain_text", text: "Push to Notion" },
        submit: { type: "plain_text", text: "Continue" },
        private_metadata: JSON.stringify({ step: 1 }),
        blocks: [
          {
            type: "input",
            block_id: A.MODE,
            label: { type: "plain_text", text: "Action" },
            element: {
              type: "static_select",
              action_id: A.MODE,
              options: [
                { text: { type: "plain_text", text: "Create" }, value: "create" },
                { text: { type: "plain_text", text: "Edit" }, value: "edit" },
                { text: { type: "plain_text", text: "Add Subtask" }, value: "subtask" }
              ]
            }
          },
          {
            type: "input",
            block_id: A.DB,
            label: { type: "plain_text", text: "Database" },
            element: {
              type: "external_select",
              action_id: A.DB,
              min_query_length: 0,
              placeholder: { type: "plain_text", text: "Search databases..." }
            }
          }
        ]
      }
    });
  } catch (e) {
    console.error("views.open failed:", e);
  }
});

/** ====== Options (DB / Pages / Relations) ====== */
app.options(A.DB, async ({ options, ack }) => {
  const query = options.value || "";
  const dbs = await notion.searchDatabases(query);
  const opts = dbs.slice(0, 100).map(db => ({
    text: { type: "plain_text", text: db.title || db.id },
    value: db.id
  }));
  await ack({ options: opts });
});

app.options(A.PAGE, async ({ options, ack, body }) => {
  let md = {};
  try { md = JSON.parse(body?.view?.private_metadata || "{}"); } catch {}
  const query = options.value || "";
  const dbId = md.database_id;
  const pages = await notion.searchPagesInDatabase(dbId, query); // títulos reales
  const opts = pages.slice(0, 100).map(p => ({
    text: { type: "plain_text", text: p.title || p.id },
    value: p.id
  }));
  await ack({ options: opts });
});

app.options(/prop::/, async ({ options, ack, body }) => {
  const actionId = options?.action_id || "";
  const propName = String(actionId).replace("prop::", "");
  let md = {};
  try { md = JSON.parse(body?.view?.private_metadata || "{}"); } catch {}

  const relatedDbId = md?.relations?.[propName];
  if (!relatedDbId) return ack({ options: [] });

  const query = options.value || "";
  const pages = await notion.searchPagesInDatabase(relatedDbId, query);
  const opts = pages.slice(0, 100).map(p => ({
    text: { type: "plain_text", text: p.title || p.id },
    value: p.id
  }));
  await ack({ options: opts });
});

/** ====== STEP1 -> ramifica a CREATE/EDIT/SUBTASK (responde con update) ====== */
app.view(VIEW.STEP1, async ({ ack, view }) => {
  const state = view.state.values;
  const mode = state[A.MODE]?.[A.MODE]?.selected_option?.value;
  const database_id = state[A.DB]?.[A.DB]?.selected_option?.value;

  if (!mode || !database_id) {
    return ack({
      response_action: "errors",
      errors: {
        [A.MODE]: !mode ? "Select an action." : undefined,
        [A.DB]: !database_id ? "Select a database." : undefined,
      },
    });
  }

  try {
    const dbProps = await notion.getDatabaseProperties(database_id);
    const relations = collectRelationTargets(dbProps);
    const meta = { mode, database_id, relations };

    if (mode === "edit") {
      const blocks = buildEditSelectBlocks({ A, meta });
      return ack({
        response_action: "update",
        view: {
          type: "modal",
          callback_id: VIEW.EDIT_PICK,
          title: { type: "plain_text", text: "Edit page" },
          submit: { type: "plain_text", text: "Load" },
          private_metadata: JSON.stringify(meta),
          blocks
        }
      });
    }

    if (mode === "subtask") {
      const blocks = buildEditSelectBlocks({ A, meta, label: "Parent page" });
      return ack({
        response_action: "update",
        view: {
          type: "modal",
          callback_id: VIEW.EDIT_PICK,
          title: { type: "plain_text", text: "Add Subtask" },
          submit: { type: "plain_text", text: "Continue" },
          private_metadata: JSON.stringify({ ...meta, mode: "subtask" }),
          blocks
        }
      });
    }

    // CREATE: primero picker de propiedades (como "+ Add Property")
    const blocks = buildCreatePickerBlocks({ A, props: dbProps });
    return ack({
      response_action: "update",
      view: {
        type: "modal",
        callback_id: VIEW.CREATE_PICK,
        title: { type: "plain_text", text: "Send to Notion" },
        submit: { type: "plain_text", text: "Next" },
        private_metadata: JSON.stringify(meta),
        blocks
      }
    });
  } catch (e) {
    console.error("STEP1 error:", e);
    return ack({
      response_action: "errors",
      errors: { [A.DB]: "I couldn’t load this database. Check access and try again." },
    });
  }
});

/** ====== CREATE_PICK -> render formulario con props elegidas ====== */
app.view(VIEW.CREATE_PICK, async ({ ack, view }) => {
  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}
  const { database_id } = md;

  const selected = view.state.values?.[A.CHOOSE_PROPS]?.[A.CHOOSE_PROPS]?.selected_options || [];
  const selectedPropNames = selected.map(o => o.value);

  try {
    const dbProps = await notion.getDatabaseProperties(database_id);
    const blocks = buildCreateBlocks({
      A,
      props: dbProps,
      meta: md,
      onlyProps: selectedPropNames,
    });

    return ack({
      response_action: "update",
      view: {
        type: "modal",
        callback_id: VIEW.CREATE_FORM,
        title: { type: "plain_text", text: "Create page" },
        submit: { type: "plain_text", text: "Create" },
        private_metadata: JSON.stringify({ ...md, onlyProps: selectedPropNames }),
        blocks
      }
    });
  } catch (e) {
    console.error("CREATE_PICK error:", e);
    return ack({
      response_action: "errors",
      errors: { [A.CHOOSE_PROPS]: "Couldn’t load properties. Try again." },
    });
  }
});

/** ====== EDIT_PICK -> cargar form de edición o subtask (responde con update) ====== */
app.view(VIEW.EDIT_PICK, async ({ ack, view }) => {
  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}
  const { mode, database_id } = md;

  const page_id = view.state.values?.[A.PAGE]?.[A.PAGE]?.selected_option?.value;

  if (!page_id) {
    return ack({
      response_action: "errors",
      errors: { [A.PAGE]: "Select a page." },
    });
  }

  try {
    const dbProps = await notion.getDatabaseProperties(database_id);

    if (mode === "edit") {
      const page = await notion.getPage(page_id);
      const blocks = buildEditBlocks({ A, props: dbProps, page, meta: { ...md, page_id } });
      return ack({
        response_action: "update",
        view: {
          type: "modal",
          callback_id: VIEW.EDIT_FORM,
          title: { type: "plain_text", text: "Edit page" },
          submit: { type: "plain_text", text: "Update" },
          private_metadata: JSON.stringify({ ...md, page_id }),
          blocks
        }
      });
    }

    // SUBTASK: snapshot + prefills heredados del parent
    const parentPage = await notion.getPage(page_id);
    const initialFromParent = convertPageToInitials(parentPage);
    const blocks = [
      ...buildParentSummaryBlocks(parentPage, dbProps),
      ...buildCreateBlocks({
        A,
        props: dbProps,
        meta: { ...md, parent_page_id: page_id, as_subtask: true },
        initial: initialFromParent,
      })
    ];

    return ack({
      response_action: "update",
      view: {
        type: "modal",
        callback_id: VIEW.CREATE_FORM,
        title: { type: "plain_text", text: "Add Subtask" },
        submit: { type: "plain_text", text: "Create" },
        private_metadata: JSON.stringify({ ...md, parent_page_id: page_id, as_subtask: true }),
        blocks
      }
    });
  } catch (e) {
    console.error("EDIT_PICK error:", e);
    return ack({
      response_action: "errors",
      errors: { [A.PAGE]: "Couldn’t load the page/database. Try again." },
    });
  }
});

/** ====== CREATE_FORM (crear página) ====== */
app.view(VIEW.CREATE_FORM, async ({ ack, body, view, client }) => {
  await ack(); // responder rápido al submit final
  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}
  const { database_id, as_subtask, parent_page_id } = md;

  const dbProps = await notion.getDatabaseProperties(database_id);
  const properties = parseSubmission({ values: view.state.values, props: dbProps });

  if (as_subtask) {
    const parentRel = Object.entries(dbProps).find(([_, p]) =>
      p?.type === "relation" && (p.relation?.database_id === database_id)
    );
    if (parentRel) {
      const [propName] = parentRel;
      properties[propName] = { relation: [{ id: parent_page_id }] };
    }
  }

  const page = await notion.createPage(database_id, properties);

  await client.chat.postEphemeral({
    channel: body.user.id,
    user: body.user.id,
    text: `✅ Created: ${page?.url || "Notion page"}`
  });
});

/** ====== EDIT_FORM (actualizar página) ====== */
app.view(VIEW.EDIT_FORM, async ({ ack, body, view, client }) => {
  await ack(); // responder rápido al submit final
  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}
  const { database_id, page_id } = md;

  const dbProps = await notion.getDatabaseProperties(database_id);
  const properties = parseSubmission({ values: view.state.values, props: dbProps });

  const updated = await notion.updatePage(page_id, properties);

  await client.chat.postEphemeral({
    channel: body.user.id,
    user: body.user.id,
    text: `✏️ Updated: ${updated?.url || "Notion page"}`
  });
});

/** ====== Start ====== */
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Slack ↔ Notion running on port", process.env.PORT || 3000);
})();



