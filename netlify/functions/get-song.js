exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
  if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderId" }) };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    // Use pipeline to get both song and unlock status in one call
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["GET", `song_${orderId}`],
        ["GET", `unlocked_${orderId}`]
      ])
    });
    const results = await res.json();

    // Pipeline returns array of results
    const songResult = results[0]?.result;
    const unlockResult = results[1]?.result;
    const isUnlocked = !!unlockResult;

    if (!songResult) {
      return { statusCode: 200, body: JSON.stringify({ status: "pending", unlocked: isUnlocked }) };
    }

    const song = JSON.parse(songResult);
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