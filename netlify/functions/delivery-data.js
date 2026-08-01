// netlify/functions/delivery-data.js — everything the /delivery page may see.
// Gated: only paid orders (create2 unlock) or pay-first /create orders get the file.
const { getJSON } = require("./_shared");

exports.handler = async (event) => {
  const orderId = (event.queryStringParameters || {}).o;
  if (!orderId) return json(400, { error: "missing order id" });

  try {
    const [song, meta, unlocked] = await Promise.all([
      getJSON(`song_${orderId}`),
      getJSON(`meta_${orderId}`),
      getJSON(`unlocked_${orderId}`)
    ]);
    if (!song) return json(404, { error: "not found" });

    const paid = !!unlocked || (meta && meta.source === "create");
    if (!paid) return json(403, { error: "not unlocked", redirect: `/create2-preview?o=${orderId}` });

    if (song.status !== "done" || !song.audio_b64) {
      return json(200, { ready: false, stage: song.stage || "processing", title: song.song_title || null });
    }

    const lyricsBought = !!(meta && meta.lyrics);
    const lines = String(song.lyrics || "").split("\n").map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l));

    return json(200, {
      ready: true,
      title: song.song_title || "Your Song",
      name: (meta && meta.name) || null,
      relationship: (meta && meta.rel) || null,
      audioUrl: `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}`,
      downloadUrl: `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}&dl=1`,
      lyricsBought,
      lyrics: lyricsBought ? lines : lines.slice(0, 3),
      lyricsTotal: lines.length,
      orderId
    });
  } catch (err) {
    console.error("delivery-data:", err);
    return json(500, { error: "lookup failed" });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
