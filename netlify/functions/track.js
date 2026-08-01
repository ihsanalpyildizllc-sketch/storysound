// netlify/functions/track.js — funnel event sink for create2-preview beacons.
const { redis } = require("./_shared");
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "" };
  try {
    const b = JSON.parse(event.body || "{}");
    const rec = JSON.stringify({ e: String(b.event||"").slice(0,40), o: String(b.offer||"").slice(0,20),
      v: String(b.variant||"").slice(0,4), sku: b.sku, total: b.total, ts: Date.now() });
    await redis([["LPUSH","events_log",rec],["LTRIM","events_log","0","9999"],
      ["INCR",`ev:${String(b.event||"x").slice(0,40)}`]]);
  } catch (e) {}
  return { statusCode: 200, body: "" };
};
