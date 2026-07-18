exports.handler = async (event) => {
  const orderId = event.queryStringParameters?.orderId || event.queryStringParameters?.order_id;
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
    if (!songResult) {
      return { statusCode: 200, headers: {"Content-Type":"text/html"}, body: `<html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Song not ready yet</h2><p>Please wait a moment and refresh.</p></body></html>` };
    }

    const song = JSON.parse(songResult);
    const audioUrl = `/.netlify/functions/get-audio?orderId=${orderId}`;
    const lyricsEscaped = (song.lyrics || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const titleEscaped = (song.song_title || 'Your Song').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const metaEscaped = (song.song_meta || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleEscaped}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1A0A04; color: #fff; font-family: 'Georgia', serif; min-height: 100vh; }
  .wrap { max-width: 500px; margin: 0 auto; padding: 40px 24px 60px; }
  .badge { display: inline-block; background: rgba(255,255,255,0.1); border-radius: 100px; padding: 5px 14px; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 20px; font-family: sans-serif; }
  h1 { font-size: clamp(26px, 6vw, 40px); font-weight: 700; margin-bottom: 8px; line-height: 1.2; }
  .meta { color: rgba(255,255,255,0.5); font-size: 14px; margin-bottom: 30px; font-family: sans-serif; }
  .player { background: rgba(255,255,255,0.07); border-radius: 16px; padding: 20px; margin-bottom: 24px; }
  audio { width: 100%; height: 44px; border-radius: 8px; outline: none; }
  .dl-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; background: #B5471C; color: #fff; border: none; border-radius: 14px; padding: 16px; font-size: 16px; font-weight: 700; cursor: pointer; text-decoration: none; font-family: sans-serif; margin-bottom: 24px; }
  .dl-btn:hover { background: #8f3714; }
  .lyrics-box { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 20px; }
  .lyrics-title { font-size: 13px; font-family: sans-serif; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255,255,255,0.4); margin-bottom: 14px; }
  .lyrics { font-size: 16px; line-height: 2; white-space: pre-wrap; font-style: italic; color: rgba(255,255,255,0.85); }
</style>
</head>
<body>
<div class="wrap">
  <div class="badge">🎵 Your Song is Ready</div>
  <h1>"${titleEscaped}"</h1>
  <div class="meta">${metaEscaped}</div>

  <div class="player">
    <audio controls autoplay src="${audioUrl}">
      Your browser does not support audio.
    </audio>
  </div>

  <a class="dl-btn" href="${audioUrl}" download="${titleEscaped}.mp3">
    ⬇ Download MP3
  </a>

  <div class="lyrics-box">
    <div class="lyrics-title">Lyrics</div>
    <div class="lyrics">${lyricsEscaped}</div>
  </div>
</div>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html
    };
  } catch(e) {
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
