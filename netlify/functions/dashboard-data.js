// netlify/functions/dashboard-data.js — money + credits view, unified with orders_index.
// Gated: ?key= must match DASH_KEY.
const { redis, getJSON } = require("./_shared");

exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key || "";
  if (key !== (process.env.DASH_KEY || "ss-admin-2026"))
    return { statusCode: 401, headers: h(), body: JSON.stringify({ error: "bad key" }) };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const [apiframeRes, base] = await Promise.all([
      fetch("https://api.apiframe.ai/v2/me", { headers: { "X-API-Key": process.env.APIFRAME_API_KEY } })
        .then(r => r.json()).catch(() => null),
      redis([
        ["GET", "dash:songs:total"], ["GET", `dash:songs:date:${today}`],
        ["GET", "dash:revenue:total"], ["GET", `dash:revenue:date:${today}`],
        ["LRANGE", "orders_index", "0", "19"], ["GET", "agent:last"],
        ["GET", "ev:view_offer"], ["GET", "ev:play_preview"], ["GET", "ev:begin_checkout"],
        ["LRANGE", "reviews_all", "0", "499"]
      ])
    ]);

    const g = i => base?.[i]?.result;
    const totalSongs = +(g(0) || 0), todaySongs = +(g(1) || 0);
    const totalRev = +(g(2) || 0), todayRev = +(g(3) || 0);
    const ids = [...new Set(g(4) || [])].slice(0, 10);
    let agent = null; try { agent = JSON.parse(g(5) || "null"); } catch (e) {}
    const funnel = { views: +(g(6) || 0), plays: +(g(7) || 0), checkouts: +(g(8) || 0) };
    const reviewsAll = (g(9) || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);

    // recent songs straight from the single source of truth
    const recent = [];
    for (const id of ids) {
      const [song, meta, unlocked] = await Promise.all([
        getJSON(`song_${id}`), getJSON(`meta_${id}`), getJSON(`unlocked_${id}`)
      ]);
      const m = meta || {}, s = song || {};
      recent.push({
        id, title: s.song_title || "…", songFor: m.name || null, genre: m.genre || null,
        source: m.source || "?", status: s.status || "unknown",
        paid: !!unlocked || m.source === "create",
        revenue: (unlocked && unlocked.total) ? +unlocked.total : (m.total || 0),
        revision: !!m.revision_open,
        ts: s.created || m.created || null,
        listen: s.status === "done" ? `/.netlify/functions/get-audio?orderId=${encodeURIComponent(id)}` : null,
        delivery: `/delivery?o=${encodeURIComponent(id)}`
      });
    }

    // Apiframe has moved this field around; try every known shape
    const A = apiframeRes || {};
    const credits = A?.team?.credits ?? A?.data?.credits ?? A?.user?.credits ?? A?.credits ?? A?.data?.team?.credits ?? 0;
    const cost = Math.round(totalSongs * 0.08 * 100) / 100;
    return {
      statusCode: 200, headers: h(),
      body: JSON.stringify({
        apiframe: { credits, plan: A?.team?.plan || A?.data?.plan || A?.plan || "unknown", songsLeft: Math.floor(credits / 11),
          health: credits > 500 ? "healthy" : credits > 100 ? "warning" : "critical" },
        revenue: { total: totalRev, today: todayRev },
        songs: { total: totalSongs, today: todaySongs },
        cost: { total: cost, perSong: 0.08, profit: Math.round((totalRev - cost) * 100) / 100 },
        funnel, agent,
        reviews: { count: reviewsAll.length,
          avg: reviewsAll.length ? Math.round(reviewsAll.reduce((a, r) => a + r.stars, 0) / reviewsAll.length * 10) / 10 : null },
        recentOrders: recent
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: h(), body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
function h(){ return { "Content-Type": "application/json", "Cache-Control": "no-store" }; }
