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

/** ---------- CREATE: primer paso "elige properties" (tipo +Add Property) ---------- */
exports.buildCreatePickerBlocks = ({ A, props }) => {
  const options = [];
  for (const [name, prop] of Object.entries(props || {})) {
    if (!isEditable(prop)) continue;
    if (prop.type === "title") continue; // Title siempre se incluye
    options.push({ text: { type: "plain_text", text: name }, value: name });
  }
  options.sort((a, b) => a.text.text.localeCompare(b.text.text));

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Select which properties you want to fill.*\n_Title is always included._" }
    },
    {
      type: "input",
      block_id: A.CHOOSE_PROPS,
      label: { type: "plain_text", text: "Properties" },
      element: {
        type: "multi_static_select",
        action_id: A.CHOOSE_PROPS,
        placeholder: { type: "plain_text", text: "Pick properties…" },
        options
      }
    }
  ];
};

/** ---------- Render de inputs (Create / Edit) ---------- */
exports.buildCreateBlocks = ({ A, props, meta, onlyProps = null, initial = null }) => {
  return renderProps({ A, props, meta, initial, onlyProps });
};

exports.buildEditSelectBlocks = ({ A, meta, label = "Page" }) => ([
  {
    type: "input",
    block_id: "page_select",
    label: { type: "plain_text", text: label },
    element: {
      type: "external_select",
      action_id: "page_select",
      min_query_length: 0,
      placeholder: { type: "plain_text", text: "Search..." }
    }
  }
]);

exports.buildEditBlocks = ({ A, props, page, meta }) => {
  const initial = convertPageToInitials(page);
  return renderProps({ A, props, meta, initial });
};

/** ---------- Resumen compacto del parent en "Add Subtask" ---------- */
exports.buildParentSummaryBlocks = (page, dbProps) => {
  const props = page?.properties || {};
  const lines = [];
  const candidates = ["Status", "Type", "Year", "Owner", "Assignee", "Due", "Date", "Client Name", "Name"];

  for (const c of candidates) {
    if (!props[c]) continue;
    const v = humanizeValue(props[c]);
    if (v) lines.push(`• *${c}:* ${v}`);
  }

  if (!lines.length) {
    const keys = Object.keys(dbProps || {}).filter(k => isEditable(dbProps[k])).slice(0, 5);
    for (const k of keys) {
      if (!props[k]) continue;
      const v = humanizeValue(props[k]);
      if (v) lines.push(`• *${k}:* ${v}`);
    }
  }

  if (!lines.length) return [];
  return [
    { type: "section", text: { type: "mrkdwn", text: "*Parent snapshot*" } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "divider" }
  ];
};

function humanizeValue(prop) {
  switch (prop.type) {
    case "title": return prop.title?.[0]?.plain_text || "";
    case "rich_text": return prop.rich_text?.[0]?.plain_text || "";
    case "number": return (prop.number ?? "").toString();
    case "url": return prop.url || "";
    case "email": return prop.email || "";
    case "phone_number": return prop.phone_number || "";
    case "select": return prop.select?.name || "";
    case "multi_select": return (prop.multi_select || []).map(o => o.name).join(", ");
    case "date": return prop.date?.start || "";
    case "checkbox": return prop.checkbox ? "Yes" : "No";
    case "status": return prop.status?.name || "";
    case "relation": return (prop.relation || []).length ? `${prop.relation.length} linked` : "";
    default: return "";
  }
}

function renderProps({ A, props, meta, initial, onlyProps }) {
  const blocks = [];

  const include = (name, prop) => {
    if (!isEditable(prop)) return false;
    if (!onlyProps) return true;           // sin filtro: incluye todos
    if (prop.type === "title") return true;
    return onlyProps.includes(name);
  };

  for (const [name, prop] of Object.entries(props || {})) {
    if (!include(name, prop)) continue;

    const action_id = `prop::${name}`;
    const block_id = action_id;
    const label = { type: "plain_text", text: name };

    switch (prop.type) {
      case "title":
      case "rich_text":
      case "url":
      case "email":
      case "phone_number":
      case "number":
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

      case "select":
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "static_select",
            action_id,
            options: (prop.select?.options || []).map(o => ({
              text: { type: "plain_text", text: o.name }, value: o.name
            })),
            initial_option: initial?.[name]?.select
              ? { text: { type: "plain_text", text: initial[name].select }, value: initial[name].select }
              : undefined
          }
        });
        break;

      case "multi_select":
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "multi_static_select",
            action_id,
            options: (prop.multi_select?.options || []).map(o => ({
              text: { type: "plain_text", text: o.name }, value: o.name
            })),
            initial_options: (initial?.[name]?.multi_select || []).map(v => ({
              text: { type: "plain_text", text: v }, value: v
            }))
          }
        });
        break;

      case "date":
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

      case "checkbox":
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "checkboxes",
            action_id,
            options: [{ text: { type: "plain_text", text: "Checked" }, value: "true" }],
            initial_options: initial?.[name]?.checkbox
              ? [{ text: { type: "plain_text", text: "Checked" }, value: "true" }]
              : undefined
          }
        });
        break;

      case "status":
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "static_select",
            action_id,
            options: (prop.status?.options || []).map(o => ({
              text: { type: "plain_text", text: o.name }, value: o.name
            })),
            initial_option: initial?.[name]?.status
              ? { text: { type: "plain_text", text: initial[name].status }, value: initial[name].status }
              : undefined
          }
        });
        break;

      case "relation":
        blocks.push({
          type: "input",
          block_id,
          label,
          element: {
            type: "external_select",
            action_id,
            min_query_length: 0,
            placeholder: { type: "plain_text", text: "Search related pages..." },
            initial_option: initial?.[name]?.relation
              ? {
                  text: { type: "plain_text", text: initial[name].relation.title || initial[name].relation.id },
                  value: initial[name].relation.id
                }
              : undefined
          }
        });
        break;
    }
  }

  if (!blocks.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No editable fields found for your selection._" } });
  }

  return blocks;
}

function convertPageToInitials(page) {
  const out = {};
  const props = page?.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    switch (prop.type) {
      case "title": out[name] = { text: prop.title?.[0]?.plain_text || "" }; break;
      case "rich_text": out[name] = { text: prop.rich_text?.[0]?.plain_text || "" }; break;
      case "number": out[name] = { text: (prop.number ?? "").toString() }; break;
      case "url": out[name] = { text: prop.url || "" }; break;
      case "email": out[name] = { text: prop.email || "" }; break;
      case "phone_number": out[name] = { text: prop.phone_number || "" }; break;
      case "select": out[name] = { select: prop.select?.name || "" }; break;
      case "multi_select": out[name] = { multi_select: (prop.multi_select || []).map(o => o.name) }; break;
      case "date": out[name] = { date: prop.date?.start || undefined }; break;
      case "checkbox": out[name] = { checkbox: !!prop.checkbox }; break;
      case "status": out[name] = { status: prop.status?.name || "" }; break;
      case "relation":
        const first = (prop.relation || [])[0];
        if (first) out[name] = { relation: { id: first.id, title: first.id } };
        break;
    }
  }
  return out;
}
exports.convertPageToInitials = convertPageToInitials;

/** ---------- Parse del submit ---------- */
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
        out[name] = { multi_select: (slot.selected_options || []).map(o => ({ name: o.value })) };
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
        if (slot.selected_option?.value) out[name] = { relation: [{ id: slot.selected_option.value }] };
        break;
    }
  }

  return out;
};

