const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
  if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderId" }) };

  try {
    // Auto-detect credentials from Netlify function context
    const store = getStore("songs");
    const result = await store.get(orderId, { type: "json" });
    if (!result) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    };
  } catch(e) {
    // Fallback: try with explicit env vars
    try {
      const store2 = getStore({
        name: "songs",
        siteID: process.env.NETLIFY_SITE_ID || "14e2b75e-7529-4781-a013-1965699a901e",
        token: process.env.NETLIFY_AUTH_TOKEN
      });
      const result = await store2.get(orderId, { type: "json" });
      if (!result) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
    } catch(e2) {
      return { statusCode: 500, body: JSON.stringify({ error: e2.message }) };
    }
  }
};