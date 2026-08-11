// netlify/functions/create-discounts.js
// One-time function to create SAVE15 and SONG19 discount codes in Shopify
// GET ?key=ss-admin-2026

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026"))
    return { statusCode: 401, body: "no" };

  const store = process.env.SHOPIFY_STORE || "gut-1809.myshopify.com";
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: "SHOPIFY_ADMIN_TOKEN not set" }) };

  const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const base = `https://${store}/admin/api/2026-07`;
  const results = {};

  // SAVE15 — 15% off everything, no minimum, no expiry
  try {
    const r1 = await fetch(`${base}/price_rules.json`, {
      method: "POST", headers: H,
      body: JSON.stringify({ price_rule: {
        title: "SAVE15",
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        value_type: "percentage",
        value: "-15.0",
        customer_selection: "all",
        starts_at: new Date().toISOString(),
        usage_limit: null,
        once_per_customer: true
      }})
    });
    const d1 = await r1.json();
    if (d1.price_rule) {
      const rule_id = d1.price_rule.id;
      const r2 = await fetch(`${base}/price_rules/${rule_id}/discount_codes.json`, {
        method: "POST", headers: H,
        body: JSON.stringify({ discount_code: { code: "SAVE15" } })
      });
      const d2 = await r2.json();
      results.SAVE15 = d2.discount_code ? { id: d2.discount_code.id, code: "SAVE15", value: "-15%", status: "✅ created" }
                                        : { error: JSON.stringify(d2).slice(0, 100) };
    } else {
      results.SAVE15 = { error: JSON.stringify(d1).slice(0, 100) };
    }
  } catch(e) { results.SAVE15 = { error: e.message }; }

  // SONG19 — $20 off (brings $39 → $19), applied across all products
  try {
    const r3 = await fetch(`${base}/price_rules.json`, {
      method: "POST", headers: H,
      body: JSON.stringify({ price_rule: {
        title: "SONG19",
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        value_type: "fixed_amount",
        value: "-20.0",
        customer_selection: "all",
        starts_at: new Date().toISOString(),
        usage_limit: null,
        once_per_customer: true
      }})
    });
    const d3 = await r3.json();
    if (d3.price_rule) {
      const rule_id = d3.price_rule.id;
      const r4 = await fetch(`${base}/price_rules/${rule_id}/discount_codes.json`, {
        method: "POST", headers: H,
        body: JSON.stringify({ discount_code: { code: "SONG19" } })
      });
      const d4 = await r4.json();
      results.SONG19 = d4.discount_code ? { id: d4.discount_code.id, code: "SONG19", value: "-$20", status: "✅ created" }
                                        : { error: JSON.stringify(d4).slice(0, 100) };
    } else {
      results.SONG19 = { error: JSON.stringify(d3).slice(0, 100) };
    }
  } catch(e) { results.SONG19 = { error: e.message }; }

  return { statusCode: 200, body: JSON.stringify(results, null, 2) };
};
