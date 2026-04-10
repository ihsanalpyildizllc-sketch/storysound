const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: "Missing jobId" }) };

  try {
    const store = getStore("songs");
    const result = await store.get(jobId, { type: "json" });
    if (!result) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};