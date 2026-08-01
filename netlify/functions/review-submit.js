// netlify/functions/review-submit.js — capture a customer review.
// Public display requires: real paid order + explicit permission + 4★ or higher.
// EVERY submission (any rating) counts toward the honest aggregate.
const { redis, getJSON, mergeMeta } = require("./_shared");

async function savePhoto(event, key, b64) {
  try {
    const { getStore, connectLambda } = require("@netlify/blobs");
    connectLambda(event);
    await getStore("review-photos").set(key, b64);
    return key;
  } catch (e) { console.log("photo skipped:", e.message); return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return j(400, { error: "bad json" }); }

  const orderId = String(b.o || "").slice(0, 64);
  const stars = Math.min(5, Math.max(1, parseInt(b.stars, 10) || 0));
  const text = String(b.text || "").trim().slice(0, 1200);
  const name = String(b.name || "").trim().slice(0, 60);
  const permission = !!b.permission;
  const photoB64 = typeof b.photo === "string" && b.photo.length < 2_000_000 ? b.photo.replace(/^data:image\/\w+;base64,/, "") : null;

  // ADMIN MODE: manually add a review collected outside the funnel (WhatsApp, giveaway, DM).
  // Requires the dash key. Marked source:'manual' and MUST still be a real customer's real words.
  const isAdmin = b.adminKey && b.adminKey === (process.env.DASH_KEY || "ss-admin-2026");
  if (isAdmin) {
    if (!stars || !text || !name) return j(400, { error: "admin add needs stars, text, name" });
    const key = "manual_" + Date.now();
    const photoKey = photoB64 ? await savePhoto(event, key + ".jpg", photoB64) : null;
    const rec = { orderId: key, stars, text, name, source: "manual",
      verified: !!b.verifiedPurchase, photo: photoKey, ts: Date.now() };
    const cmds = [["LPUSH","reviews_all",JSON.stringify(rec)],["LTRIM","reviews_all","0","1999"]];
    if (stars >= 4) cmds.push(["LPUSH","reviews_public",JSON.stringify(rec)],["LTRIM","reviews_public","0","499"]);
    await redis(cmds);
    return j(200, { ok: true, published: stars >= 4, key });
  }

  if (!orderId || !stars || !text) return j(400, { error: "missing fields" });

  // must be a real, paid order — reviews are tied to purchases only
  const [meta, unlocked] = await Promise.all([getJSON(`meta_${orderId}`), getJSON(`unlocked_${orderId}`)]);
  const paid = !!unlocked || (meta && meta.source === "create");
  if (!meta || !paid) return j(403, { error: "review requires a completed order" });
  if (meta.reviewed) return j(200, { ok: true, already: true });

  // display name: "First L."
  const parts = name.split(/\s+/).filter(Boolean);
  const display = parts.length ? parts[0] + (parts[1] ? " " + parts[1][0].toUpperCase() + "." : "") : "Verified customer";

  const photoKey = photoB64 ? await savePhoto(event, orderId + ".jpg", photoB64) : null;
  const rec = { orderId, stars, text, name: display, occasion: meta.rel || null, country: meta.country || null,
    verified: true, photo: photoKey, ts: Date.now() };
  const cmds = [
    ["LPUSH", "reviews_all", JSON.stringify(rec)],
    ["LTRIM", "reviews_all", "0", "1999"]
  ];
  if (permission && stars >= 4) {
    cmds.push(["LPUSH", "reviews_public", JSON.stringify(rec)], ["LTRIM", "reviews_public", "0", "499"]);
  }
  await redis(cmds);
  await mergeMeta(orderId, { reviewed: true, review_stars: stars });
  return j(200, { ok: true, published: permission && stars >= 4 });
};
function j(s, b) { return { statusCode: s, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }; }
