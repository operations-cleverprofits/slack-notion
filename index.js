require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const notion = require("./notion");
const {
  buildCreateOrEditBlocks,
  buildEditSelectBlocks,
  parseSubmission,
  collectRelationTargets,
} = require("./blocks");

/** ====== ExpressReceiver + Health ====== */
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
});

receiver.app.use((req, _res, next) => {
  if (req.path === "/slack/events") {
    console.log("[/slack/events] incoming", new Date().toISOString(), req.method);
  }
  next();
});
receiver.app.get("/", (_req, res) => res.status(200).send("OK - Slack ↔ Notion"));
receiver.app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

/** ====== App Bolt ====== */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.error((err) => {
  console.error("⚠️ Bolt error:", err);
});

/** ====== Constantes ====== */
const A = {
  MODE: "mode_select",            // create | edit | subtask
  DB: "db_select",
  PAGE: "page_select",
  PROP_PREFIX: "prop::",
  COPY_LINK: "copy_link",
};

const VIEW = {
  STEP1: "v_step1",
  CREATE_FORM: "v_create_form",
  EDIT_PICK: "v_edit_pick",
  EDIT_FORM: "v_edit_form",
};

const SHORTCUT_ID = process.env.SLACK_SHORTCUT_ID || "push_to_notion";

/** Helper: bloque con permalink + botón copiar */
function buildPermalinkBlock(permalink) {
  if (!permalink) return [];
  return [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Message link:* <${permalink}|Open message>`
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Copy link" },
      action_id: A.COPY_LINK,
      value: permalink
    }
  }];
}

/** ====== Shortcut ====== */
app.shortcut(SHORTCUT_ID, async ({ shortcut, ack, client }) => {
  await ack();

  try {
    const textRaw = shortcut?.message?.text || "";
    const prefillTitle = textRaw ? textRaw.replace(/\n+/g, " ").trim().slice(0, 200) : "";

    // permalink del mensaje (si viene de message shortcut)
    let permalink = "";
    const channel_id = shortcut?.channel?.id;
    const message_ts = shortcut?.message?.ts;
    if (channel_id && message_ts) {
      try {
        const { permalink: link } = await client.chat.getPermalink({
          channel: channel_id,
          message_ts
        });
        permalink = link || "";
      } catch (e) {
        console.warn("getPermalink failed:", e?.data || e);
      }
    }

    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: "modal",
        callback_id: VIEW.STEP1,
        title: { type: "plain_text", text: "Push to Notion" },
        submit: { type: "plain_text", text: "Continue" },
        private_metadata: JSON.stringify({
          step: 1,
          prefillTitle,
          permalink,
          channel_id,
          message_ts
        }),
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
          },
          ...buildPermalinkBlock(permalink),
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
  const pages = await notion.searchPagesInDatabase(dbId, query);
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

/** ====== Botón "Copy link" ====== */
app.action(A.COPY_LINK, async ({ ack, body, client }) => {
  await ack();
  let md = {};
  try { md = JSON.parse(body?.view?.private_metadata || "{}"); } catch {}
  const channel = md.channel_id;
  const user = body.user.id;
  const link = body?.actions?.[0]?.value;
  if (channel && user && link) {
    try {
      await client.chat.postEphemeral({
        channel,
        user,
        text: `🔗 ${link}\nTip: usa *Cmd/Ctrl + C* para copiar.`
      });
    } catch (e) {
      console.error("postEphemeral (copy link) failed:", e);
    }
  }
});

/** ====== STEP1 -> ramifica ====== */
app.view(VIEW.STEP1, async ({ ack, view }) => {
  let md = {};
  try { md = JSON.parse(view.private_metadata || "{}"); } catch {}

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
    const baseMeta = { ...md, mode, database_id, relations };

    if (mode === "edit") {
      const blocks = buildEditSelectBlocks({ A, label: "Page" });
      return ack({
        response_action: "update",
        view: {
          type: "modal",
          callback_id: VIEW.EDIT_PICK,
          title: { type: "plain_text", text: "Edit page" },
          submit: { type: "plain_text", text: "Load" },
          private_metadata: JSON.stringify(baseMeta),
          blocks: [
            ...buildPermalinkBlock(md.permalink),
            ...blocks
          ]
        }
      });
    }

    if (mode === "subtask") {
      const blocks = buildEditSelectBlocks({ A, label: "Parent page" });
      return ack({
        response_action: "update",
        view: {
          type: "modal",
          callback_id: VIEW.EDIT_PICK,
          title: { type: "plain_text", text: "Add Subtask" },
          submit: { type: "plain_text", text: "Continue" },
          private_metadata: JSON.stringify({ ...baseMeta, mode: "subtask" }),
          blocks: [
            ...buildPermalinkBlock(md.permalink),
            ...blocks
          ]
        }
      });
    }

    // CREATE
    const blocks = buildCreateOrEditBlocks({
      A,
      props: dbProps,
      mode: "create",
      prefillTitle: md.prefillTitle || "",
    });

    return ack({
      response_action: "update",
      view: {
        type: "modal",
        callback_id: VIEW.CREATE_FORM,
        title: { type: "plain_text", text: "Create page" },
        submit: { type: "plain_text", text: "Create" },
        private_metadata: JSON.stringify(baseMeta),
        blocks: [
          ...buildPermalinkBlock(md.permalink),
          ...blocks
        ]
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

/** ====== EDIT_PICK ====== */
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
      const blocks = buildCreateOrEditBlocks({
        A,
        props: dbProps,
        mode: "edit",
        initialPage: page,
      });
      return ack({
        response_action: "update",
        view: {
          type: "modal",
          callback_id: VIEW.EDIT_FORM,
          title: { type: "plain_text", text: "Edit page" },
          submit: { type: "plain_text", text: "Update" },
          private_metadata: JSON.stringify({ ...md, page_id }),
          blocks: [
            ...buildPermalinkBlock(md.permalink),
            ...blocks
          ]
        }
      });
    }

    // SUBTASK: Title autollenado
    const blocks = buildCreateOrEditBlocks({
      A,
      props: dbProps,
      mode: "subtask",
      prefillTitle: md.prefillTitle || "",
    });

    return ack({
      response_action: "update",
      view: {
        type: "modal",
        callback_id: VIEW.CREATE_FORM,
        title: { type: "plain_text", text: "Add Subtask" },
        submit: { type: "plain_text", text: "Create" },
        private_metadata: JSON.stringify({ ...md, parent_page_id: page_id, as_subtask: true }),
        blocks: [
          ...buildPermalinkBlock(md.permalink),
          ...blocks
        ]
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

/** ====== CREATE_FORM ====== */
app.view(VIEW.CREATE_FORM, async ({ ack, body, view, client }) => {
  await ack();
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

/** ====== EDIT_FORM ====== */
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



