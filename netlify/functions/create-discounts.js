// netlify/functions/create-discounts.js — creates SAVE15 and SONG19 discount codes
// GET ?key=ss-admin-2026
const SHOPIFY_STORE = "gut-1809.myshopify.com";

async function getShopifyToken() {
  const CLIENT_ID  = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SEC = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_ADMIN_TOKEN;
  const REDIS_URL  = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOK  = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Try Redis cache
  if (REDIS_URL && REDIS_TOK) {
    const c = await fetch(`${REDIS_URL}/get/shopify_access_token`, { headers: { Authorization: `Bearer ${REDIS_TOK}` } });
    const cd = await c.json();
    if (cd.result) return cd.result;
  }

  // Refresh via client credentials
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SEC, grant_type: "client_credentials" })
  });
  const d = await r.json();
  const token = d.access_token;
  if (!token) throw new Error("No token: " + JSON.stringify(d).slice(0, 100));

  // Cache for 23h
  if (REDIS_URL && REDIS_TOK) {
    await fetch(`${REDIS_URL}/set/shopify_access_token/${encodeURIComponent(token)}/EX/82800`, {
      headers: { Authorization: `Bearer ${REDIS_TOK}` }
    });
  }
  return token;
}

async function createDiscount(H, base, title, valueType, value, label) {
  // Create price rule
  const r1 = await fetch(`${base}/price_rules.json`, {
    method: "POST", headers: H,
    body: JSON.stringify({ price_rule: {
      title, target_type: "line_item", target_selection: "all",
      allocation_method: "across", value_type: valueType, value: String(value),
      customer_selection: "all", starts_at: new Date().toISOString(),
      once_per_customer: true
    }})
  });
  const d1 = await r1.json();
  if (!d1.price_rule) return { error: JSON.stringify(d1).slice(0, 150) };

  // Create code on the rule
  const r2 = await fetch(`${base}/price_rules/${d1.price_rule.id}/discount_codes.json`, {
    method: "POST", headers: H,
    body: JSON.stringify({ discount_code: { code: title } })
  });
  const d2 = await r2.json();
  if (d2.discount_code) return { code: title, value: label, id: d2.discount_code.id, status: "✅ created" };
  return { error: JSON.stringify(d2).slice(0, 150) };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026"))
    return { statusCode: 401, body: "no" };

  try {
    const token = await getShopifyToken();
    const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
    const base = `https://${SHOPIFY_STORE}/admin/api/2026-07`;

    const [save15, song19] = await Promise.all([
      createDiscount(H, base, "SAVE15", "percentage",   "-15.0", "15% off"),
      createDiscount(H, base, "SONG19", "fixed_amount", "-20.0", "$20 off (→$19)"),
    ]);

    return { statusCode: 200, body: JSON.stringify({ SAVE15: save15, SONG19: song19 }, null, 2) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
