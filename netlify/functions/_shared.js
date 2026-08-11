// netlify/functions/_shared.js — storage, meta, email helpers used across delivery functions
const R = () => ({ url: process.env.UPSTASH_REDIS_REST_URL, tok: process.env.UPSTASH_REDIS_REST_TOKEN });

async function redis(cmds) {
  const { url, tok } = R();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds)
  });
  return res.json();
}

async function getJSON(key) {
  const out = await redis([["GET", key]]);
  const raw = out?.[0]?.result;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// read-modify-write merge; fine at current volume
async function mergeMeta(orderId, patch) {
  const cur = (await getJSON(`meta_${orderId}`)) || {};
  const next = Object.assign(cur, patch, { updated: Date.now() });
  await redis([["SET", `meta_${orderId}`, JSON.stringify(next)]]);
  return next;
}

// make the song record permanent (drop the 24h TTL) + best-effort blob backup
async function persistSong(orderId, event) {
  await redis([["PERSIST", `song_${orderId}`]]);
  try {
    const { getStore, connectLambda } = require("@netlify/blobs");
    if (event) connectLambda(event);
    const song = await getJSON(`song_${orderId}`);
    if (song && song.audio_b64) {
      const store = getStore("songs");
      await store.set(`${orderId}.json`, JSON.stringify(song));
    }
  } catch (e) { console.log("blob backup skipped:", e.message); }
}

async function sendEmail({ to, subject, html, text, stream }) {
  // Prefer Klaviyo transactional if key set, fall back to Postmark
  const KLAV = process.env.KLAVIYO_API_KEY;
  const POST = process.env.POSTMARK_SERVER_TOKEN;

  if (!to) return { ok: false, reason: "no recipient" };

  // ── Klaviyo send ──
  if (KLAV) {
    try {
      const res = await fetch("https://a.klaviyo.com/api/messages/", {
        method: "POST",
        headers: {
          "Authorization": `Klaviyo-API-Key ${KLAV}`,
          "Content-Type": "application/json",
          "revision": "2024-10-15"
        },
        body: JSON.stringify({
          data: {
            type: "message",
            attributes: {
              channel: "email",
              to: [{ type: "profile", attributes: { email: to } }],
              content: {
                subject,
                html_body: html,
                text_body: text || "",
                from_email: process.env.FROM_EMAIL || "help@getstoory.com",
                from_label: "Stoory"
              }
            }
          }
        })
      });
      if (res.status === 202 || res.ok) return { ok: true, id: null, via: "klaviyo" };
      // If Klaviyo returns 4xx (e.g. plan doesn't support transactional), fall through to Postmark
      const body = await res.json().catch(() => ({}));
      console.log("klaviyo send error, falling back:", res.status, JSON.stringify(body).slice(0,120));
    } catch(e) { console.log("klaviyo send exception:", e.message); }
  }

  // ── Postmark fallback ──
  if (!POST) return { ok: false, reason: "no sending credentials" };
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": POST },
    body: JSON.stringify({
      From: process.env.FROM_EMAIL || "help@getstoory.com",
      To: to, Subject: subject, HtmlBody: html, TextBody: text,
      MessageStream: stream || "outbound"
    })
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, id: body.MessageID || null, reason: body.Message || null, via: "postmark" };
}

function deliveryEmail({ title, orderId, siteUrl }) {
  const link = `${siteUrl}/delivery?o=${encodeURIComponent(orderId)}`;
  return {
    subject: `"${title}" is ready to download 🎵`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
      <h1 style="font-style:italic;color:#0F0A06">"${title}"</h1>
      <p style="color:#7A6A5A;margin:12px 0 24px">Your song is ready. Stream it, download it, and keep it forever.</p>
      <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">🎵 Listen &amp; Download</a>
      <p style="color:#9A8F82;font-size:12px;margin-top:20px">Save this email — your download link never expires.</p></div>`,
    text: `"${title}" is ready!\n\nListen & download: ${link}\n\nSave this email — your link never expires.`
  };
}

function previewEmail({ title, orderId, siteUrl, name }) {
  const link = `${siteUrl}/preview?o=${encodeURIComponent(orderId)}`;
  const t = title ? `"${title}"` : "your song";
  return {
    subject: `${name ? name + "'s" : "Your"} song is ready to hear 🎧`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
      <h1 style="font-style:italic;color:#0F0A06">${title ? '"' + title + '"' : "Your song is ready"}</h1>
      <p style="color:#7A6A5A;margin:12px 0 8px">We just finished composing ${t}.</p>
      <p style="color:#7A6A5A;margin:0 0 24px">Hit play below to hear a 20-second preview — free, no card needed.</p>
      <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">&#9654;&#xFE0F; Hear My 20-Second Preview</a>
      <p style="color:#9A8F82;font-size:12px;margin-top:20px">If you love it, unlock the full song — starting at $39.</p></div>`,
    text: `${name ? name + "'s" : "Your"} song is ready!\n\nHear your 20-second preview free: ${link}\n\nIf you love it, unlock the full song.`
  };
}

function paywallReadyEmail({ title, orderId, siteUrl, name }) {
  const link = `${siteUrl}/preview?o=${encodeURIComponent(orderId)}`;
  const t = title ? `"${title}"` : "your song";
  return {
    subject: `${name ? name + "'s" : "Your"} song is ready to hear 🎵`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
      <h1 style="font-style:italic;color:#0F0A06">${title ? '"' + title + '"' : "Your song is ready"}</h1>
      <p style="color:#7A6A5A;margin:12px 0 8px">We just finished writing and composing ${t}.</p>
      <p style="color:#7A6A5A;margin:0 0 24px">Hear a 20-second preview — free — then download the full song for $39.99.</p>
      <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">&#9654;&#xFE0F; Hear My 20-Second Preview</a>
      <p style="color:#9A8F82;font-size:12px;margin-top:20px">One-time payment &middot; Yours forever &middot; 30-Day Money-Back Guarantee</p></div>`,
    text: `${name ? name + "'s" : "Your"} song is ready!\n\nHear your 20-second preview free: ${link}\n\nIf you love it, download the full song for $39.99.`
  };
}

module.exports = { redis, getJSON, mergeMeta, persistSong, sendEmail, deliveryEmail, previewEmail, paywallReadyEmail };
