exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
  if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderId" }) };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    // Get song data
    const songRes = await fetch(`${REDIS_URL}/get/song_${orderId}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const songData = await songRes.json();

    // Check if this order has been unlocked
    const unlockRes = await fetch(`${REDIS_URL}/get/unlocked_${orderId}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const unlockData = await unlockRes.json();
    const isUnlocked = !!unlockData.result;

    if (!songData.result) {
      return { statusCode: 200, body: JSON.stringify({ status: "pending", unlocked: isUnlocked }) };
    }

    const song = JSON.parse(songData.result);
    // Attach unlock status to song data
    song.unlocked = isUnlocked;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(song)
    };
  } catch(e) {
    return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
  }
};