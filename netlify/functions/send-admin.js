exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key||"") !== (process.env.DASH_KEY||"ss-admin-2026")) return {statusCode:401,body:"no"};
  const RESEND = process.env.RESEND_API_KEY;
  const SITE   = process.env.SITE_URL || "https://getstoory.com";
  const oid    = "p2_mskfgvpq99db8";
  const link   = `${SITE}/delivery?o=${oid}`;

  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
  <div style="background:#fff;border-radius:16px;padding:40px 36px;border:1px solid rgba(0,0,0,.08)">
    <div style="font-size:22px;font-weight:700;color:#0F0A06;text-align:center;margin-bottom:28px">St<span style="color:#B5471C">oo</span>ry</div>
    <h1 style="font-size:24px;font-weight:600;color:#0F0A06;margin:0 0 12px">Hi Jay — we fixed it. We're sorry. 🙏</h1>
    <p style="font-size:15px;color:#3D2E24;line-height:1.7;margin:0 0 20px">We made an error in the last version — we mixed up your story and incorrectly wrote Rachel as a stranger at a door instead of your coworker. That was entirely our mistake and we sincerely apologize.</p>
    <p style="font-size:15px;color:#3D2E24;line-height:1.7;margin:0 0 24px">We've rewritten the song with the <strong>correct story</strong> — Rachel as your coworker, your journey together, and <strong>Seraphina and Celestia</strong> in the song exactly as you originally asked.</p>
    <div style="background:#FAF7F2;border-left:3px solid #B5471C;padding:16px 20px;border-radius:0 8px 8px 0;margin:0 0 24px">
      <p style="font-size:15px;font-weight:700;color:#0F0A06;margin:0 0 10px">&#127925; &#8220;The Day You Said Yes&#8221;</p>
      <p style="font-size:13px;font-style:italic;color:#B5471C;margin:4px 0">&#8220;We were just coworkers, clocking in&#8221;</p>
      <p style="font-size:13px;font-style:italic;color:#B5471C;margin:4px 0">&#8220;Same hallways every day back then&#8221;</p>
      <p style="font-size:13px;font-style:italic;color:#B5471C;margin:4px 0">&#8220;I watched you, built my courage slow&#8221;</p>
    </div>
    <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:100px;text-decoration:none;font-size:16px;font-weight:700;margin:0 0 16px">&#9654; Listen to the Corrected Song</a>
    <p style="font-size:14px;color:#3D2E24;line-height:1.7;margin:0">If anything still needs adjusting, please reply to this email and we will fix it immediately — no more runarounds. We want to get this right for you and Rachel.</p>
  </div>
  <p style="text-align:center;font-size:12px;color:#8C7B70;margin-top:20px">Stoory &middot; help@getstoory.com</p>
</div>`;

  const r = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{"Authorization":"Bearer "+RESEND,"Content-Type":"application/json"},
    body: JSON.stringify({
      from:"Stoory <help@getstoory.com>",
      to:"jayhenry1986t18@gmail.com",
      subject:"Jay — corrected song with the right story 🎵",
      html, reply_to:"help@getstoory.com"
    })
  });
  const d = await r.json();
  return {statusCode:200, body: JSON.stringify({ok:!!d.id, id:d.id||null, error:d.message||null})};
};
