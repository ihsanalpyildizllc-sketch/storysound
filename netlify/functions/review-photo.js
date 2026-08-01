// netlify/functions/review-photo.js — serves customer-submitted review photos from Blobs.
exports.handler = async (event) => {
  const id = (event.queryStringParameters || {}).id;
  if (!id || !/^[\w-]{1,80}$/.test(id)) return { statusCode: 400, body: "bad id" };
  try {
    const { getStore, connectLambda } = require("@netlify/blobs");
    connectLambda(event);
    const store = getStore("review-photos");
    const b64 = await store.get(id);
    if (!b64) return { statusCode: 404, body: "not found" };
    return { statusCode: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800" },
      body: b64, isBase64Encoded: true };
  } catch (e) { return { statusCode: 500, body: "photo error" }; }
};
