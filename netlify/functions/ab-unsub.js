// netlify/functions/ab-unsub.js — one-click unsubscribe from reminder emails.
// Only silences the abandonment sequence; delivery emails for paid orders still send.
const { mergeMeta } = require("./_shared");

exports.handler = async (event) => {
  const o = (event.queryStringParameters || {}).o;
  if (o) { try { await mergeMeta(o, { ab_optout: true }); } catch (e) {} }
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head>
<body style="font-family:Georgia,serif;background:#FAF7F2;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;padding:40px;max-width:420px">
<h1 style="font-style:italic;color:#0F0A06">You're unsubscribed.</h1>
<p style="color:#7A6A5A">No more reminders about this song. If you ever unlock it, your delivery email will still arrive.</p>
</div></body></html>`
  };
};
