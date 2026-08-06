// netlify/functions/debug-redis.js — temporary diagnostic
exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key || "";
  if (key !== (process.env.DASH_KEY || "ss-admin-2026")) return { statusCode: 403, body: "no" };

  const URL = process.env.UPSTASH_REDIS_REST_URL;
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const out = { url_set: !!URL, token_set: !!TOKEN };

  try {
    const r = await fetch(`${URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["SET", "debug_ping", String(Date.now())],
        ["GET", "debug_ping"],
        ["DBSIZE"],
        ["LPUSH", "debug_list", "x"],
        ["DEL", "debug_list"]
      ])
    });
    out.status = r.status;
    out.body = await r.text();
  } catch (e) { out.fetchError = e.message; }

  return { statusCode: 200, body: JSON.stringify(out) };
};
