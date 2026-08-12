// netlify/functions/get-audio.mjs — Functions 2.0 streaming version.
// Bypasses the 6MB buffered-response limit that 502'd longer songs.
// Supports Range requests so seeking works in the audio player.

export default async (req) => {
  const url = new URL(req.url);
  const orderId = url.searchParams.get("orderId");
  if (!orderId) return new Response("Missing orderId", { status: 400 });

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["GET", `song_${orderId}`]])
    });
    const results = await res.json();
    const songResult = results[0]?.result;
    if (!songResult) return new Response("Not found", { status: 404 });

    const song = JSON.parse(songResult);
    if (!song.audio_b64) return new Response("No audio", { status: 404 });

    const buf   = Buffer.from(song.audio_b64, "base64");
    const total = buf.length;

    const headers = {
      "Content-Type": song.audio_mime || "audio/mpeg",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes"
    };
    if (url.searchParams.get("dl") === "1") {
      const safe = String(song.song_title || "your-song")
        .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "your-song";
      headers["Content-Disposition"] = `attachment; filename="${safe}.mp3"`;
    }

    // Range support (seeking / partial fetch)
    const range = req.headers.get("range");
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end   = m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end) return new Response(null, {
          status: 416, headers: { "Content-Range": `bytes */${total}` }
        });
        const chunk = buf.subarray(start, end + 1);
        headers["Content-Range"]  = `bytes ${start}-${end}/${total}`;
        headers["Content-Length"] = String(chunk.length);
        return new Response(chunk, { status: 206, headers });
      }
    }

    headers["Content-Length"] = String(total);
    return new Response(buf, { status: 200, headers });
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500 });
  }
};
