exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key||"") !== (process.env.DASH_KEY||"ss-admin-2026")) return {statusCode:401,body:"no"};
  const STORE = process.env.SHOPIFY_STORE || "gut-1809.myshopify.com";
  const CLIENT_ID  = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SEC = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_ADMIN_TOKEN;
  const REDIS_URL  = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOK  = process.env.UPSTASH_REDIS_REST_TOKEN;
  let token = null;
  if (REDIS_URL && REDIS_TOK) {
    const c = await fetch(`${REDIS_URL}/get/shopify_access_token`,{headers:{Authorization:`Bearer ${REDIS_TOK}`}});
    const cd = await c.json(); if(cd.result) token = cd.result;
  }
  if (!token) {
    const r = await fetch(`https://${STORE}/admin/oauth/access_token`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({client_id:CLIENT_ID,client_secret:CLIENT_SEC,grant_type:"client_credentials"})});
    token = (await r.json()).access_token;
  }
  const H = {"X-Shopify-Access-Token":token,"Content-Type":"application/json"};
  const base = `https://${STORE}/admin/api/2026-07`;
  const r = await fetch(`${base}/orders.json?status=any&limit=50&fields=id,order_number,email,total_price,customer,note_attributes,line_items`,{headers:H});
  const d = await r.json();
  const orders = (d.orders||[]).map(o => ({
    shopify_id: String(o.id),
    order_num: o.order_number,
    email: o.email,
    total: o.total_price,
    customer: o.customer ? `${o.customer.first_name||''} ${o.customer.last_name||''}`.trim() : '',
    items: (o.line_items||[]).map(li => ({ title: li.title, price: li.price, qty: li.quantity })),
    attrs: Object.fromEntries((o.note_attributes||[]).map(a=>[a.name,a.value]))
  }));
  return {statusCode:200, headers:{"Content-Type":"application/json"}, body: JSON.stringify(orders)};
};
