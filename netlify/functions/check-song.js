const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };
  try {
    const store = getStore({ name: "songs", siteID: "14e2b75e-7529-4781-a013-1965699a901e", token: "nfp_PZx5LMDX1YTKVzqdxgZQvK87NABitKznbd21" });
    const result = await store.get(jobId, { type: "json" });
    if (!result) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};