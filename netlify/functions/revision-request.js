// netlify/functions/revision-request.js — customer asks for changes from the delivery page.
// Stores structured feedback, notifies the owner, confirms to the customer. Cap: 5 per order.
const { getJSON, mergeMeta, sendEmail } = require("./_shared");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return j(405, { error: "POST only" });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return j(400, { error: "bad json" }); }

  const orderId = String(b.o || "").slice(0, 64);
  const feedback = String(b.feedback || "").trim().slice(0, 2000);
  const keep = String(b.keep || "").trim().slice(0, 1000);
  if (!orderId || feedback.length < 10) return j(400, { error: "tell us what to change (a sentence or two)" });

  const [meta, unlocked] = await Promise.all([getJSON(`meta_${orderId}`), getJSON(`unlocked_${orderId}`)]);
  const paid = !!unlocked || (meta && meta.source === "create");
  if (!meta || !paid) return j(403, { error: "revisions are for completed orders" });

  const count = (meta.revisions || []).length;
  if (count >= 5) return j(429, { error: "revision limit reached — reply to your delivery email and we'll handle it personally" });

  const rec = { feedback, keep, ts: Date.now() };
  await mergeMeta(orderId, { revisions: [...(meta.revisions || []), rec], revision_open: true });

  const owner = process.env.OWNER_EMAIL || "alpyildizcansinpypl@gmail.com";
  const song = await getJSON(`song_${orderId}`);
  const title = (song && song.song_title) || orderId;

  // notify owner — includes everything needed to act
  await sendEmail({
    to: owner,
    subject: `🔁 Revision request #${count + 1} — "${title}"`,
    html: `<div style="font-family:ui-monospace,monospace;font-size:13px;max-width:640px;margin:0 auto;padding:24px">
      <p><b>Order:</b> ${orderId} · <b>Customer:</b> ${meta.email || "?"}</p>
      <p><b>What to change:</b><br>${esc(feedback)}</p>
      ${keep ? `<p><b>What to keep:</b><br>${esc(keep)}</p>` : ""}
      <p><a href="https://storysound.netlify.app/admin-orders?key=${process.env.DASH_KEY || "ss-admin-2026"}">Open dashboard</a> ·
         <a href="https://storysound.netlify.app/delivery?o=${orderId}">Hear current version</a></p></div>`,
    text: `Revision for ${orderId} (${meta.email})\n\nChange: ${feedback}\n\nKeep: ${keep}`
  });

  // confirm to customer
  if (meta.email) {
    await sendEmail({
      to: meta.email,
      subject: `Got it — we're revising "${title}"`,
      html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
        <h1 style="font-style:italic;color:#0F0A06">On it.</h1>
        <p style="color:#7A6A5A">Your revision notes are with our songwriter now. The new version of "${esc(title)}" will land in this inbox — usually within a few hours.</p>
        <p style="color:#9A8F82;font-size:12px;margin-top:20px">Revisions are free until you love it. That's the whole point.</p></div>`,
      text: `Got your revision notes for "${title}". The new version will arrive by email, usually within a few hours.`
    });
  }
  return j(200, { ok: true });
};
function esc(t){return String(t).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
function j(s,b){return{statusCode:s,headers:{"Content-Type":"application/json"},body:JSON.stringify(b)};}
