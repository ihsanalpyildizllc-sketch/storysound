exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId;
  if (!orderId) return { statusCode: 400, body: 'Missing orderId' };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["GET", `song_${orderId}`]])
    });
    const results = await res.json();
    const songResult = results[0]?.result;
    if (!songResult) return { statusCode: 404, body: 'Not found' };

    const song = JSON.parse(songResult);
    if (!song.audio_b64) return { statusCode: 404, body: 'No audio' };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': song.audio_mime || 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      },
      body: song.audio_b64,
      isBase64Encoded: true
    };
  } catch(e) {
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
