// netlify/functions/review-gate.js
// Called from the 48h review email. Routes by star rating:
//   4-5 stars → Trustpilot page (external credibility)
//   1-3 stars → Recovery page + internal alert + chargeback-prevention email

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const orderId = p.o;
  const stars   = parseInt(p.stars || "0");

  if (!orderId || isNaN(stars) || stars < 1 || stars > 5) {
    return page(400, "<h1>Invalid link</h1><p>This review link isn't valid.</p>");
  }

  const REDIS_URL    = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
  const POSTMARK_KEY = process.env.POSTMARK_SERVER_TOKEN;
  const FROM_EMAIL   = process.env.FROM_EMAIL || "songs@storysound.ai";
  const ALERT_EMAIL  = process.env.ALERT_EMAIL || FROM_EMAIL;
  const SITE         = process.env.SITE_URL || "https://storysound.netlify.app";
  const TRUSTPILOT   = process.env.TRUSTPILOT_URL || "https://www.trustpilot.com/evaluate/storysound.ai";

  // Load meta + song title
  let meta = {}, songTitle = "your song";
  try {
    const [mr, sr] = await Promise.all([
      fetch(`${REDIS_URL}/get/meta_${orderId}`,  { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }),
      fetch(`${REDIS_URL}/get/song_${orderId}`,  { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } })
    ]);
    const mRaw = (await mr.json())?.result;
    const sRaw = (await sr.json())?.result;
    if (mRaw) meta = JSON.parse(mRaw) || {};
    if (sRaw) { const s = JSON.parse(sRaw); if (s.song_title) songTitle = s.song_title; }
  } catch (e) { console.log("review-gate meta load:", e.message); }

  // Persist rating
  const updatedMeta = Object.assign({}, meta, { rating: stars, rated_at: Date.now() });
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", `meta_${orderId}`, JSON.stringify(updatedMeta)]])
    });
  } catch (e) {}

  // ── HAPPY PATH: 4 or 5 stars ─────────────────────────────────────────────
  if (stars >= 4) {
    return page(200, `
      <div class="icon">&#9733;</div>
      <h1>That means a lot.</h1>
      <p>One more minute — sharing on Trustpilot helps the next person decide, and it means the world to a small team.</p>
      <a href="${TRUSTPILOT}" class="btn">Leave a review on Trustpilot &#8594;</a>
      <p class="small">Opens Trustpilot in a new tab. Takes about 60 seconds.</p>
    `);
  }

  // ── UNHAPPY PATH: 1, 2, or 3 stars ───────────────────────────────────────
  const starStr = ["", "&#9733;&#9734;&#9734;&#9734;&#9734;", "&#9733;&#9733;&#9734;&#9734;&#9734;", "&#9733;&#9733;&#9733;&#9734;&#9734;"][stars] || "";

  if (POSTMARK_KEY) {
    const q = encodeURIComponent;

    // Internal alert to Cansin
    fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": POSTMARK_KEY },
      body: JSON.stringify({
        From: FROM_EMAIL, To: ALERT_EMAIL,
        Subject: `[${stars}/5 stars] "${songTitle}" — action needed`,
        HtmlBody: `<p><strong>Rating:</strong> ${stars}/5 (${starStr})<br>
          <strong>Order:</strong> ${orderId}<br>
          <strong>Song:</strong> "${songTitle}"<br>
          <strong>Customer:</strong> ${meta.email || "unknown"}</p>
          <p><a href="${SITE}/admin-orders">Open in admin &#8594;</a></p>
          <p>Customer has been sent the recovery email asking them to reply before disputing.</p>`,
        TextBody: `${stars}/5 stars — "${songTitle}"\nOrder: ${orderId}\nEmail: ${meta.email || "unknown"}\n\nCustomer sent recovery email.`
      })
    }).catch(() => {});

    // Recovery email to customer
    if (meta.email) {
      fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": POSTMARK_KEY },
        body: JSON.stringify({
          From: FROM_EMAIL, To: meta.email,
          Subject: `We saw your rating — we want to make this right`,
          HtmlBody: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
            <h1 style="color:#0F0A06;font-style:italic">We are sorry.</h1>
            <p style="color:#7A6A5A;margin:12px 0 14px">You gave <em>"${songTitle}"</em> ${stars} ${stars === 1 ? "star" : "stars"} — and we take that seriously. Every song goes out with our name on it, and if this one missed the mark we want to fix it.</p>
            <p style="color:#7A6A5A;margin:0 0 20px">Here is what we can do for you within 24 hours:</p>
            <ul style="color:#5C4A3A;margin:0 0 20px;padding-left:18px;line-height:2.2">
              <li><strong>Free revision</strong> — we will rewrite the song using your original details, or adjusted ones you send us</li>
              <li><strong>Full refund</strong> — no questions, no forms, processed directly within 24 hours</li>
            </ul>
            <p style="color:#7A6A5A;margin:0 0 24px;font-weight:500">Please reply to this email before contacting your bank or card provider.</p>
            <p style="color:#7A6A5A;margin:0 0 24px">Opening a dispute through your bank takes 30 to 90 days and freezes the funds the entire time. If you reply to us directly, we resolve it today — a refund or a new song, whichever you prefer.</p>
            <a href="mailto:${FROM_EMAIL}?subject=${q("Re: " + songTitle + " — I need help")}&body=${q("Hi, here is what I would like to change or what went wrong:\n\n")}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">Reply and tell us what to fix &#8594;</a>
            <p style="color:#9A8F82;font-size:12px;margin-top:20px;text-align:center">We will respond within a few hours. Our 30-day money-back guarantee is unconditional.</p>
          </div>`,
          TextBody: `We saw your ${stars}-star rating and we want to make this right.\n\nWe can rewrite the song or give you a full refund within 24 hours — no questions.\n\nPlease reply to this email before contacting your bank. A direct refund is faster and simpler than a dispute.\n\nJust hit reply and tell us what went wrong.`
        })
      }).catch(() => {});
    }
  }

  // Unhappy landing page
  return page(200, `
    <div class="icon" style="color:#C8553D">&#9785;</div>
    <h1>Thank you for being honest.</h1>
    <p>We just sent you an email at <strong>${meta.email || "your inbox"}</strong> with options to fix this or get a full refund.</p>
    <div class="box">
      <p style="margin:0 0 6px"><strong>Before you contact your bank</strong></p>
      <p style="margin:0;font-size:14px">A direct refund from us takes 24 hours. A bank dispute takes 30 to 90 days and freezes the money the whole time. Please reply to our email first.</p>
    </div>
    <p style="font-size:13px;margin-top:16px">Check your inbox for an email from <a href="mailto:${FROM_EMAIL}" style="color:var(--rust)">${FROM_EMAIL}</a>. We'll make this right.</p>
  `);
};

function page(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StorySound — Review</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--rust:#C8553D;--ink:#1A1814;--mut:#5C564D;--bg:#FAF9F6;--bd:rgba(26,24,20,.08)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);font-family:'Inter',system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.wrap{max-width:460px;width:100%;text-align:center}
.logo{font-weight:800;font-size:18px;margin-bottom:36px;color:var(--ink)}.logo span{color:var(--rust)}
.icon{font-size:52px;margin-bottom:16px;line-height:1;color:#F0C040}
h1{font-size:26px;letter-spacing:-.02em;margin-bottom:12px;color:var(--ink);line-height:1.2}
p{font-size:15px;line-height:1.7;color:var(--mut);margin-bottom:14px}
.btn{display:block;background:var(--rust);color:#fff;padding:15px 24px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;margin:20px 0 8px}
.small{font-size:12px;color:#B8AC9E;margin-top:4px}
.box{background:#fff;border:1px solid var(--bd);border-radius:14px;padding:18px 20px;margin:20px 0;text-align:left}
.box p{font-size:14px;line-height:1.6;color:var(--ink)}
</style></head><body>
<div class="wrap">
  <div class="logo">Story<span>Sound</span></div>
  ${body}
</div></body></html>`
  };
}
