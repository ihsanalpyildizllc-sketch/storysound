// netlify/functions/orders-admin.js — data for the admin orders dashboard.
// Gate: ?key= must match DASH_KEY env (set one in Netlify!).
const { redis, getJSON } = require("./_shared");

exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key || "";
  const expected = process.env.DASH_KEY || "ss-admin-2026";
  if (key !== expected) return { statusCode: 401, body: JSON.stringify({ error: "bad key" }) };

  try {
    const idx = await redis([["LRANGE", "orders_index", "0", "199"], ["GET", "agent:last"],
      ["GET","ev:view_offer"],["GET","ev:play_preview"],["GET","ev:begin_checkout"],
      ["GET","ev:lyrics_upsell_click"],["GET","ev:video_upsell_click"],["GET","ev:another_song_upsell_click"]]);
    const ids = idx?.[0]?.result || [];
    let agent = null; try { agent = JSON.parse(idx?.[1]?.result || "null"); } catch (e) {}
    const funnel = { views:+(idx?.[2]?.result||0), plays:+(idx?.[3]?.result||0), checkouts:+(idx?.[4]?.result||0),
      lyricsClicks:+(idx?.[5]?.result||0), videoClicks:+(idx?.[6]?.result||0), anotherSongClicks:+(idx?.[7]?.result||0) };

    const rows = [];
    const seen = new Set();
    for (const orderId of ids) {
      if (seen.has(orderId)) continue;
      seen.add(orderId);
      const [song, meta, unlocked] = await Promise.all([
        getJSON(`song_${orderId}`), getJSON(`meta_${orderId}`), getJSON(`unlocked_${orderId}`)
      ]);
      const m = meta || {}; const s = song || {};
      rows.push({
        orderId,
        created: s.created || m.created || null,
        title: s.song_title || null,
        status: s.status || "unknown",
        stage: s.stage || null,
        source: m.source || "?",
        name: m.name || null,
        email: m.email || null,
        country: m.country || null,
        lyrics: !!m.lyrics,
        items: m.items || null,
        total: (unlocked && unlocked.total) ? Number(unlocked.total) : (m.total ? Number(m.total) : (m.source === "create" ? 39 : 0)),
        paid: m.kind === "lead" ? false : (!!unlocked || m.source === "create"),
        isLead: m.kind === "lead",
        attempts: m.attempts || 1,
        sizeKb: s.audio_size_kb || null,
        emailStatus: m.email_status || (m.preview_email ? "preview:" + m.preview_email : "—"),
        emailErr: m.email_err || null,
        emailedAt: m.emailed_at || m.preview_emailed_at || null,
        flagged: m.flagged || null,
        revision: !!m.revision_open, revisions: (m.revisions||[]).length, revisionNotes: (m.revisions||[]).map(function(r){ return {feedback: r.feedback||r.text||"", keep: r.keep||"", ts: r.ts||0}; })
      });
    }

    const paidRows = rows.filter(r => r.paid && r.total > 0);
    const revenue = paidRows.reduce((a, r) => a + r.total, 0);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        rows,
        summary: {
          orders: rows.length, paid: paidRows.length, revenue: Math.round(revenue * 100) / 100,
          aov: paidRows.length ? Math.round(revenue / paidRows.length * 100) / 100 : 0,
          lyricsAttach: rows.length ? Math.round(rows.filter(r => r.lyrics).length / rows.length * 100) : 0
        },
        agent, funnel
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
