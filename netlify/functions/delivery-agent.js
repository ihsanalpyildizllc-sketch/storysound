// netlify/functions/delivery-agent.js — scheduled watchdog. Runs every 10 minutes.
// Deterministic by design: retries stuck generations, blocks empty files,
// sends any unsent emails, and keeps per-order state honest.
const { redis, getJSON, mergeMeta, persistSong, sendEmail, deliveryEmail, previewEmail } = require("./_shared");

const MAX_ATTEMPTS = 3;
const STUCK_AFTER_MS = 20 * 60 * 1000;
const MIN_SIZE_KB = 500;                      // a real full song is ~3MB; below this = broken file
const SITE = process.env.SITE_URL || "https://storysound.netlify.app";

exports.handler = async () => {
  const out = { checked: 0, retried: 0, emailedDelivery: 0, emailedPreview: 0, flagged: 0, errors: [] };
  try {
    const idx = await redis([["LRANGE", "orders_index", "0", "299"]]);
    const ids = [...new Set(idx?.[0]?.result || [])];

    for (const orderId of ids) {
      out.checked++;
      try {
        const [song, meta] = await Promise.all([getJSON(`song_${orderId}`), getJSON(`meta_${orderId}`)]);
        // orphan: order registered but generation never started (e.g. trigger lost)
        if (!song) {
          const m0 = meta || {};
          const attempts0 = m0.attempts || 0;
          if ((m0.created || 0) && Date.now() - m0.created > 5 * 60 * 1000 && attempts0 < MAX_ATTEMPTS) {
            const payload = await getJSON(`payload_${orderId}`);
            if (payload) {
              await mergeMeta(orderId, { attempts: attempts0 + 1, last_retry: Date.now() });
              fetch(`${SITE}/.netlify/functions/generate-song-background`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
              }).catch(() => {});
              out.retried++;
            }
          }
          continue;
        }
        const m = meta || {};
        const attempts = m.attempts || 1;

        // 1 ── stuck in processing → retry with the original payload
        const started = song.created || m.created || 0;
        if (song.status === "processing" && started && Date.now() - started > STUCK_AFTER_MS) {
          if (attempts < MAX_ATTEMPTS) {
            const payload = await getJSON(`payload_${orderId}`);
            if (payload) {
              await mergeMeta(orderId, { attempts: attempts + 1, last_retry: Date.now() });
              fetch(`${SITE}/.netlify/functions/generate-song-background`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
              }).catch(() => {});
              out.retried++;
            }
          } else if (!m.flagged) {
            await mergeMeta(orderId, { flagged: "max_attempts" });
            out.flagged++;
          }
          continue;
        }

        // 2 ── done but file is too small to be real → force error + retry path
        if (song.status === "done" && (song.audio_size_kb || 0) < MIN_SIZE_KB) {
          await redis([["SET", `song_${orderId}`, JSON.stringify(Object.assign(song, { status: "error", error: "file too small (" + song.audio_size_kb + "KB)" }))]]);
          await mergeMeta(orderId, { flagged: "empty_file" });
          out.flagged++;
          continue;
        }

        // 3 ── error state with attempts left → retry
        if (song.status === "error" && attempts < MAX_ATTEMPTS) {
          const payload = await getJSON(`payload_${orderId}`);
          if (payload) {
            await mergeMeta(orderId, { attempts: attempts + 1, last_retry: Date.now() });
            fetch(`${SITE}/.netlify/functions/generate-song-background`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
            }).catch(() => {});
            out.retried++;
          }
          continue;
        }

        if (song.status !== "done") continue;

        // 4 ── done: make sure it's permanent, then make sure emails went out
        const unlocked = await getJSON(`unlocked_${orderId}`);
        const isPaid = !!unlocked || m.source === "create";

        if (isPaid && !m.persisted) {
          await persistSong(orderId, null);
          await mergeMeta(orderId, { persisted: true });
        }

        if (isPaid && m.email && m.email_status !== "sent") {
          const e = deliveryEmail({ title: song.song_title || "Your Song", orderId, siteUrl: SITE });
          const r = await sendEmail({ to: m.email, subject: e.subject, html: e.html, text: e.text });
          await mergeMeta(orderId, { email_status: r.ok ? "sent" : "failed", emailed_at: Date.now(), email_id: r.id || null, email_err: r.ok ? null : r.reason });
          if (r.ok) out.emailedDelivery++;
        }

        if (!isPaid && m.source === "create2" && m.email && m.preview_email !== "sent") {
          const e = previewEmail({ title: song.song_title, orderId, siteUrl: SITE, name: m.name });
          const r = await sendEmail({ to: m.email, subject: e.subject, html: e.html, text: e.text });
          await mergeMeta(orderId, { preview_email: r.ok ? "sent" : "failed", preview_emailed_at: Date.now() });
          if (r.ok) out.emailedPreview++;
        }
      } catch (inner) { out.errors.push(orderId + ": " + inner.message); }
    }

    await redis([["SET", "agent:last", JSON.stringify(Object.assign({ ts: Date.now() }, out))]]);
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, body: String(err.message || err) };
  }
};
