// netlify/functions/reviews-data.js — public reviews for the funnel pages.
// Aggregate is computed over ALL submissions (every star), so the number stays honest
// even though only permissioned 4★+ testimonials are displayed individually.
const { redis } = require("./_shared");

exports.handler = async () => {
  try {
    const out = await redis([["LRANGE", "reviews_public", "0", "11"], ["LRANGE", "reviews_all", "0", "1999"]]);
    const pub = (out?.[0]?.result || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    const all = (out?.[1]?.result || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    const count = all.length;
    const avg = count ? Math.round(all.reduce((a, r) => a + r.stars, 0) / count * 10) / 10 : null;
    const dist = {};
    [5,4,3,2,1].forEach(n => { dist[n] = count ? Math.round(all.filter(r => r.stars === n).length / count * 100) : 0; });
    const ago = ts => { const d = Math.floor((Date.now() - ts) / 86400000);
      return d < 1 ? "today" : d === 1 ? "yesterday" : d < 7 ? d + " days ago" : d < 30 ? Math.floor(d/7) + (d < 14 ? " week ago" : " weeks ago") : Math.floor(d/30) + (d < 60 ? " month ago" : " months ago"); };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      body: JSON.stringify({
        count, avg, dist,
        reviews: pub.map(r => ({ stars: r.stars, text: r.text, name: r.name, ago: ago(r.ts) }))
      })
    };
  } catch (e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};
