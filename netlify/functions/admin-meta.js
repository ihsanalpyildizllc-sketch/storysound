// netlify/functions/admin-meta.js — patch an order's meta (grief flag, email, etc.)
// GET  ?key=DASH_KEY&o=<orderId>                 → read meta
// POST ?key=DASH_KEY  {o, patch:{...}}           → merge patch into meta
const { getJSON, mergeMeta } = require("./_shared");

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026")) return j(401, { error: "bad key" });

  if (event.httpMethod === "GET") {
    if (!q.o) return j(400, { error: "missing o" });
    return j(200, { meta: await getJSON(`meta_${q.o}`) });
  }
  if (event.httpMethod === "POST") {
    let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return j(400, { error: "bad json" }); }
    if (!b.o || !b.patch) return j(400, { error: "need o and patch" });
    const next = await mergeMeta(b.o, b.patch);
    return j(200, { ok: true, meta: next });
  }
  return j(405, { error: "GET or POST" });
};
function j(s, b) { return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b, null, 1) }; }
