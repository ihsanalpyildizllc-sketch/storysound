// netlify/functions/send-admin.js — admin triggered email send
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key||"") !== (process.env.DASH_KEY||"ss-admin-2026")) return {statusCode:401,body:"no"};

  const RESEND = process.env.RESEND_API_KEY;
  const FROM   = "Stoory <help@getstoory.com>";
  const SITE   = process.env.SITE_URL || "https://getstoory.com";

  const emails = [
    {
      to: "jaylac.jb@gmail.com", name: "Jackie",
      subject: "Jackie, your song for Darnell is ready 🎵",
      title: "Two Blocks From Where We Met",
      oid: "7427981672537",
      note: "Sorry for the wait — your custom song for Darnell is done. Your full lyrics are on the delivery page too."
    },
    {
      to: "jayhenry1986t18@gmail.com", name: "Jay",
      subject: "Updated: \"The Day She Said Yes\" — Seraphina & Celestia are in 🎵",
      title: "The Day She Said Yes",
      oid: "p2_mskfgvpq99db8",
      note: "We updated the song with Seraphina and Celestia's names as you requested. Here's your new version:"
    },
    {
      to: "lpickert@mac.com", name: "Linda",
      subject: "Your custom song is ready 🎵",
      title: "Your Custom Song",
      oid: "7426382626905",
      note: "Your custom song has been composed and is ready for you."
    }
  ];

  // Fetch titles for orders that need them
  for (const e of emails) {
    try {
      const r = await fetch(`${SITE}/.netlify/functions/preview-song?o=${e.oid}`);
      const d = await r.json();
      if (d.title) { e.title = d.title; e.teaser = d.lyricsTeaser || []; }
    } catch(err) {}
  }

  const results = [];
  for (const e of emails) {
    const link  = `${SITE}/delivery?o=${e.oid}`;
    const tHtml = (e.teaser||[]).slice(0,3).map(l => `<p style="margin:4px 0;font-style:italic;color:#B5471C">&#8220;${l}&#8221;</p>`).join('');
    const html  = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2">
  <div style="background:#fff;border-radius:16px;padding:40px 36px;border:1px solid rgba(0,0,0,.08)">
    <div style="font-size:22px;font-weight:700;color:#0F0A06;text-align:center;margin-bottom:28px">St<span style="color:#B5471C">oo</span>ry</div>
    <h1 style="font-size:24px;font-weight:600;color:#0F0A06;margin:0 0 16px">Hi ${e.name} — your song is ready 🎵</h1>
    <p style="font-size:15px;color:#3D2E24;line-height:1.7;margin:0 0 20px">${e.note}</p>
    <div style="background:#FAF7F2;border-left:3px solid #B5471C;padding:16px 20px;border-radius:0 8px 8px 0;margin:0 0 24px">
      <p style="font-size:15px;font-weight:700;color:#0F0A06;margin:0 0 10px">&#127925; &#8220;${e.title}&#8221;</p>${tHtml}
    </div>
    <a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:100px;text-decoration:none;font-size:16px;font-weight:700;margin:0 0 16px">&#9654; Listen to My Song</a>
    <p style="font-size:14px;color:#3D2E24;line-height:1.7;margin:0">If anything needs adjusting, reply to this email — unlimited free revisions.</p>
  </div>
  <p style="text-align:center;font-size:12px;color:#8C7B70;margin-top:20px">Stoory &middot; help@getstoory.com</p>
</div>`;

    const r = await fetch("https://api.resend.com/emails", {
      method:"POST",
      headers:{"Authorization":"Bearer "+RESEND,"Content-Type":"application/json"},
      body: JSON.stringify({from:FROM, to:e.to, subject:e.subject, html, reply_to:"help@getstoory.com"})
    });
    const d = await r.json();
    results.push({to:e.to, name:e.name, ok:!!d.id, id:d.id||null, error:d.message||null});
  }

  return {statusCode:200, body: JSON.stringify(results, null, 2)};
};
