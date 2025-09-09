const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const API = "https://api.notion.com/v1";
const headers = {
  "Authorization": `Bearer ${process.env.NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

exports.searchDatabases = async (query = "") => {
  const r = await fetch(`${API}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      filter: { property: "object", value: "database" },
      sort: { direction: "descending", timestamp: "last_edited_time" }
    })
  });
  const j = await r.json();
  return (j.results || []).map(db => ({
    id: db.id,
    title: db.title?.[0]?.plain_text || db.id
  }));
};

exports.getDatabaseProperties = async (database_id) => {
  const r = await fetch(`${API}/databases/${database_id}`, { headers });
  const db = await r.json();
  return db.properties || {};
};

async function getDatabaseTitleKey(database_id) {
  const r = await fetch(`${API}/databases/${database_id}`, { headers });
  const db = await r.json();
  const props = db.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "title") return name; // ej: "Name", "Client Name", etc.
  }
  return "Name"; // fallback común
}
exports.getDatabaseTitleKey = getDatabaseTitleKey;

exports.searchPagesInDatabase = async (database_id, query = "") => {
  // Determina la propiedad de título real de la DB
  const titleKey = await getDatabaseTitleKey(database_id);

  const r = await fetch(`${API}/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" }
    })
  });
  const j = await r.json();

  const inDb = (j.results || []).filter(p => p.parent?.database_id === database_id);

  return inDb.map(p => {
    const tProp = p.properties?.[titleKey];
    const title =
      tProp?.type === "title" ? (tProp.title?.[0]?.plain_text || p.id) :
      p.properties?.Name?.title?.[0]?.plain_text ||
      p.properties?.name?.title?.[0]?.plain_text ||
      p.id;

    return { id: p.id, title, url: p.url };
  });
};

exports.createPage = async (database_id, properties) => {
  const r = await fetch(`${API}/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ parent: { database_id }, properties })
  });
  return r.json();
};

exports.updatePage = async (page_id, properties) => {
  const r = await fetch(`${API}/pages/${page_id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ properties })
  });
  return r.json();
};

exports.getPage = async (page_id) => {
  const r = await fetch(`${API}/pages/${page_id}`, { headers });
  return r.json();
};

