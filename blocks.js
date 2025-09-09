/** Render helpers para Slack Blocks ←→ Notion */

const READONLY_TYPES = new Set([
  "formula", "rollup", "created_time", "last_edited_time",
  "created_by", "last_edited_by", "files"
]);

const isEditable = (prop) => !READONLY_TYPES.has(prop.type);

/**
 * Orden: respetamos el orden de llegada del esquema de Notion.
 * - Title primero (si existe).
 * - Luego el resto en el orden enumerado por la API.
 */
const orderPropertyEntries = (props) => {
  const entries = Object.entries(props || {});
  let titleKey = null;
  for (const [name, p] of entries) {
    if (p.type === "title") { titleKey = name; break; }
  }
  const rest = entries.filter(([name]) => name !== titleKey);
  return titleKey ? [[titleKey, props[titleKey]], ...rest] : entries;
};

exports.collectRelationTargets = (props) => {
  const rels = {};
  for (const [name, prop] of Object.entries(props || {})) {
    if (prop.type === "relation" && prop.relation?.database_id) {
      rels[name] = prop.relation.database_id;
    }
  }
  return rels;
};

/**
 * Crea bloques para Create/Edit/Subtask con estas reglas:
 * - Create: todos los campos, pero SOLO Title es requerido. El resto es optional.
 * - Edit/Subtask: TODOS los campos optional.
 * - Orden de propiedades conforme a Notion (title primero).
 * - initialPage (opcional) para prefill en Edit.
 */
exports.buildCreateOrEditBlocks = ({ A, props, mode, initialPage = null }) => {
  const initial = initialPage ? convertPageToInitials(initialPage) : null;
  const requireTitle = mode === "create";
  const allOptional = mode !== "create";

  const blocks = [];

  for (const [name, prop] of orderPropertyEntries(props)) {
    if (!isEditable(prop)) continue;

    const isTitle = prop.type === "title";
    const optional = isTitle ? !requireTitle : allOptional;

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
          optional,
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
          optional,
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
          optional,
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
          optional,
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
          optional,
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
          optional,
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
          optional,
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
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No editable fields found._" } });
  }

  return blocks;
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

/** ---------- Parse del submit ---------- */
exports.parseSubmission = ({ values, props }) => {
  const out = {};

  for (const [name, prop] of Object.entries(props || {})) {
    if (!isEditable(prop)) continue;
    const key = `prop::${name}`;
    const slot = values?.[key]?.[key];
    if (!slot) continue; // si no se tocó, no enviamos nada

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

/** ---------- Util: convertir Page → initial values ---------- */
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


