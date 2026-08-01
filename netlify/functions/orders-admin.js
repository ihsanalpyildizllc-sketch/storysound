// netlify/functions/orders-admin.js — data for the admin orders dashboard.
// Gate: ?key= must match DASH_KEY env (set one in Netlify!).
const { redis, getJSON } = require("./_shared");

exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key || "";
  const expected = process.env.DASH_KEY || "ss-admin-2026";
  if (key !== expected) return { statusCode: 401, body: JSON.stringify({ error: "bad key" }) };

  try {
    const idx = await redis([["LRANGE", "orders_index", "0", "199"], ["GET", "agent:last"]]);
    const ids = idx?.[0]?.result || [];
    let agent = null; try { agent = JSON.parse(idx?.[1]?.result || "null"); } catch (e) {}

    const rows = [];
    for (const orderId of ids) {
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
        paid: !!unlocked || m.source === "create",
        attempts: m.attempts || 1,
        sizeKb: s.audio_size_kb || null,
        emailStatus: m.email_status || (m.preview_email ? "preview:" + m.preview_email : "—"),
        emailedAt: m.emailed_at || m.preview_emailed_at || null,
        flagged: m.flagged || null
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
        agent
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
