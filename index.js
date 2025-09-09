require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const notion = require("./notion");
const {
  buildCreateBlocks,
  buildEditSelectBlocks,
  buildEditBlocks,
  parseSubmission,
  collectRelationTargets,
} = require("./blocks");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

// Healthchecks
receiver.app.get("/", (_req, res) => res.status(200).send("OK - Slack ↔ Notion"));
receiver.app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

/** ====== Constantes de acción/ids ====== */
const A = {
  MODE: "mode_select",            // create | edit | subtask
  DB: "db_select",
  PAGE: "page_select",
  // Cada propiedad dinámica tendrá action_id = "prop::<name>"
  PROP_PREFIX: "prop::",
};

const VIEW = {
  STEP1: "v_step1",
  CREATE_FORM: "v_create_form",
  EDIT_PICK: "v_edit_pick",
  EDIT_FORM: "v_edit_form",
};

/** ====== Shortcut: abre Step 1 ====== */
app.shortcut("push_to_notion", async ({ shortcut, ack, client }) => {
  await ack();
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
});

/** ====== Options (DB / Pages / Relations) ======
 * Slack llamará a estos handlers cuando el usuario tipee en external_select
 */
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
  // body.view.private_metadata guarda el database_id
  let md = {};
  try { md = JSON.parse(body?.view?.private_metadata || "{}"); } catch {}
  const query = options.value || "";
  const dbId = md.database_id;
  const pages = await notion.searchPagesInDatabase(dbId, query);
  const opts = pages.slice(0, 100).map(p => ({
    text: { type: "plain_text", text: p.title || p.id },
    value: p.id
  }));
  await ack({ options: opts });
});

app.options(/prop::/, async ({ options, ack, body }) => {
  // Relations: el action_id será "prop::<propName>"
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

/** ====== Submit Step 1 -> ramifica a CREATE / EDIT / SUBTASK ====== */
app.view(VIEW.STEP1, async ({ ack, body, view, client }) => {
  await ack();

  const state = view.state.values;
  const mode = state[A.MODE][A.MODE]?.selected_option?.value;
  const database_id = state[A.DB][A.DB]?.selected_option?.value;

  if (!mode || !database_id) return;

  // Cargamos propiedades de la DB
  const dbProps = await notion.getDatabaseProperties(database_id);
  const relations = collectRelationTargets(dbProps); // { [propName]: relatedDatabaseId }

  // Se guarda en private_metadata para vistas posteriores
  const meta = { mode, database_id, relations };

  if (mode === "edit") {
    // Pedir selección de página y luego cargar valores
    const blocks = buildEditSelectBlocks({ A, meta });
    await client.views.update({
      view_id: view.id,
      view: {
        type: "modal",
        callback_id: VIEW.EDIT_PICK,
        title: { type: "plain_text", text: "Edit page" },
        submit: { type: "plain_text", text: "Load" },
        private_metadata: JSON.stringify(meta),
        blocks
      }
    });
    return;
  }

  if (mode === "subtask") {
    // subtask = crear página con relación al padre en la MISMA DB
    // Primero pedimos el parent page, luego mostramos propiedades
    const blocks = buildEditSelectBlocks({ A, meta, label: "Parent page" });
    await client.views.update({
      view_id: view.id,
      view: {
        type: "modal",
        callback_id: VIEW.EDIT_PICK, // reutilizamos handler para cargar luego el form
        title: { type: "plain_text", text: "Add Subtask" },
        submit: { type: "plain_text", text: "Continue" },
        private_metadata: JSON.stringify({ ...meta, mode: "subtask" }),
        blocks
      }
    });
    return;
  }

  // CREATE directamente: renderizar propiedades vacías
  const blocks = buildCreateBlocks({ A, props: dbProps, meta });
  await client.views.update({
    view_id: view.id,
    view: {
      type: "modal",
      callback_id: VIEW.CREATE_FORM,
      title: { type: "plain_text", text: "Create page" },
      submit: { type: "plain_text", text: "Create" },
      private_metadata: JSON.stringify(meta),
      blocks
    }
  });
});

/** ====== Submit: elegir página (EDIT) o elegir parent (SUBTASK) -> cargar form ====== */
app.view(VIEW.EDIT_PICK, async ({ ack, body, view, client }) => {
  await ack();

  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}
  const { mode, database_id } = md;

  const state = view.state.values;
  const page_id = state[A.PAGE]?.[A.PAGE]?.selected_option?.value;
  if (!page_id) return;

  // Propiedades de DB + datos de página seleccionada
  const dbProps = await notion.getDatabaseProperties(database_id);

  if (mode === "edit") {
    const page = await notion.getPage(page_id);
    const blocks = buildEditBlocks({ A, props: dbProps, page, meta: { ...md, page_id } });
    await client.views.update({
      view_id: view.id,
      view: {
        type: "modal",
        callback_id: VIEW.EDIT_FORM,
        title: { type: "plain_text", text: "Edit page" },
        submit: { type: "plain_text", text: "Update" },
        private_metadata: JSON.stringify({ ...md, page_id }),
        blocks
      }
    });
    return;
  }

  if (mode === "subtask") {
    // Creamos un form de CREATE, pero con la relación al parent pre-establecida
    const blocks = buildCreateBlocks({
      A,
      props: dbProps,
      meta: { ...md, parent_page_id: page_id, as_subtask: true }
    });
    await client.views.update({
      view_id: view.id,
      view: {
        type: "modal",
        callback_id: VIEW.CREATE_FORM,
        title: { type: "plain_text", text: "Add Subtask" },
        submit: { type: "plain_text", text: "Create" },
        private_metadata: JSON.stringify({ ...md, parent_page_id: page_id, as_subtask: true }),
        blocks
      }
    });
  }
});

/** ====== Submit: CREATE o EDIT final ====== */
app.view(VIEW.CREATE_FORM, async ({ ack, body, view, client }) => {
  await ack();
  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}
  const { database_id, as_subtask, parent_page_id, relations } = md;

  const dbProps = await notion.getDatabaseProperties(database_id);
  const properties = parseSubmission({ values: view.state.values, props: dbProps });

  // Si es subtask, intentamos setear relación padre (sub-items nativos o self-relation)
  if (as_subtask) {
    // heurística: busca una relación self-relation llamada "Parent" o alguna relation que apunte a la misma DB
    const parentRel = Object.entries(dbProps).find(([name, p]) =>
      p?.type === "relation" && (p.relation?.database_id === database_id) &&
      (name.toLowerCase().includes("parent") || name.toLowerCase().includes("sub") || true)
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

app.view(VIEW.EDIT_FORM, async ({ ack, body, view, client }) => {
  await ack();
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
