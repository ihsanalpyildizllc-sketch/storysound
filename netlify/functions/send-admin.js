exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key||"") !== (process.env.DASH_KEY||"ss-admin-2026")) return {statusCode:401,body:"no"};
  const RESEND = process.env.RESEND_API_KEY;
  const SITE   = process.env.SITE_URL || "https://getstoory.com";
  const oid    = "7426564096089";
  const title  = "Virginia Soul";
  const link   = `${SITE}/delivery?o=${oid}`;
  const cart   = "https://myexxtra.com/cart/44263046381657:1";

  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
  <div style="background:#fff;border-radius:16px;padding:40px 36px;border:1px solid rgba(0,0,0,.08)">
    <div style="font-size:22px;font-weight:700;color:#0F0A06;text-align:center;margin-bottom:28px">St<span style="color:#B5471C">oo</span>ry</div>
    <h1 style="font-size:24px;font-weight:600;color:#0F0A06;margin:0 0 12px">Hey Brandon — glad you love it! 🎵</h1>
    <p style="font-size:15px;color:#3D2E24;line-height:1.7;margin:0 0 24px">Yes — you can absolutely make it longer and add more details. Here's how:</p>
    <div style="background:#FAF7F2;border:1.5px solid #B5471C;border-radius:12px;padding:24px;margin:0 0 20px">
      <p style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#B5471C;margin:0 0 8px">Option 1 — Add a 3rd Verse</p>
      <p style="font-size:18px;font-weight:700;color:#0F0A06;margin:0 0 8px">A full new verse written from your story</p>
      <p style="font-size:14px;color:#5A4A3F;line-height:1.7;margin:0 0 16px">We'll write a brand new verse using the details that didn't make it into the original — new memories, deeper moments, specific names or places you want included. Then we recompose the full track with it added.</p>
      <div style="margin:0 0 16px"><span style="font-size:22px;font-weight:700;color:#0F0A06">$39</span> <span style="font-size:13px;color:#8C7B70">· one-time · yours forever</span></div>
      <a href="${cart}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:14px;border-radius:100px;font-weight:700;font-size:15px;text-decoration:none;">✍️ Add a 3rd Verse — $39</a>
    </div>
    <div style="background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:24px;margin:0 0 24px">
      <p style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5A4A3F;margin:0 0 8px">Option 2 — Free: Send us more details</p>
      <p style="font-size:14px;color:#5A4A3F;line-height:1.7;margin:0 0 16px">If there are specific memories, names, or moments you'd like woven in, just send them to us — we'll do a free revision and rewrite with your new details included.</p>
      <a href="${link}" style="display:block;background:#0F0A06;color:#fff;text-align:center;padding:14px;border-radius:100px;font-weight:700;font-size:15px;text-decoration:none;">🔁 Request a Free Revision</a>
    </div>
    <p style="font-size:13px;color:#8C7B70;text-align:center;">Either way — reply to this email and we'll make it exactly what you imagined.</p>
  </div>
  <p style="text-align:center;font-size:12px;color:#8C7B70;margin-top:20px">Stoory · help@getstoory.com</p>
</div>`;

  const r = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{"Authorization":"Bearer "+RESEND,"Content-Type":"application/json"},
    body: JSON.stringify({
      from:"Stoory <help@getstoory.com>", to:"1986bwoods@gmail.com",
      subject:`Want more? Here's how to extend "${title}" 🎵`,
      html, reply_to:"help@getstoory.com"
    })
  });
  const d = await r.json();
  return {statusCode:200, body: JSON.stringify({ok:!!d.id, id:d.id||null, error:d.message||null})};
};
