// netlify/functions/delivery-data.js — everything the /delivery page may see.
// Gated: only paid orders (create2 unlock) or pay-first /create orders get the file.
const { getJSON } = require("./_shared");

// Grief/memorial orders must never see upsells or review nags.
// Conservative on purpose: a false positive costs one upsell, a false negative
// pitches "make another song!" at someone who just lost a person.
const GRIEF = /\b(memorial|in memory|passed away|passing|rest in peace|rip\b|funeral|celebration of life|died|death|loss of|late (husband|wife|father|mother|son|daughter|brother|sister)|miss (you|him|her) so much|forever in our hearts|gone too soon|would have been|would be our|first anniversary without|since (he|she) (passed|left us))/i;

function isGrief(meta, song) {
  if (meta && meta.grief === true) return true;      // explicit manual flag wins
  if (meta && meta.grief === false) return false;    // explicit override off
  const hay = [
    meta && meta.occasion, meta && meta.rel,
    song && song.lyrics ? "" : "",              // never infer from generated lyrics
    meta && meta.qualities, meta && meta.memories, meta && meta.message, meta && meta.story
  ].filter(Boolean).join(" ");
  if (meta && /memorial|remembrance|in memory/i.test(String(meta.occasion || ""))) return true;
  return GRIEF.test(hay);
}

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

    const m = meta || {};
    // Download & Share is its own SKU on the /create funnel.
    // create2 buyers paid $119 for the full song -> download included.
    // Legacy /create buyers before the split are grandfathered.
    // download requires explicit purchase of variant 44339845791833
    // create2 buyers paid $119 for full unlock — download included
    const downloadBought = !!m.download || m.source === "create2";
    const lyricsBought = !!m.lyrics;
    const verse3Bought = !!m.verse3;
    const lines = String(song.lyrics || "").split("\n").map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l));

    const grief = isGrief(meta, song);

    return json(200, {
      ready: true,
      grief,                      // page hides upsells when true
      title: song.song_title || "Your Song",
      name: (meta && meta.name) || null,
      relationship: (meta && meta.rel) || null,
      audioUrl: `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}`,
      downloadUrl: downloadBought ? `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}&dl=1` : null,
      downloadBought,
      verse3Bought,
      source: m.source || "create",
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
