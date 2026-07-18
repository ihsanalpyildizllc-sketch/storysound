exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const SITE_URL = process.env.SITE_URL || "https://storysound.netlify.app";
  const UNLOCK_VARIANT = "43257750978637";

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "Missing order ID" };

  // Parse order attributes
  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  // --- DETECT UNLOCK ORDER ($49 lyrics + download) ---
  const lineItems = order.line_items || [];
  const isUnlockOrder = lineItems.some(item => String(item.variant_id) === UNLOCK_VARIANT);

  if (isUnlockOrder) {
    const origOrderId = attrs["Original_Order"] || "";
    if (origOrderId && REDIS_URL && REDIS_TOKEN) {
      // Store unlock flag — success page polls get-song which checks this
      const val = encodeURIComponent(JSON.stringify({ unlocked: true, unlockOrderId: orderId, ts: Date.now() }));
      await fetch(`${REDIS_URL}/setex/unlocked_${origOrderId}/2592000/${val}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      console.log("Unlock stored for original order:", origOrderId);
    }
    return { statusCode: 200, body: "Unlock processed" };
  }

  // --- REGULAR SONG ORDER ---
  // Save pending to Upstash
  await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", `song_${orderId}`, JSON.stringify({ status: "processing", created: Date.now() }), "EX", "86400"]])
  });

  // Trigger background function (15min timeout)
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