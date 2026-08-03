exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const body = JSON.parse(event.body || "{}");
  const jobId = body.id || ("song_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  body.id = jobId;

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const country = event.headers["x-country"] || event.headers["X-Country"] || null;

  // seed meta + keep the payload for watchdog retries + index the order
  const attrs = {};
  (body.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });
  const meta = {
    source: body.source || "create2",
    email: body.email || attrs["Customer Email"] || "",
    name: attrs["Recipient Name"] || "",
    rel: attrs["Relationship"] || "",
    occasion: attrs["Occasion"] || "",
    genre: attrs["Genre"] || "",
    qualities: attrs["Their Qualities"] || "",
    memories: attrs["Memories"] || "",
    message: attrs["Special Message"] || "",
    story: attrs["_full_story"] || "",
    country, created: Date.now(), attempts: 0
  };
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["SET", `meta_${jobId}`, JSON.stringify(meta)],
        ["SET", `payload_${jobId}`, JSON.stringify(body), "EX", "172800"],
        ["LPUSH", "orders_index", jobId],
        ["LTRIM", "orders_index", "0", "4999"]
      ])
    });
  } catch (e) { console.log("meta seed failed:", e.message); }

  const bgUrl = process.env.URL || process.env.SITE_URL || "https://storysound.netlify.app";
  // MUST await: lambda freezes on return, killing un-awaited requests.
  // Background functions ack with 202 immediately, so this costs ~100ms.
  try {
    const bg = await fetch(`${bgUrl}/.netlify/functions/generate-song-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    console.log("BG trigger:", bg.status);
  } catch (e) { console.error("BG trigger error:", e.message); }

  return { statusCode: 200, body: JSON.stringify({ jobId, message: "Song generation started" }) };
};
