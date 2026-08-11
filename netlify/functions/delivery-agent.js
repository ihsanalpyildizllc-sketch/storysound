// netlify/functions/delivery-agent.js — scheduled watchdog. Runs every 10 minutes.
// redeploy 2026-08-04: bake in POSTMARK_SERVER_TOKEN + FROM_EMAIL env vars
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
const GRIEF = /\b(memorial|in memory|passed away|passing|rest in peace|rip\b|funeral|celebration of life|died|death|loss of|late (husband|wife|father|mother|son|daughter|brother|sister)|miss (you|him|her) so much|forever in our hearts|gone too soon|would have been|would be our|first anniversary without|since (he|she) (passed|left us))/i;
function griefOrder(m){
  if(!m) return false;
  if(m.grief === true) return true;
  if(/memorial|remembrance|in memory/i.test(String(m.occasion||""))) return true;
  return GRIEF.test([m.qualities,m.memories,m.message,m.story,m.occasion].filter(Boolean).join(" "));
}

// ── /create checkout-abandonment ladder (quiz done, never paid) ─────────────
const LEAD_STEPS = [
  { key: "l1", afterMs: 45 * 60 * 1000 },            // 45 min
  { key: "l2", afterMs: 24 * 60 * 60 * 1000 },        // 24 h
  { key: "l3", afterMs: 48 * 60 * 60 * 1000 },        // 48 h  — SAVE15
  { key: "l4", afterMs: 5 * 24 * 60 * 60 * 1000 }     // 5 d   — SONG19
];

function leadEmail(step, { name, buyerName, invoiceUrl, siteUrl }) {
  const who = name || "them";
  const cta = invoiceUrl || (siteUrl + "/create");
  const btn = (label) => `<a href="${cta}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">${label}</a>`;
  const wrap = (h1, p, label, ps) => ({
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">${h1}</h1><p style="color:#7A6A5A;margin:12px 0 24px">${p}</p>${btn(label)}${ps ? `<p style="color:#7A6A5A;font-size:13px;margin-top:18px">${ps}</p>` : ""}</div>`,
    text: `${h1}\n\n${p.replace(/<[^>]+>/g, "")}\n\n${label}: ${cta}`
  });
  if (step === "l1") return Object.assign(
    { subject: `${name ? name + "'s" : "Your"} song is saved \u2014 one step left` },
    wrap(`Everything you wrote is safe.`,
         `The story, the memories, the message \u2014 it\u2019s all with our songwriters, ready to become ${who}\u2019s song. You were one click from the finish line.`,
         `Finish my order \u2192`));
  if (step === "l2") return Object.assign(
    { subject: `The story you wrote for ${who} is still waiting` },
    wrap(`Some words deserve a melody.`,
         `What you wrote about ${who} isn\u2019t something people say out loud every day. That\u2019s exactly why it makes such a powerful song \u2014 and why we saved every word.`,
         `Turn my words into a song \u2192`));
  if (step === "l3") return Object.assign(
    { subject: `15% off ${name ? name + "'s" : "your"} song \u2014 code SAVE15` },
    wrap(`A little nudge.`,
         `Your song is written from the answers you already gave \u2014 there\u2019s nothing left to do but press the button. Use code <strong>SAVE15</strong> at checkout for 15% off, this week only.`,
         `Claim 15% off \u2192`,
         `Code: <strong>SAVE15</strong> \u00b7 applied at checkout`));
  return Object.assign(
    { subject: `Last call: ${who}\u2019s custom song for $19` },
    wrap(`Before we archive it.`,
         `We hold every story for a limited time before our songwriters move on. Use code <strong>SONG19</strong> and get the full custom song \u2014 written, sung, and delivered \u2014 for just $19.`,
         `Get my song for $19 \u2192`,
         `Code: <strong>SONG19</strong> \u00b7 final offer`));
}

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
  const foot = `<p style="color:#B8AC9E;font-size:11px;margin-top:26px;line-height:1.6">You're receiving this because you created a song preview at Stoory.
  <a href="${unsub}" style="color:#B8AC9E">Unsubscribe from reminders</a><br>Stoory · Dubai, UAE</p>`;
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
const SITE = process.env.SITE_URL || "https://getstoory.com";

// Klaviyo list IDs per funnel source
const KLAV_LISTS = {
  "create":  "Sa5Fsn",
  "create2": "SGttHB",
  "create3": "VEic7W",
  "paid":    "XZ7RTE",
};

async function klaviyo(email, eventName, props, profileProps) {
  const KEY = process.env.KLAVIYO_API_KEY;
  if (!KEY || !email) return;
  const KLAV_HEADERS = { "Authorization": "Klaviyo-API-Key " + KEY, "Content-Type": "application/json", "revision": "2024-10-15" };
  const source = (props && props.source) || (profileProps && profileProps.source) || "";

  try {
    // 1. Upsert profile with source_funnel property
    const listId = KLAV_LISTS[source] || null;
    await fetch("https://a.klaviyo.com/api/profile-import/", {
      method: "POST", headers: KLAV_HEADERS,
      body: JSON.stringify({ data: { type: "profile", attributes: Object.assign(
        { email, properties: { source_funnel: source || "unknown" } },
        profileProps || {}
      )}})
    });

    // 2. Add to source-specific list if we have one
    if (listId) {
      await fetch("https://a.klaviyo.com/api/lists/" + listId + "/relationships/profiles/", {
        method: "POST", headers: KLAV_HEADERS,
        body: JSON.stringify({ data: [{ type: "profile", attributes: { email } }] })
      });
    }

    // 3. Track the event
    await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST", headers: KLAV_HEADERS,
      body: JSON.stringify({ data: { type: "event", attributes: {
        metric: { data: { type: "metric", attributes: { name: eventName } } },
        profile: { data: { type: "profile", attributes: { email } } },
        properties: Object.assign({ source_funnel: source }, props || {}),
        time: new Date().toISOString()
      }}})
    });
  } catch(e) { console.log("klaviyo err:", e.message); }
}

// Push a contact to Mailchimp with lifecycle tags (fire-and-forget)
async function mcSync(payload){
  try {
    await fetch(`${SITE}/.netlify/functions/mailchimp-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch(e) { console.log("mcSync skipped:", e.message); }
}

exports.handler = async () => {
  const out = { checked: 0, retried: 0, emailedDelivery: 0, emailedPreview: 0, abandonment: 0, leadLadder: 0, pruned: 0, flagged: 0, errors: [] };
  try {
    const idx = await redis([["LRANGE", "orders_index", "0", "299"]]);
    const ids = [...new Set(idx?.[0]?.result || [])];

    for (const orderId of ids) {
      out.checked++;
      try {
        const [song, meta] = await Promise.all([getJSON(`song_${orderId}`), getJSON(`meta_${orderId}`)]);

        // 0 \u2500\u2500 /create quiz lead (no song record) \u2192 checkout-abandonment ladder
        if (meta && meta.kind === "lead") {
          const mL = meta;
          if (mL.email && !mL.ab_optout && !mL.lead_done && !griefOrder(mL)) {
            const conv = await redis([["GET", "converted:" + String(mL.email).toLowerCase()]]);
            if (conv?.[0]?.result) {
              await mergeMeta(orderId, { lead_done: "converted", lead_done_at: Date.now() });
            } else {
              const anchor = mL.created || 0;
              for (const step of LEAD_STEPS) {
                if (mL[step.key]) continue;                       // already sent
                if (Date.now() - anchor < step.afterMs) break;    // sequential timing
                const e = leadEmail(step.key, { name: mL.name, buyerName: mL.buyerName, invoiceUrl: mL.invoiceUrl, siteUrl: SITE });
                const r = await sendEmail({ to: mL.email, subject: e.subject, html: e.html, text: e.text, stream: BROADCAST });
                if (!r.ok) break;                                 // token missing / pending approval \u2192 retry next pass, don\u2019t consume the step
                await mergeMeta(orderId, { [step.key]: "sent", [step.key + "_at"]: Date.now() });
                await klaviyo(mL.email, "Abandoned Quiz", { step: step.key, invoice_url: mL.invoiceUrl, song_for: mL.name }, { first_name: mL.buyerName });
                out.leadLadder++;
                break;                                            // max one ladder email per pass
              }
            }
          }
          continue;                                               // leads never reach song logic
        }

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

        // ── AUTO-PRUNE: strip the 5-8MB audio blob from old finished orders ──
        // Only after the song is safely persisted to permanent storage and the
        // customer has had their delivery window. Metadata + lyrics stay forever,
        // so the delivery page still works; only the cached blob is dropped.
        if (song && song.audio_b64 && !m.pruned) {
          const doneAt = m.emailed_at || m.preview_emailed_at || m.created || 0;
          const age = doneAt ? Date.now() - doneAt : 0;
          const PAID_TTL   = 14 * 24 * 60 * 60 * 1000;   // paid: 14 days after delivery
          const UNPAID_TTL = 10 * 24 * 60 * 60 * 1000;   // unpaid: 10 days (ladder ends at 6d)
          const ttl = isPaid ? PAID_TTL : UNPAID_TTL;
          const safeToPrune = isPaid ? !!m.persisted : true;

          if (safeToPrune && age > ttl) {
            const slim = Object.assign({}, song);
            delete slim.audio_b64;
            slim.pruned = true;
            await redis([["SET", `song_${orderId}`, JSON.stringify(slim)]]);
            await mergeMeta(orderId, { pruned: true, pruned_at: Date.now() });
            out.pruned = (out.pruned || 0) + 1;
            continue;   // nothing else to do for this order this pass
          }
        }

        // review request: 48h after delivery email, once, only if not yet reviewed
        if (isPaid && m.email && m.email_status === "sent" && !m.reviewed && m.review_request !== "sent" && !m.ab_optout && !griefOrder(m)) {
          if (Date.now() - (m.emailed_at || 0) > 48 * 60 * 60 * 1000) {
            const rl = `${SITE}/review?o=${encodeURIComponent(orderId)}`;
            const r = await sendEmail({
              to: m.email,
              subject: `Did "${song.song_title || "your song"}" land? (1 minute)`,
              html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">How did it go?</h1><p style="color:#7A6A5A;margin:12px 0 24px">What was their reaction when they heard it? One minute of your time helps the next person decide — and we read every single word.</p><a href="${rl}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">⭐ Leave a 1-minute review</a></div>`,
              text: `How did it go? Tell us in one minute: ${rl}`
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
          if (r.ok) klaviyo(m.email, "Song Delivered", { song_title: song.song_title, delivery_url: SITE+"/delivery?o="+orderId, total: m.total, source: "paid" }, { first_name: m.buyerName, source: "paid" });
          if (r.ok) out.emailedDelivery++;
        }

        // Mailchimp: tag as song-ready the first time we see a finished song
        if (m.email && !m.mc_ready) {
          await mcSync({
            email: m.email,
            buyerName: m.buyerName || "",
            songTitle: song.song_title || "",
            songFor: m.name || "",
            previewUrl: `${SITE}/preview?o=${encodeURIComponent(orderId)}`,
            tags: [ isPaid ? "purchased" : "song-ready", "source-" + (m.source || "create2") ],
            removeTags: isPaid ? ["song-ready", "abandoned"] : []
          });
          await mergeMeta(orderId, { mc_ready: true, mc_ready_at: Date.now() });
        }

        if (!isPaid && m.source === "create2" && m.email && m.preview_email !== "sent") {
          const e = previewEmail({ title: song.song_title, orderId, siteUrl: SITE, name: m.name });
          const r = await sendEmail({ to: m.email, subject: e.subject, html: e.html, text: e.text });
          await mergeMeta(orderId, { preview_email: r.ok ? "sent" : "failed", preview_emailed_at: r.ok ? Date.now() : null, email_err: r.ok ? null : (r.reason || "unknown") });
          if (r.ok) klaviyo(m.email, "Song Ready", { song_title: song.song_title, preview_url: SITE+"/create2-preview?o="+orderId, song_for: m.name, genre: m.genre, source: "create2" }, { first_name: m.buyerName, source: "create2" });
          if (r.ok) out.emailedPreview++;
        }

        // 5 ── abandonment ladder: create2, unpaid, previewed, not opted out
        if (!isPaid && m.source === "create2" && m.email && !m.ab_optout && m.preview_email === "sent" && !griefOrder(m)) {
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
            if (r.ok) klaviyo(m.email, "Preview Abandoned", { step: step.key, song_title: song.song_title, preview_url: SITE+"/create2-preview?o="+orderId, source: "create2" }, { first_name: m.buyerName, source: "create2" });
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
