// netlify/functions/preview-song.js
//
// The ONLY song data /create2-preview is allowed to see.
// Returns a 20s clip URL + 3 teaser lyric lines. Never the full audio, never
// the full lyrics — anything sent to the browser is readable regardless of blur.
//
// GET /.netlify/functions/preview-song?o=<orderId>

const CLIP_SECONDS = 20;

function teaser(lyrics, name) {
  if (!lyrics) return { lines: [], total: 0 };
  const lines = String(lyrics)
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !/^\[.*\]$/.test(l));          // drop [Verse 1] / [Chorus] markers
  if (!lines.length) return { lines: [], total: 0 };

  // lead with a line containing their name — that's the proof of personalisation
  let start = 0;
  if (name) {
    const safe = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hit = lines.findIndex(l => new RegExp("\\b" + safe + "\\b", "i").test(l));
    if (hit > -1) start = Math.max(0, Math.min(hit, lines.length - 3));
  }
  return { lines: lines.slice(start, start + 3), total: lines.length };
}

exports.handler = async (event) => {
  const orderId = (event.queryStringParameters || {}).o
              || (event.queryStringParameters || {}).orderId;
  if (!orderId) return json(400, { error: "missing order id" });

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
    const out = await res.json();
    const raw = out[0]?.result;
    const paid = !!out[1]?.result;

    if (!raw) return json(200, { ready: false, stage: "queued" });

    const song = JSON.parse(raw);

    if (song.status === "error") return json(200, { ready: false, failed: true });

    const created = song.created || null;   // anchors the queue-hold countdown

    if (song.status !== "done" || !song.audio_b64) {
      return json(200, {
        ready: false,
        created,
        stage: song.stage || "processing",
        name: song.recipient_name || null,
        title: song.song_title || null
      });
    }

    const t = teaser(song.lyrics, song.recipient_name);
    return json(200, {
      ready: true,
      paid,
      created,
      title: song.song_title || null,
      name: song.recipient_name || null,
      relationship: song.relationship || null,
      genre: song.genre || null,
      previewUrl: `/.netlify/functions/preview-audio?o=${encodeURIComponent(orderId)}`,
      previewSeconds: CLIP_SECONDS,
      lyricsTeaser: t.lines,     // 3 lines only
      lyricsTotal: t.total        // a count, never the remaining text
    });
  } catch (err) {
    console.error("preview-song:", err);
    return json(200, { ready: false, stage: "processing" });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}
