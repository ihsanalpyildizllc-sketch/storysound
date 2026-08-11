// netlify/functions/revision-request.js — customer asks for changes from the delivery page.
const { getJSON, mergeMeta, sendEmail } = require("./_shared");

const SITE = process.env.SITE_URL || "https://getstoory.com";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return j(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch(e) { return j(400, { error: "bad json" }); }

  const orderId     = String(b.o || "").slice(0, 64);
  const feedback    = String(b.feedback || "").trim().slice(0, 2000);
  const keep        = String(b.keep || "").trim().slice(0, 1000);
  const context     = String(b.context || "").trim().slice(0, 1000);
  const customerName  = String(b.name || "").trim().slice(0, 80);
  const customerEmail = String(b.email || "").trim().slice(0, 120);

  if (!orderId || feedback.length < 10)
    return j(400, { error: "tell us what to change (a sentence or two)" });

  const [meta, unlocked] = await Promise.all([
    getJSON(`meta_${orderId}`),
    getJSON(`unlocked_${orderId}`)
  ]);

  // Paid = has unlocked flag OR came from /create OR is a Shopify numeric order ID
  const isShopifyOrder = /^\d{10,}$/.test(orderId);
  const paid = !!unlocked || (meta && meta.source === "create") || isShopifyOrder;
  if (!paid) return j(403, { error: "revisions are for completed orders" });

  const revisions = (meta && meta.revisions) || [];
  if (revisions.length >= 5)
    return j(429, { error: "revision limit reached — reply to your delivery email and we'll handle it personally" });

  const rec = { feedback, keep, ts: Date.now() };
  if (meta) {
    await mergeMeta(orderId, { revisions: [...revisions, rec], revision_open: true });
  }

  const owner = process.env.OWNER_EMAIL || process.env.ALERT_EMAIL || "help@getstoory.com";
  const song  = await getJSON(`song_${orderId}`);
  const title = (song && song.song_title) || orderId;
  const emailTo = (meta && meta.email) || customerEmail;

  // Track in Klaviyo so you can see it in the dashboard even if email fails
  try {
    const KLAV = process.env.KLAVIYO_API_KEY;
    if (KLAV) {
      await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: { "Authorization": "Klaviyo-API-Key " + KLAV, "Content-Type": "application/json", "revision": "2024-10-15" },
        body: JSON.stringify({ data: { type: "event", attributes: {
          metric: { data: { type: "metric", attributes: { name: "Revision Requested" } } },
          profile: { data: { type: "profile", attributes: { email: emailTo || "unknown" } } },
          properties: { order_id: orderId, song_title: title, feedback, keep, revision_number: revisions.length + 1 },
          time: new Date().toISOString()
        }}})
      });
    }
  } catch(e) {}

  // Notify owner
  await sendEmail({
    to: owner,
    subject: `🔁 Revision request #${revisions.length + 1} — "${title}"`,
    html: `<div style="font-family:ui-monospace,monospace;font-size:13px;max-width:640px;margin:0 auto;padding:24px">
      <p><b>Order:</b> ${orderId}</p>
      <p><b>Customer:</b> ${esc(emailTo || "?")} ${customerName ? "("+esc(customerName)+")" : ""}</p>
      <p><b>What to change:</b><br>${esc(feedback)}</p>
      ${keep ? "<p><b>What to keep:</b><br>"+esc(keep)+"</p>" : ""}
      ${context ? "<p><b>Additional context:</b><br>"+esc(context)+"</p>" : ""}
      <p>
        <a href="${SITE}/admin-orders?key=${process.env.DASH_KEY || "ss-admin-2026"}">Open dashboard</a> ·
        <a href="${SITE}/delivery?o=${orderId}">Hear current version</a>
      </p></div>`,
    text: `Revision for ${orderId} (${emailTo})\n\nChange: ${feedback}\n\nKeep: ${keep}`
  });

  // Confirm to customer
  if (emailTo) {
    await sendEmail({
      to: emailTo,
      subject: `Got it — we're revising "${title}"`,
      html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
        <h1 style="font-style:italic;color:#0F0A06">On it.</h1>
        <p style="color:#7A6A5A">Your revision notes are with our songwriter now. The new version of "${esc(title)}" will land in this inbox — usually within a few hours.</p>
        <p style="color:#9A8F82;font-size:12px;margin-top:20px">Revisions are free until you love it. That's the whole point.</p>
      </div>`,
      text: `Got your revision notes for "${title}". The new version will arrive by email, usually within a few hours.`
    });
  }

  return j(200, { ok: true });
};

function esc(t){ return String(t).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function j(s,b){ return { statusCode: s, headers: {"Content-Type":"application/json"}, body: JSON.stringify(b) }; }
