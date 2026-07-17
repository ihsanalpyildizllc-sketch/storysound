exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const SITE_URL = process.env.SITE_URL || "https://storysound.netlify.app";

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "Missing order ID" };

  // Save pending status immediately
  await fetch(`${REDIS_URL}/set/song_${orderId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify({ status: "processing", created: Date.now() }), ex: 86400 })
  });

  // Fire background function (runs up to 15 minutes, no timeout issue)
  fetch(`${SITE_URL}/.netlify/functions/generate-song-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: event.body
  }).catch(e => console.log("BG trigger:", e.message));

  return { statusCode: 200, body: "OK" };
};
