// netlify/functions/delivery-data.js
// Gated: create orders need meta.paid===true; create2 orders need unlocked_ key.
const { getJSON } = require("./_shared");

const SHOPIFY_STORE   = "gut-1809.myshopify.com";
const VARIANTS        = { base:"44258532819033", b1:"44258586886233", b2:"44258587476057", b3:"44263011287129" };

exports.handler = async (event) => {
  const orderId = (event.queryStringParameters || {}).o;
  if (!orderId) return json(400, { error: "missing order id" });

  try {
    const [song, meta, unlocked] = await Promise.all([
      getJSON(`song_${orderId}`),
      getJSON(`meta_${orderId}`),
      getJSON(`unlocked_${orderId}`)
    ]);
    if (!song && !meta) return json(404, { error: "not found" });

    // ── paid check ────────────────────────────────────────────────────────────
    const isCreate  = meta && meta.source === "create";
    const isCreate2 = !isCreate;
    const paid = !!unlocked || (isCreate && meta.paid === true);

    // ── NOT PAID: paywall response ────────────────────────────────────────────
    if (!paid) {
      if (isCreate2) {
        // create2 without unlock → send back to preview
        return json(403, { error: "not unlocked", redirect: `/create2-preview?o=${orderId}` });
      }

      // create order — build Shopify unlock URL
      const bk   = (meta && meta.bumps) || {};
      let variants = `${VARIANTS.base}:1`;
      if (bk.b1) variants += `,${VARIANTS.b1}:1`;
      if (bk.b2) variants += `,${VARIANTS.b2}:1`;
      if (bk.b3) variants += `,${VARIANTS.b3}:1`;
      const email = encodeURIComponent((meta && meta.email) || "");
      const shopifyUrl =
        `https://${SHOPIFY_STORE}/cart/${variants}` +
        `?attributes[Job_ID]=${encodeURIComponent(orderId)}` +
        `&attributes[Customer_Email]=${email}` +
        `&checkout[email]=${email}&return_to=/checkout`;

      // still generating?
      if (!song || song.status !== "done" || !song.audio_b64) {
        return json(200, {
          ready: false, paywall: true,
          stage: (song && song.stage) || "processing",
          shopifyUrl, orderId
        });
      }

      // song ready — show paywall with full audio (listen free, pay to download)
      const lines = String(song.lyrics || "")
        .split("\n").map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l));
      return json(200, {
        ready: true, paywall: true,
        title: song.song_title || "Your Song",
        audioUrl: `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}`,
        lyricsTeaser: lines.slice(0, 3),
        lyricsTotal: lines.length,
        shopifyUrl, orderId
      });
    }

    // ── PAID: full delivery ───────────────────────────────────────────────────
    if (!song || song.status !== "done" || !song.audio_b64) {
      return json(200, { ready: false, stage: (song && song.stage) || "processing", title: (song && song.song_title) || null });
    }

    const lyricsBought = !!(meta && meta.lyrics) || !!(unlocked && unlocked.lyrics);
    const lines = String(song.lyrics || "")
      .split("\n").map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l));

    return json(200, {
      ready: true,
      title: song.song_title || "Your Song",
      name: (meta && meta.name) || null,
      relationship: (meta && meta.rel) || null,
      audioUrl:    `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}`,
      downloadUrl: `/.netlify/functions/get-audio?orderId=${encodeURIComponent(orderId)}&dl=1`,
      lyricsBought,
      lyrics:      lyricsBought ? lines : lines.slice(0, 3),
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
