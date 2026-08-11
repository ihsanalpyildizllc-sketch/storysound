exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key||"") !== (process.env.DASH_KEY||"ss-admin-2026")) return {statusCode:401,body:"no"};

  const STORE = process.env.SHOPIFY_STORE || "gut-1809.myshopify.com";
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
  const CLIENT_ID  = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SEC = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_ADMIN_TOKEN;

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

  // Test create one $10 gift card
  const r = await fetch(`${base}/gift_cards.json`,{
    method:"POST", headers:H,
    body: JSON.stringify({gift_card:{initial_value:"10.00",note:"Apology for delay — Stoory"}})
  });
  const d = await r.json();
  return {statusCode:200, body: JSON.stringify({status:r.status, result:d})};
};
