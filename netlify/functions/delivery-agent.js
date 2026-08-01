// netlify/functions/delivery-agent.js — scheduled watchdog. Runs every 10 minutes.
// Deterministic by design: retries stuck generations, blocks empty files,
// sends any unsent emails, and keeps per-order state honest.
const { redis, getJSON, mergeMeta, persistSong, sendEmail, deliveryEmail, previewEmail } = require("./_shared");

const MAX_ATTEMPTS = 3;
const STUCK_AFTER_MS = 20 * 60 * 1000;
// abandonment ladder (create2 only): hours after the preview email
const AB_STEPS = [
  { key: "ab1", afterMs: 1  * 60 * 60 * 1000 },
  { key: "ab2", afterMs: 24 * 60 * 60 * 1000 },
  { key: "ab3", afterMs: 6  * 24 * 60 * 60 * 1000 }
];
const BROADCAST = process.env.POSTMARK_BROADCAST_STREAM || "broadcast";

function abEmail(step, { name, title, orderId, siteUrl }) {
  const link  = `${siteUrl}/create2-preview?o=${encodeURIComponent(orderId)}`;
  const unsub = `${siteUrl}/.netlify/functions/ab-unsub?o=${encodeURIComponent(orderId)}`;
  const who = name || "them";
  const t = title ? `"${title}"` : "Your song";
  const M = {
    ab1: {
      subject: `${who}'s song is waiting 🎧`,
      lead: `The 20-second preview of ${t} is ready whenever you are. Most people say the chorus is the moment.`,
      cta: "▶ Hear the preview"
    },
    ab2: {
      subject: `${t} — still yours to unlock`,
      lead: `Your preview-unlocked rate is still being honoured on your page. One listen, and you'll know if it's the one.`,
      cta: "▶ Listen again"
    },
    ab3: {
      subject: `Your song is deleted tomorrow`,
      lead: `Free previews are stored for 7 days, and ${t} reaches that limit tomorrow. After that it's gone and can't be recovered — this is the last reminder we'll send.`,
      cta: "🔓 Keep my song"
    }
  }[step];
  const foot = `<p style="color:#B8AC9E;font-size:11px;margin-top:26px;line-height:1.6">You're receiving this because you created a song preview at StorySound.
  <a href="${unsub}" style="color:#B8AC9E">Unsubscribe from reminders</a><br>StorySound · Dubai, UAE</p>`;
  return {
    subject: M.subject,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
      <h1 style="font-style:italic;color:#0F0A06">${t}</h1>
      <p style="color:#7A6A5A;margin:12px 0 24px">${M.lead}</p>
      <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">${M.cta}</a>${foot}</div>`,
    text: `${M.subject}\n\n${M.lead}\n\n${link}\n\nUnsubscribe: ${unsub}`
  };
}
const MIN_SIZE_KB = 500;                      // a real full song is ~3MB; below this = broken file
const SITE = process.env.SITE_URL || "https://storysound.netlify.app";

exports.handler = async () => {
  const out = { checked: 0, retried: 0, emailedDelivery: 0, emailedPreview: 0, abandonment: 0, flagged: 0, errors: [] };
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
          await mergeMeta(orderId, { preview_email: r.ok ? "sent" : "failed", preview_emailed_at: r.ok ? Date.now() : null });
          if (r.ok) out.emailedPreview++;
        }

        // 5 ── abandonment ladder: create2, unpaid, previewed, not opted out
        if (!isPaid && m.source === "create2" && m.email && !m.ab_optout && m.preview_email === "sent") {
          const anchor = m.preview_emailed_at || m.created || 0;
          for (const step of AB_STEPS) {
            if (m[step.key]) continue;                          // already handled
            if (Date.now() - anchor < step.afterMs) break;      // ladder is sequential
            const e = abEmail(step.key, { name: m.name, title: song.song_title, orderId, siteUrl: SITE });
            const r = await sendEmail({ to: m.email, subject: e.subject, html: e.html, text: e.text, stream: BROADCAST });
            if (!r.ok && r.reason === "no email or token") break;   // token missing: try again next pass, don't mark
            await mergeMeta(orderId, { [step.key]: r.ok ? "sent" : "failed", [step.key + "_at"]: Date.now() });
            m[step.key] = r.ok ? "sent" : "failed";
            if (r.ok) out.abandonment = (out.abandonment || 0) + 1;
            break;                                              // max one ladder email per pass per order
          }
        }
      } catch (inner) { out.errors.push(orderId + ": " + inner.message); }
    }

    await redis([["SET", "agent:last", JSON.stringify(Object.assign({ ts: Date.now() }, out))]]);
    return { statusCode: 200, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, body: String(err.message || err) };
  }
};
