// netlify/functions/delivery-agent.js — scheduled watchdog. Runs every 10 minutes.
// Deterministic by design: retries stuck generations, blocks empty files,
// sends any unsent emails, and keeps per-order state honest.
const { redis, getJSON, mergeMeta, persistSong, sendEmail, deliveryEmail, previewEmail, paywallReadyEmail } = require("./_shared");

const MAX_ATTEMPTS = 3;
const STUCK_AFTER_MS = 20 * 60 * 1000;
// abandonment ladder (create2 only): hours after the preview email
const AB_STEPS = [
  { key: "ab1", afterMs:  1 * 60 * 60 * 1000 },       // +1h  — still waiting
  { key: "ab2", afterMs:  3 * 60 * 60 * 1000 },       // +3h  — nudge
  { key: "ab3", afterMs: 26 * 60 * 60 * 1000 },       // +26h — getting deleted
  { key: "ab4", afterMs: 50 * 60 * 60 * 1000 },       // +50h — 15% off
  { key: "ab5", afterMs:  6 * 24 * 60 * 60 * 1000 }   // +6d  — $19 last call
];
const BROADCAST = process.env.POSTMARK_BROADCAST_STREAM || "broadcast";

function abEmail(step, { name, title, orderId, siteUrl }) {
  const previewLink = `${siteUrl}/preview?o=${encodeURIComponent(orderId)}`;
  const unlockLink  = `${siteUrl}/create2-preview?o=${encodeURIComponent(orderId)}`;
  const disc15Link  = `https://gut-1809.myshopify.com/discount/SAVE15?redirect=%2Fcart%2F44263007518809%3A1%26attributes%5BOriginal_Order%5D%3D${encodeURIComponent(orderId)}`;
  const disc19Link  = `https://gut-1809.myshopify.com/discount/SONG19?redirect=%2Fcart%2F44263007518809%3A1%26attributes%5BOriginal_Order%5D%3D${encodeURIComponent(orderId)}`;
  const unsub = `${siteUrl}/.netlify/functions/ab-unsub?o=${encodeURIComponent(orderId)}`;
  const t = title ? `"${title}"` : "Your song";
  const M = {
    ab1: {
      subject: `${name || "Your"}'s song preview is ready`,
      lead: `The 20-second preview of ${t} is ready whenever you are. Most people say the chorus is the moment.`,
      cta: "Listen to the preview", link: previewLink
    },
    ab2: {
      subject: `${t} is still right here`,
      lead: `Your song is finished and ready. Come back and hear it — one click is all it takes.`,
      cta: "Listen now", link: previewLink
    },
    ab3: {
      subject: `${t} gets deleted in 5 days`,
      lead: `Songs that aren't unlocked are removed after 7 days to clear storage. ${t} is approaching that limit. Once it's gone it can't be recovered.`,
      cta: "Unlock before it's gone", link: unlockLink, code: null
    },
    ab4: {
      subject: `15% off — 24 hours only`,
      lead: `We don't do this often. Use code SAVE15 at checkout to get 15% off unlocking ${t}. This code expires in 24 hours.`,
      cta: "Unlock with 15% off", link: disc15Link, code: "SAVE15"
    },
    ab5: {
      subject: `Get your song for $19 — last offer`,
      lead: `${t} is still here, but this is the final email we will send. Unlock it for just $19 today using code SONG19. After today the song is deleted and this offer disappears.`,
      cta: "Get it for $19", link: disc19Link, code: "SONG19"
    }
  }[step];
  if (!M) return null;
  const foot = `<p style="color:#B8AC9E;font-size:11px;margin-top:26px;line-height:1.6">You are receiving this because you created a song at StorySound. <a href="${unsub}" style="color:#B8AC9E">Unsubscribe</a> &middot; Dubai, UAE</p>`;
  const codeBlock = M.code ? `<div style="margin:0 0 20px;text-align:center"><span style="display:inline-block;background:#F3EFE9;border:1px dashed #C8A882;border-radius:8px;padding:8px 20px;font-family:monospace;font-size:18px;letter-spacing:.1em;color:#5A3A1A;font-weight:700">${M.code}</span><p style="font-size:12px;color:#9A8F82;margin-top:6px">Enter at checkout</p></div>` : "";
  return {
    subject: M.subject,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">${t}</h1><p style="color:#7A6A5A;margin:12px 0 24px">${M.lead}</p>${codeBlock}<a href="${M.link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">${M.cta}</a>${foot}</div>`,
    text: `${M.subject}\n\n${M.lead}${M.code ? "\n\nUse code: " + M.code : ""}\n\n${M.link}\n\nUnsubscribe: ${unsub}`
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
        const isPaid = !!unlocked || (m.source === "create" && m.paid === true);

        // ── 10-minute hold: don't email until song has been done for 10 min ──
        const tenMinAgo = Date.now() - 10 * 60 * 1000;
        const doneAt = song.completed_at || song.created || 0;
        if (doneAt > tenMinAgo) continue;   // too fresh — revisit next pass

        if (isPaid && !m.persisted) {
          await persistSong(orderId, null);
          await mergeMeta(orderId, { persisted: true });
        }

        // review request: 48h after delivery email — 5-star gate
        if (isPaid && m.email && m.email_status === "sent" && !m.reviewed && m.review_request !== "sent" && !m.ab_optout) {
          if (Date.now() - (m.emailed_at || 0) > 48 * 60 * 60 * 1000) {
            const t = song.song_title || "your song";
            const rg = (stars) => `${SITE}/.netlify/functions/review-gate?o=${encodeURIComponent(orderId)}&stars=${stars}`;
            const starRow = [1,2,3,4,5].map(s =>
              `<a href="${rg(s)}" style="display:inline-block;text-decoration:none;margin:0 3px;background:#fff;border:1.5px solid #E8E0D8;border-radius:10px;padding:10px 12px;font-size:20px;line-height:1">${"&#9733;".repeat(s)}</a>`
            ).join("");
            const r = await sendEmail({
              to: m.email,
              subject: `How did "${t}" land?`,
              html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">"${t}"</h1><p style="color:#7A6A5A;margin:12px 0 6px">Did they love it? Did it make them cry? Did it miss?</p><p style="color:#7A6A5A;margin:0 0 24px">Tap the stars — takes one second and we read every response.</p><div style="text-align:center;margin-bottom:8px">${starRow}</div><p style="text-align:center;font-size:12px;color:#B8AC9E;margin-top:16px">1 star = missed the mark &nbsp;&nbsp;&middot;&nbsp;&nbsp; 5 stars = they cried</p></div>`,
              text: `How did "${t}" land?\n\n1 star: ${rg(1)}\n2 stars: ${rg(2)}\n3 stars: ${rg(3)}\n4 stars: ${rg(4)}\n5 stars: ${rg(5)}`
            });
            if (!(r.reason === "no email or token")) {
              await mergeMeta(orderId, { review_request: r.ok ? "sent" : "failed", review_requested_at: Date.now() });
            }
          }
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

        // "song ready to hear" email for /create paywall orders (unpaid)
        if (!isPaid && m.source === "create" && m.email && m.paywall_email !== "sent") {
          const e = paywallReadyEmail({ title: song.song_title, orderId, siteUrl: SITE, name: m.name });
          const r = await sendEmail({ to: m.email, subject: e.subject, html: e.html, text: e.text });
          await mergeMeta(orderId, { paywall_email: r.ok ? "sent" : "failed", paywall_emailed_at: r.ok ? Date.now() : null });
          if (r.ok) out.emailedPreview++;
        }

        // 5 ── abandonment ladder: create2, unpaid, previewed, not opted out
        if (!isPaid && m.source === "create2" && m.email && !m.ab_optout && m.preview_email === "sent") {
          const anchor = m.preview_emailed_at || m.created || 0;
          for (const step of AB_STEPS) {
            if (m[step.key]) continue;
            if (Date.now() - anchor < step.afterMs) break;
            const e = abEmail(step.key, { name: m.name, title: song.song_title, orderId, siteUrl: SITE });
            const r = await sendEmail({ to: m.email, subject: e.subject, html: e.html, text: e.text, stream: BROADCAST });
            if (!r.ok && r.reason === "no email or token") break;
            await mergeMeta(orderId, { [step.key]: r.ok ? "sent" : "failed", [step.key + "_at"]: Date.now() });
            m[step.key] = r.ok ? "sent" : "failed";
            if (r.ok) out.abandonment = (out.abandonment || 0) + 1;
            break;
          }
        }

        // abandonment ladder: /create, unpaid, song heard but not downloaded
        if (!isPaid && m.source === "create" && m.email && !m.ab_optout && m.paywall_email === "sent") {
          const anchor = m.paywall_emailed_at || m.created || 0;
          const STORE = "gut-1809.myshopify.com";
          const jobIdEnc = encodeURIComponent(orderId);
          const dlLink = `${SITE}/delivery?o=${jobIdEnc}`;
          const disc15Url = `https://${STORE}/discount/SAVE15?redirect=%2Fcart%2F44258532819033%3A1%26attributes%5BJob_ID%5D%3D${jobIdEnc}`;
          const disc19Url = `https://${STORE}/discount/SONG19?redirect=%2Fcart%2F44258532819033%3A1%26attributes%5BJob_ID%5D%3D${jobIdEnc}`;
          const unsub = `${SITE}/.netlify/functions/ab-unsub?o=${jobIdEnc}`;
          const t = song.song_title ? '"' + song.song_title + '"' : "your song";
          const createAbMsgs = {
            ab1: { subject: "Your song is still waiting to be downloaded",
                   lead: "You heard it. Now make it yours. One click and you can download " + t + " and keep it forever.",
                   cta: "Download my song", link: dlLink, code: null },
            ab2: { subject: t + " is still right here",
                   lead: "Your song is finished and ready to download. Come back whenever you are ready.",
                   cta: "Download now", link: dlLink, code: null },
            ab3: { subject: t + " gets deleted in 5 days",
                   lead: "Songs that are not downloaded are removed after 7 days. " + t + " is approaching that limit. Once it is gone it cannot be recovered.",
                   cta: "Download before it is gone", link: dlLink, code: null },
            ab4: { subject: "15% off your song download — 24 hours only",
                   lead: "Use code SAVE15 at checkout to get 15% off downloading " + t + ". This code expires in 24 hours.",
                   cta: "Download with 15% off", link: disc15Url, code: "SAVE15" },
            ab5: { subject: "Get your song for $19 — final offer",
                   lead: t + " is still here, but this is the final email we will send. Download it for just $19 today using code SONG19. After today the song is deleted and this offer disappears.",
                   cta: "Get it for $19", link: disc19Url, code: "SONG19" }
          };
          for (const step of AB_STEPS) {
            if (m[step.key]) continue;
            if (Date.now() - anchor < step.afterMs) break;
            const msg = createAbMsgs[step.key];
            if (!msg) continue;
            const codeBlock = msg.code ? '<div style="margin:0 0 20px;text-align:center"><span style="display:inline-block;background:#F3EFE9;border:1px dashed #C8A882;border-radius:8px;padding:8px 20px;font-family:monospace;font-size:18px;letter-spacing:.1em;color:#5A3A1A;font-weight:700">' + msg.code + '</span><p style="font-size:12px;color:#9A8F82;margin-top:6px">Enter at checkout</p></div>' : "";
            const foot = '<p style="color:#B8AC9E;font-size:11px;margin-top:26px">You created a song at StorySound. <a href="' + unsub + '" style="color:#B8AC9E">Unsubscribe</a></p>';
            const html = '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">' + t + '</h1><p style="color:#7A6A5A;margin:12px 0 24px">' + msg.lead + '</p>' + codeBlock + '<a href="' + msg.link + '" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">' + msg.cta + '</a>' + foot + '</div>';
            const r = await sendEmail({ to: m.email, subject: msg.subject, html, text: msg.lead + (msg.code ? "\n\nCode: " + msg.code : "") + "\n\n" + msg.link, stream: BROADCAST });
            if (!r.ok && r.reason === "no email or token") break;
            await mergeMeta(orderId, { [step.key]: r.ok ? "sent" : "failed", [step.key + "_at"]: Date.now() });
            m[step.key] = r.ok ? "sent" : "failed";
            if (r.ok) out.abandonment = (out.abandonment || 0) + 1;
            break;
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

