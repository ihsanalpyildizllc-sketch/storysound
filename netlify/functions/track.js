// netlify/functions/track.js — funnel event sink.
// Backwards compatible with the original payload ({event, offer, variant, sku, total}).
// Adds: per-day counters, lifetime counters, and landing→checkout timing aggregates.
const { redis } = require("./_shared");

function day() {
  return new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "" };
  try {
    const b = JSON.parse(event.body || "{}");
    const ev = String(b.event || "").slice(0, 40);
    if (!ev) return { statusCode: 200, body: "" };

    const d = day();
    const cmds = [
      // rolling raw log (capped, for debugging only)
      ["LPUSH", "events_log", JSON.stringify({
        e: ev, o: String(b.offer || "").slice(0, 20), v: String(b.variant || "").slice(0, 4),
        sku: b.sku, total: b.total, ts: Date.now()
      })],
      ["LTRIM", "events_log", "0", "4999"],
      // lifetime counter (original behaviour — kept so nothing reading ev:* breaks)
      ["INCR", `ev:${ev}`],
      // per-day + lifetime hashes for the funnel dashboard
      ["HINCRBY", `stats:${d}`, ev, "1"],
      ["HINCRBY", "stats:all", ev, "1"],
      // keep daily buckets for 90 days
      ["EXPIRE", `stats:${d}`, "7776000"]
    ];

    // Timing: milliseconds from first landing to this event (sent by the pages)
    const el = Number(b.elapsed);
    if (Number.isFinite(el) && el > 0 && el < 6 * 60 * 60 * 1000) {
      const secs = Math.round(el / 1000);
      cmds.push(["HINCRBY", "timing:all", `${ev}:sum`, String(secs)]);
      cmds.push(["HINCRBY", "timing:all", `${ev}:count`, "1"]);
    }

    await redis(cmds);
  } catch (e) { /* tracking must never break a page */ }
  return { statusCode: 200, body: "" };
};
