exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const SITE_URL = process.env.SITE_URL || "https://storysound.netlify.app";

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "Missing order ID" };

  // Save pending to Upstash
  const pendingValue = encodeURIComponent(JSON.stringify({ status: "processing", created: Date.now() }));
  await fetch(`${REDIS_URL}/setex/song_${orderId}/86400/${pendingValue}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });

  // AWAIT the background function — it returns 202 immediately, runs for up to 15 mins
  try {
    await fetch(`${SITE_URL}/.netlify/functions/generate-song-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event.body
    });
  } catch(e) {
    console.log("BG trigger error:", e.message);
  }

  return { statusCode: 200, body: "OK" };
};
