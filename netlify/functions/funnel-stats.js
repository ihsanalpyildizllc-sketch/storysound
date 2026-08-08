// netlify/functions/funnel-stats.js — read-only funnel analytics.
const { redis } = require("./_shared");

const KEYS = [
  "c1_landing","c1_email","c1_bumps","c1_checkout_click","c1_purchase",
  "c2_landing","c2_email","c2_preview_landing","preview_ready","play_preview",
  "c2_skip_wait_click","begin_checkout","c2_purchase"
];

function hashToObj(arr) {
  const o = {};
  if (!Array.isArray(arr)) return o;
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
  return o;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026")) {
    return { statusCode: 403, body: "forbidden" };
  }

  const days = Math.min(Math.max(parseInt(q.days) || 7, 1), 30);
  const dayKeys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    dayKeys.push(d);
  }

  const cmds = [["HGETALL", "stats:all"], ["HGETALL", "timing:all"]]
    .concat(dayKeys.map(d => ["HGETALL", `stats:${d}`]));
  const res = await redis(cmds);

  const all = hashToObj(res[0]?.result);
  const timing = hashToObj(res[1]?.result);

  const byDay = {};
  dayKeys.forEach((d, i) => { byDay[d] = hashToObj(res[i + 2]?.result); });

  // window totals across the requested days
  const win = {};
  KEYS.forEach(k => {
    win[k] = dayKeys.reduce((sum, d) => sum + (byDay[d][k] || 0), 0);
  });

  // average seconds from landing → event
  const avg = {};
  Object.keys(timing).forEach(f => {
    if (!f.endsWith(":sum")) return;
    const ev = f.slice(0, -4);
    const c = timing[`${ev}:count`] || 0;
    if (c > 0) avg[ev] = Math.round(timing[f] / c);
  });

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      windowDays: days,
      lifetime: all,
      window: win,
      byDay,
      avgSecondsFromLanding: avg,
      funnels: {
        create: {
          landing: win.c1_landing,
          email: win.c1_email,
          bumps: win.c1_bumps,
          checkoutClick: win.c1_checkout_click,
          purchases: win.c1_purchase,
          emailRate: pct(win.c1_email, win.c1_landing),
          checkoutRate: pct(win.c1_checkout_click, win.c1_email),
          purchaseRate: pct(win.c1_purchase, win.c1_checkout_click),
          overall: pct(win.c1_purchase, win.c1_landing),
          bounced: Math.max(0, win.c1_landing - win.c1_email),
          bounceRate: pct(Math.max(0, win.c1_landing - win.c1_email), win.c1_landing)
        },
        create2: {
          landing: win.c2_landing,
          email: win.c2_email,
          previewLanding: win.c2_preview_landing,
          songShown: win.preview_ready,
          played: win.play_preview,
          skipWait: win.c2_skip_wait_click,
          checkoutClick: win.begin_checkout,
          purchases: win.c2_purchase,
          emailRate: pct(win.c2_email, win.c2_landing),
          waitedForSong: pct(win.preview_ready, win.c2_preview_landing),
          playRate: pct(win.play_preview, win.preview_ready),
          checkoutRate: pct(win.begin_checkout, win.c2_preview_landing),
          purchaseRate: pct(win.c2_purchase, win.begin_checkout),
          overall: pct(win.c2_purchase, win.c2_landing),
          bounced: Math.max(0, win.c2_landing - win.c2_email),
          bounceRate: pct(Math.max(0, win.c2_landing - win.c2_email), win.c2_landing),
          abandonedAtPreview: Math.max(0, win.c2_preview_landing - win.begin_checkout)
        }
      }
    })
  };
};
