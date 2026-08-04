// netlify/functions/mailchimp-sync.js
// Adds/updates a Mailchimp contact and applies lifecycle tags that trigger
// Customer Journeys (song-ready, abandoned, purchased).
//
// POST { email, buyerName, songTitle, songFor, previewUrl, occasion, genre, tags:[] }

const crypto = require("crypto");

const DC   = "us20";
const LIST = "2db56c6fb5";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const KEY = process.env.MAILCHIMP_API_KEY;
  if (!KEY) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "no MAILCHIMP_API_KEY" }) };

  let b;
  try { b = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const email = (b.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { statusCode: 400, body: JSON.stringify({ error: "bad email" }) };

  const hash = crypto.createHash("md5").update(email).digest("hex");
  const auth = "Basic " + Buffer.from("anystring:" + KEY).toString("base64");
  const base = `https://${DC}.api.mailchimp.com/3.0/lists/${LIST}`;

  const merge = {};
  if (b.buyerName)  merge.FNAME      = b.buyerName;
  if (b.songTitle)  merge.SONGTITLE  = b.songTitle;
  if (b.songFor)    merge.SONGFOR    = b.songFor;
  if (b.previewUrl) merge.PREVIEWURL = b.previewUrl;
  if (b.occasion)   merge.OCCASION   = b.occasion;
  if (b.genre)      merge.GENRE      = b.genre;
  if (b.phone)      merge.PHONE      = b.phone;

  try {
    // Upsert the contact
    const upsert = await fetch(`${base}/members/${hash}`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        email_address: email,
        status_if_new: "subscribed",
        merge_fields: merge
      })
    });
    const member = await upsert.json();

    if (!upsert.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, mcError: member.detail || member.title }) };
    }

    // Apply tags — these are what trigger the Customer Journeys
    const tags = Array.isArray(b.tags) ? b.tags : (b.tags ? [b.tags] : []);
    if (tags.length) {
      await fetch(`${base}/members/${hash}/tags`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ tags: tags.map(t => ({ name: t, status: "active" })) })
      });
    }

    // Remove tags (e.g. clear "abandoned" once they buy)
    const remove = Array.isArray(b.removeTags) ? b.removeTags : [];
    if (remove.length) {
      await fetch(`${base}/members/${hash}/tags`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ tags: remove.map(t => ({ name: t, status: "inactive" })) })
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, id: member.id, status: member.status, tagsApplied: tags })
    };

  } catch (e) {
    console.error("mailchimp-sync:", e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
