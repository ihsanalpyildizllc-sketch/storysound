// netlify/functions/regen-from-shopify.js
// Admin tool: pull a Shopify order and re-generate the song.
// GET /?key=ss-admin-2026&shopify_id=7398123456789
exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  if (p.key !== "ss-admin-2026") return { statusCode: 403, body: "Forbidden" };

  const shopifyId = p.shopify_id;
  if (!shopifyId) return { statusCode: 400, body: "Missing shopify_id" };

  const STORE       = process.env.SHOPIFY_STORE || "gut-1809.myshopify.com";
  const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const SITE        = process.env.SITE_URL || "https://storysound.netlify.app";

  if (!ADMIN_TOKEN) return { statusCode: 500, body: "SHOPIFY_ADMIN_TOKEN not set" };

  // 1. Pull order from Shopify
  const res = await fetch(
    `https://${STORE}/admin/api/2026-07/orders/${shopifyId}.json?fields=id,name,email,note,note_attributes,line_items,customer,total_price`,
    { headers: { "X-Shopify-Access-Token": ADMIN_TOKEN } }
  );
  if (!res.ok) return { statusCode: 502, body: `Shopify error: ${res.status}` };
  const { order } = await res.json();

  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });
  const email = order.email || attrs["Customer Email"] || "";
  const name  = (attrs["Song For"] || "").split(" (")[0] || order.customer?.first_name || "";

  // 2. Create a new orderId and seed Redis
  const newOrderId = String(order.id);
  const lyricsBought = (order.line_items||[]).some(i => ["44263011287129","44258586886233"].includes(String(i.variant_id)));
  const meta = {
    source: "create", paid: true,
    email, name,
    country: order.billing_address?.country_code || null,
    items: (order.line_items||[]).map(i => i.title + " ($" + i.price + ")").join(", "),
    total: parseFloat(order.total_price || 0) || 39,
    lyrics: lyricsBought, created: Date.now(), attempts: 0, persisted: false
  };

  // Build payload for song generation
  const payload = {
    id: newOrderId,
    source: "create",
    email,
    note_attributes: Object.entries(attrs).map(([name, value]) => ({ name, value }))
  };

  await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["SET", `song_${newOrderId}`, JSON.stringify({ status: "processing", created: Date.now() }), "EX", "86400"],
      ["SET", `meta_${newOrderId}`, JSON.stringify(meta)],
      ["SET", `payload_${newOrderId}`, JSON.stringify(payload), "EX", "172800"],
      ["LPUSH", "orders_index", newOrderId],
      ["LTRIM", "orders_index", "0", "4999"]
    ])
  });

  // 3. Trigger background generation
  let bgStatus = "not triggered";
  try {
    const bg = await fetch(`${SITE}/.netlify/functions/generate-song-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    bgStatus = `triggered (${bg.status})`;
  } catch(e) { bgStatus = "trigger failed: " + e.message; }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      shopify_order: order.name,
      orderId: newOrderId,
      email,
      name,
      attrs,
      bgStatus,
      deliveryUrl: `${SITE}/delivery?o=${newOrderId}`,
      message: `Song generation started for ${name} (${email}). Check /delivery in ~3 minutes.`
    }, null, 2)
  };
};
