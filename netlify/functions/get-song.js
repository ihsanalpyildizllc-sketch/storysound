exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
  if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderId" }) };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const res = await fetch(`${REDIS_URL}/get/song_${orderId}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
    const song = JSON.parse(data.result);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(song) };
  } catch(e) {
    return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
  }
};
