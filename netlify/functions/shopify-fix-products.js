// netlify/functions/shopify-fix-products.js — ops tool: diagnose + republish the song products.
// GET  ?key=DASH_KEY            → status report for the three products
// GET  ?key=DASH_KEY&fix=1      → set status:active + publish to Online Store, then report
const PRODUCTS = [
  { id: "8306994675801", name: "Custom Song (30 minutes)" },
  { id: "8306992152665", name: "Custom Song (48 hours)"  },
  { id: "8306994970713", name: "Lyrics" }
];

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026"))
    return j(401, { error: "bad key" });

  const store = process.env.SHOPIFY_STORE || "gut-1809.myshopify.com";
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) return j(500, { error: "SHOPIFY_ADMIN_TOKEN not set" });
  const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const base = `https://${store}/admin/api/2026-07`;

  const out = [];
  for (const p of PRODUCTS) {
    try {
      const r = await fetch(`${base}/products/${p.id}.json?fields=id,title,status,published_at,variants`, { headers: H });
      const d = await r.json();
      if (!d.product) { out.push({ ...p, error: d.errors || "not found" }); continue; }
      const prod = d.product;
      const rec = {
        name: p.name, id: p.id,
        status: prod.status,
        publishedToOnlineStore: !!prod.published_at,
        variants: (prod.variants || []).map(v => ({ id: String(v.id), price: v.price, inventory_policy: v.inventory_policy, available: v.inventory_quantity }))
      };
      if (q.fix === "1" && (prod.status !== "active" || !prod.published_at)) {
        const ur = await fetch(`${base}/products/${p.id}.json`, {
          method: "PUT", headers: H,
          body: JSON.stringify({ product: { id: Number(p.id), status: "active", published_at: new Date().toISOString(), published_scope: "global" } })
        });
        const ud = await ur.json();
        rec.fixed = ur.ok;
        rec.after = ud.product ? { status: ud.product.status, publishedToOnlineStore: !!ud.product.published_at } : ud.errors;
      }
      out.push(rec);
    } catch (e) { out.push({ ...p, error: e.message }); }
  }
  return j(200, { store, products: out });
};
function j(s, b) { return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b, null, 1) }; }
