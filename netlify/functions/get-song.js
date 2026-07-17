const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
  if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderId" }) };

  const NETLIFY_SITE_ID = "14e2b75e-7529-4781-a013-1965699a901e";
  const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || "nfp_PZx5LMDX1YTKVzqdxgZQvK87NABitKznbd21";

  try {
    const store = getStore({ name: "songs", siteID: NETLIFY_SITE_ID, token: NETLIFY_TOKEN });
    const result = await store.get(orderId, { type: "json" });
    if (!result) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};