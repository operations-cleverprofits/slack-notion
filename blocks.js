/** Utilidades para renderizar y parsear propiedades Notion en Slack Blocks */

const READONLY_TYPES = new Set([
  "formula", "rollup", "created_time", "last_edited_time",
  "created_by", "last_edited_by", "files"
]);

function isEditable(prop) {
  return !READONLY_TYPES.has(prop.type);
}

exports.collectRelationTargets = (props) => {
  const rels = {};
  for (const [name, prop] of Object.entries(props || {})) {
    if (prop.type === "relation" && prop.relation?.database_id) {
      rels[name] = prop.relation.database_id;
    }
  }
  return rels;
};

exports.buildCreateBlocks = ({ A, props, meta }) => {
  return renderProps({ A, props, meta, initial: null });
};

exports.buildEditSelectBlocks = ({ A, meta, label = "Page" }) => ([
  {
    type: "input",
    block_id: A.PAGE,
    label: { type: "plain_text", text: label },
    element: {
      type: "external_select",
      action_id: A.PAGE,
      min_query_length: 0,
      placeholder: { type: "plain_text", text: "Search..." }
    }
  }
]);

exports.buildEditBlocks = ({ A, props, page, meta }) => {
  // Transforma la Page de Notion en valores iniciales de Slack
  const initial = convertPageToInitials(page);
  return renderProps({ A, props, meta, initial });
};

function renderProps({ A, props, meta, initial }) {
  const blocks = [];

  for (const [name, prop] of Object.entries(props || {})) {
    if (!isEditable(prop)) continue;

    const action_id = `${"prop::"}${name}`;
    const block_id = action_id; // igual para leer fácil

    const label = { type: "plain_text", text: name };

    switch (prop.type) {
      case "title":
      case "rich_text":
      case "url":
      case "email":
      case "phone_number":
      case "number": {
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "plain_text_input",
            action_id,
            multiline: prop.type === "rich_text",
            initial_value: initial?.[name]?.text ?? undefined
          }
        });
        break;
      }

      case "select": {
        const options = (prop.select?.options || []).map(o => ({
          text: { type: "plain_text", text: o.name }, value: o.name
        }));
        const initial_option = initial?.[name]?.select
          ? { text: { type: "plain_text", text: initial[name].select }, value: initial[name].select }
          : undefined;

        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "static_select",
            action_id,
            options,
            initial_option
          }
        });
        break;
      }

      case "multi_select": {
        const options = (prop.multi_select?.options || []).map(o => ({
          text: { type: "plain_text", text: o.name }, value: o.name
        }));
        const initial_options = (initial?.[name]?.multi_select || []).map(v => ({
          text: { type: "plain_text", text: v }, value: v
        }));

        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "multi_static_select",
            action_id,
            options,
            initial_options
          }
        });
        break;
      }

      case "date": {
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "datepicker",
            action_id,
            initial_date: initial?.[name]?.date ?? undefined
          }
        });
        break;
      }

      case "checkbox": {
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "checkboxes",
            action_id,
            options: [{ text: { type: "plain_text", text: "Checked" }, value: "true" }],
            initial_options: initial?.[name]?.checkbox ? [{ text: { type: "plain_text", text: "Checked" }, value: "true" }] : undefined
          }
        });
        break;
      }

      case "status": {
        const options = (prop.status?.options || []).map(o => ({
          text: { type: "plain_text", text: o.name }, value: o.name
        }));
        const initial_option = initial?.[name]?.status
          ? { text: { type: "plain_text", text: initial[name].status }, value: initial[name].status }
          : undefined;

        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "static_select",
            action_id,
            options,
            initial_option
          }
        });
        break;
      }

      case "relation": {
        // dynamic external_select; options handler leerá meta.relations[propName]
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "external_select",
            action_id,
            min_query_length: 0,
            placeholder: { type: "plain_text", text: "Search related pages..." },
            initial_option: initial?.[name]?.relation ?
              {
                text: { type: "plain_text", text: initial[name].relation.title || initial[name].relation.id },
                value: initial[name].relation.id
              } : undefined
          }
        });
        break;
      }
    }
  }

  if (!blocks.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No editable fields found in this database._" } });
  }

  return blocks;
}

function convertPageToInitials(page) {
  const out = {};
  const props = page?.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    switch (prop.type) {
      case "title":
        out[name] = { text: prop.title?.[0]?.plain_text || "" };
        break;
      case "rich_text":
        out[name] = { text: prop.rich_text?.[0]?.plain_text || "" };
        break;
      case "number":
        out[name] = { text: (prop.number ?? "").toString() };
        break;
      case "url":
        out[name] = { text: prop.url || "" };
        break;
      case "email":
        out[name] = { text: prop.email || "" };
        break;
      case "phone_number":
        out[name] = { text: prop.phone_number || "" };
        break;
      case "select":
        out[name] = { select: prop.select?.name || "" };
        break;
      case "multi_select":
        out[name] = { multi_select: (prop.multi_select || []).map(o => o.name) };
        break;
      case "date":
        out[name] = { date: prop.date?.start || undefined };
        break;
      case "checkbox":
        out[name] = { checkbox: !!prop.checkbox };
        break;
      case "status":
        out[name] = { status: prop.status?.name || "" };
        break;
      case "relation":
        // tomamos el primero como initial (ajustable a multi)
        const first = (prop.relation || [])[0];
        if (first) out[name] = { relation: { id: first.id, title: first.id } };
        break;
      default:
        break;
    }
  }
  return out;
}

exports.parseSubmission = ({ values, props }) => {
  const out = {};

  for (const [name, prop] of Object.entries(props || {})) {
    if (!isEditable(prop)) continue;
    const key = `prop::${name}`;
    const slot = values?.[key]?.[key];
    if (!slot) continue;

    switch (prop.type) {
      case "title":
        out[name] = { title: [{ text: { content: slot.value || "" } }] };
        break;
      case "rich_text":
        out[name] = { rich_text: [{ text: { content: slot.value || "" } }] };
        break;
      case "number":
        out[name] = { number: slot.value ? parseFloat(slot.value) : null };
        break;
      case "url":
        out[name] = { url: slot.value || null };
        break;
      case "email":
        out[name] = { email: slot.value || null };
        break;
      case "phone_number":
        out[name] = { phone_number: slot.value || null };
        break;
      case "select":
        out[name] = { select: slot.selected_option ? { name: slot.selected_option.value } : null };
        break;
      case "multi_select":
        out[name] = {
          multi_select: (slot.selected_options || []).map(o => ({ name: o.value }))
        };
        break;
      case "date":
        out[name] = { date: slot.selected_date ? { start: slot.selected_date } : null };
        break;
      case "checkbox":
        out[name] = { checkbox: (slot.selected_options || []).length > 0 };
        break;
      case "status":
        out[name] = { status: slot.selected_option ? { name: slot.selected_option.value } : null };
        break;
      case "relation":
        if (slot.selected_option?.value) {
          out[name] = { relation: [{ id: slot.selected_option.value }] };
        }
        break;
      default:
        break;
    }
  }

  return out;
};
