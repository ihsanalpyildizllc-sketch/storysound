// netlify/functions/shopify-order-lookup.js
// Looks up a Shopify order by ID or by customer email, returning line items and attributes.
// Used internally so we can verify what a customer actually bought before patching meta.
// GET ?key=DASH_KEY&id=<shopify_order_id>         → single order
// GET ?key=DASH_KEY&email=<email>                 → most recent 5 orders for that email
// GET ?key=DASH_KEY&name=<name>                   → search by customer name

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026"))
    return j(401, { error: "bad key" });

  const store = process.env.SHOPIFY_STORE || "gut-1809.myshopify.com";
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return j(500, { error: "SHOPIFY_ADMIN_TOKEN not set in Netlify env" });

  const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const base = `https://${store}/admin/api/2026-07`;

  try {
    let orders = [];

    if (q.id) {
      const r = await fetch(`${base}/orders/${q.id}.json`, { headers: H });
      const d = await r.json();
      if (d.order) orders = [d.order];
      else return j(404, { error: "order not found", detail: d.errors || d });
    } else if (q.email) {
      const r = await fetch(`${base}/orders.json?email=${encodeURIComponent(q.email)}&limit=5&status=any`, { headers: H });
      const d = await r.json();
      orders = d.orders || [];
    } else if (q.name) {
      const r = await fetch(`${base}/customers/search.json?query=${encodeURIComponent(q.name)}&limit=3`, { headers: H });
      const d = await r.json();
      const customers = d.customers || [];
      for (const c of customers.slice(0, 2)) {
        const or = await fetch(`${base}/orders.json?customer_id=${c.id}&limit=5&status=any`, { headers: H });
        const od = await or.json();
        orders.push(...(od.orders || []));
      }
    } else {
      return j(400, { error: "pass id=, email=, or name=" });
    }

    const out = orders.map(o => ({
      id: o.id,
      name: o.name,
      created_at: o.created_at,
      total: o.total_price,
      financial_status: o.financial_status,
      customer: o.customer ? `${o.customer.first_name} ${o.customer.last_name}`.trim() : "?",
      email: o.email,
      line_items: (o.line_items || []).map(i => ({
        title: i.title,
        variant_id: String(i.variant_id),
        price: i.price,
        quantity: i.quantity
      })),
      note_attributes: Object.fromEntries((o.note_attributes || []).map(a => [a.name, a.value])),
      // what our system cares about
      original_order: (o.note_attributes || []).find(a => a.name === "Original_Order")?.value || null,
      bought: {
        song: (o.line_items || []).some(i => ["44263008763993","44263007518809","44258532819033"].includes(String(i.variant_id))),
        lyrics: (o.line_items || []).some(i => ["44263011287129","44258586886233"].includes(String(i.variant_id))),
        download: (o.line_items || []).some(i => String(i.variant_id) === "44339845791833"),
        verse3: (o.line_items || []).some(i => String(i.variant_id) === "44263046381657")
      }
    }));

    return j(200, { store, count: out.length, orders: out });
  } catch (err) {
    return j(500, { error: String(err.message || err) });
  }
};

function j(s, b) {
  return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b, null, 1) };
}
