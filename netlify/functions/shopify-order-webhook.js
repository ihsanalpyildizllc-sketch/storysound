const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "Missing order ID" };

  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  const songFor   = attrs["Song For"] || "them";
  const occasion  = attrs["Occasion"] || "Anniversary";
  const genre     = attrs["Genre"] || "Pop";
  const language  = attrs["Language"] || "English";
  const voice     = attrs["Singer Voice"] || "Male";
  const qualities = attrs["Their Qualities"] || "";
  const memories  = attrs["Memories"] || "";
  const message   = attrs["Special Message"] || "";
  const email     = attrs["Customer Email"] || order.email || "";

  const story = [
    "Song for: " + songFor,
    occasion  ? "Occasion: " + occasion : "",
    qualities ? "Their qualities: " + qualities : "",
    memories  ? "Memories: " + memories : "",
    message   ? "Special message: " + message : ""
  ].filter(Boolean).join(". ");

  function getBlobs() {
    try {
      return getStore("songs");
    } catch(e) {
      return getStore({
        name: "songs",
        siteID: process.env.NETLIFY_SITE_ID || "14e2b75e-7529-4781-a013-1965699a901e",
        token: process.env.NETLIFY_AUTH_TOKEN
      });
    }
  }

  const store = getBlobs();

  try {
    await store.setJSON(orderId, { status: "processing", created: Date.now() });
  } catch(e) {
    console.error("Blobs init error:", e.message);
  }

  try {
    // Step 1: Claude writes lyrics
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1500,
        messages: [{ role: "user", content: "Write a deeply personal love song.\n\nStory: " + story + "\nGenre: " + genre + "\nLanguage: " + language + "\nVoice: " + voice + "\nOccasion: " + occasion + "\n\nReturn ONLY valid JSON:\n{\"song_title\":\"...\",\"song_meta\":\"For " + songFor + " · " + occasion + " · " + genre + "\",\"music_style\":\"" + genre + " song, " + voice.toLowerCase() + " vocals, 70 BPM, emotional\",\"lyrics\":\"[Verse 1]\\n[4 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Verse 2]\\n[4 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Bridge]\\n[3 lines]\\n\\n[Final Chorus]\\n[4 lines]\"}" }]
      })
    });
    const claudeData = await claudeRes.json();
    const song = JSON.parse(claudeData.content[0].text.replace(/```json|```/g, "").trim());

    await store.setJSON(orderId, { status: "processing", stage: "composing", song_title: song.song_title, lyrics: song.lyrics });

    // Step 2: Lyria generates audio
    const lyriaPrompt = song.music_style + "\n\nLyrics:\n" + song.lyrics;
    const lyriaRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=" + GEMINI_KEY,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }], generationConfig: { responseModalities: ["AUDIO"] } }) }
    );
    const lyriaData = await lyriaRes.json();
    if (lyriaData.error) throw new Error(lyriaData.error.message);

    const parts = (lyriaData.candidates || [{}])[0].content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes("audio"));
    if (!audioPart) throw new Error("No audio from Lyria");

    // Step 3: Store completed song
    await store.setJSON(orderId, {
      status: "done",
      song_title: song.song_title,
      song_meta: song.song_meta,
      lyrics: song.lyrics,
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    });

    // Step 4: Send email if Postmark configured
    if (email && process.env.POSTMARK_SERVER_TOKEN) {
      try {
        const siteUrl = process.env.SITE_URL || "https://storysound.netlify.app";
        await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN },
          body: JSON.stringify({
            From: process.env.FROM_EMAIL || "songs@storysound.ai",
            To: email,
            Subject: "Your song \"" + song.song_title + "\" is ready! 🎵",
            HtmlBody: "<div style='font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#FAF7F2'><h1 style='font-size:28px;color:#0F0A06;font-style:italic'>\"" + song.song_title + "\"</h1><p style='color:#7A6A5A;font-size:15px;margin:12px 0 24px'>Your song is ready! Click below to listen and unlock the full experience.</p><a href='" + siteUrl + "/success?order_id=" + orderId + "' style='display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;margin-bottom:24px'>🎵 Listen to My Song</a></div>",
            TextBody: "Your song \"" + song.song_title + "\" is ready!\n\nListen: " + siteUrl + "/success?order_id=" + orderId
          })
        });
      } catch(emailErr) { console.error("Email error:", emailErr.message); }
    }

    return { statusCode: 200, body: "Song generated: " + song.song_title };

  } catch(err) {
    console.error("Error:", err.message);
    try { await store.setJSON(orderId, { status: "error", error: err.message }); } catch(e) {}
    return { statusCode: 500, body: err.message };
  }
};