exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const body = JSON.parse(event.body || "{}");
  const jobId = "song_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);

  // Fire background function
  const bgUrl = process.env.URL || process.env.SITE_URL || "https://storysound.netlify.app";
  
  fetch(`${bgUrl}/.netlify/functions/generate-song-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, jobId })
  }).catch(e => console.error("BG trigger error:", e));

  return {
    statusCode: 200,
    body: JSON.stringify({ jobId, message: "Song generation started" })
  };
};