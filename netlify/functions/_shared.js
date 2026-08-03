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
  if (!to || !process.env.POSTMARK_SERVER_TOKEN) return { ok: false, reason: "no email or token" };
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN },
    body: JSON.stringify({
      From: process.env.FROM_EMAIL || "songs@storysound.ai",
      To: to, Subject: subject, HtmlBody: html, TextBody: text,
      MessageStream: stream || "outbound"   // transactional by default; pass the broadcast stream for marketing
    })
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, id: body.MessageID || null, reason: body.Message || null };
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
  const link = `${siteUrl}/create2-preview?o=${encodeURIComponent(orderId)}`;
  return {
    subject: `${name ? name + "'s" : "Your"} song preview is ready 🎧`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
      <h1 style="font-style:italic;color:#0F0A06">${title ? '"' + title + '"' : "Your song"}</h1>
      <p style="color:#7A6A5A;margin:12px 0 24px">The first 20 seconds are ready to hear — free.</p>
      <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">▶ Hear My Preview</a></div>`,
    text: `Your song preview is ready!\n\nListen free: ${link}`
  };
}

function paywallReadyEmail({ title, orderId, siteUrl, name }) {
  const link = `${siteUrl}/delivery?o=${encodeURIComponent(orderId)}`;
  const t = title ? `"${title}"` : "your song";
  return {
    subject: `${name ? name + "'s" : "Your"} song is ready to hear 🎵`,
    html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
      <h1 style="font-style:italic;color:#0F0A06">${title ? '"' + title + '"' : "Your song is ready"}</h1>
      <p style="color:#7A6A5A;margin:12px 0 8px">We just finished writing and composing ${t} — fully ready to hear.</p>
      <p style="color:#7A6A5A;margin:0 0 24px">Listen to the whole thing free before you decide to download and keep it forever.</p>
      <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">▶ Hear My Song</a>
      <p style="color:#9A8F82;font-size:12px;margin-top:20px">If you love it, download it for $39.99 — yours forever.</p></div>`,
    text: `${name ? name + "'s" : "Your"} song is ready!\n\nListen to the full song free: ${link}\n\nIf you love it, download it for $39.99.`
  };
}

module.exports = { redis, getJSON, mergeMeta, persistSong, sendEmail, deliveryEmail, previewEmail, paywallReadyEmail };
