exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
  if (!orderId) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderId" }) };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["GET", `song_${orderId}`],
        ["GET", `unlocked_${orderId}`]
      ])
    });
    const results = await res.json();

    const songResult = results[0]?.result;
    const unlockResult = results[1]?.result;
    const isUnlocked = !!unlockResult;

    if (!songResult) {
      return { statusCode: 200, body: JSON.stringify({ status: "pending", unlocked: isUnlocked }) };
    }

    const song = JSON.parse(songResult);

    // Strip large audio payload — serve audio via /get-audio endpoint instead
    const { audio_b64, audio_mime, ...songMeta } = song;
    const hasAudio = !!audio_b64;

    songMeta.unlocked = isUnlocked;
    if (hasAudio) {
      // Point the player to the dedicated audio endpoint
      songMeta.audio_url = `/.netlify/functions/get-audio?orderId=${orderId}`;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(songMeta)
    };
  } catch(e) {
    return { statusCode: 200, body: JSON.stringify({ status: "pending" }) };
  }
};
