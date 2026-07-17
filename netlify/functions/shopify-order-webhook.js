const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const NETLIFY_SITE_ID = "14e2b75e-7529-4781-a013-1965699a901e";
  const NETLIFY_TOKEN = "nfp_PZx5LMDX1YTKVzqdxgZQvK87NABitKznbd21";

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const orderId = String(order.id || "test_" + Date.now());

  // Extract story from order note_attributes
  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  const songFor    = attrs["Song For"] || "them";
  const occasion   = attrs["Occasion"] || "Anniversary";
  const genre      = attrs["Genre"] || "Pop";
  const language   = attrs["Language"] || "English";
  const voice      = attrs["Singer Voice"] || "Male";
  const qualities  = attrs["Their Qualities"] || "";
  const memories   = attrs["Memories"] || "";
  const message    = attrs["Special Message"] || "";
  const email      = attrs["Customer Email"] || order.email || "";

  const story = [
    songFor   ? "Song for: " + songFor : "",
    occasion  ? "Occasion: " + occasion : "",
    qualities ? "Their qualities: " + qualities : "",
    memories  ? "Memories: " + memories : "",
    message   ? "Special message: " + message : ""
  ].filter(Boolean).join(". ");

  // Store as processing immediately
  const store = getStore({ name: "songs", siteID: NETLIFY_SITE_ID, token: NETLIFY_TOKEN });
  await store.setJSON(orderId, { status: "processing", created: Date.now() });

  try {
    // Step 1: Claude writes lyrics
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: "You are a professional songwriter. Write a deeply personal love song.\n\nStory: " + story + "\nGenre: " + genre + "\nLanguage: " + language + "\nVoice: " + voice + "\nOccasion: " + occasion + "\n\nReturn ONLY valid JSON:\n{\"song_title\":\"...\",\"song_meta\":\"For " + songFor + " - " + occasion + " - " + genre + "\",\"music_style\":\"" + genre + " ballad, " + voice.toLowerCase() + " vocals, emotional and personal, 70 BPM\",\"lyrics\":\"[Verse 1]\\n[4 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Verse 2]\\n[4 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Bridge]\\n[3 lines]\\n\\n[Final Chorus]\\n[4 lines]\"}"
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const song = JSON.parse(claudeData.content[0].text.replace(/```json|```/g, "").trim());

    // Update status with lyrics ready
    await store.setJSON(orderId, {
      status: "processing",
      stage: "composing",
      song_title: song.song_title,
      song_meta: song.song_meta,
      lyrics: song.lyrics
    });

    // Step 2: Lyria 3 Pro generates audio
    const lyriaPrompt = song.music_style + "\n\nLyrics:\n" + song.lyrics;

    const lyriaRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=" + GEMINI_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }],
          generationConfig: { responseModalities: ["AUDIO"] }
        })
      }
    );

    const lyriaData = await lyriaRes.json();
    if (lyriaData.error) throw new Error(lyriaData.error.message);

    const parts = (lyriaData.candidates || [{}])[0].content?.parts || [];
    const audioPart = parts.find(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.includes("audio"));

    if (!audioPart) throw new Error("No audio returned from Lyria");

    // Step 3: Save completed song to Blobs
    await store.setJSON(orderId, {
      status: "done",
      song_title: song.song_title,
      song_meta: song.song_meta || ("For " + songFor + " - " + occasion + " - " + genre),
      lyrics: song.lyrics,
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    });

    // Step 4: Send email if Postmark configured
    if (email && process.env.POSTMARK_SERVER_TOKEN) {
      try {
        const { ServerClient } = require("postmark");
        const postmark = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        const siteUrl = process.env.SITE_URL || "https://storysound.netlify.app";
        await postmark.sendEmail({
          From: process.env.FROM_EMAIL || "songs@storysound.ai",
          To: email,
          Subject: "Your song \"" + song.song_title + "\" is ready!",
          HtmlBody: "<div style='font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#FAF7F2'><h1 style='font-size:28px;color:#0F0A06;font-style:italic'>\"" + song.song_title + "\"</h1><p style='color:#7A6A5A;font-size:15px;margin:12px 0 20px'>Your custom song is ready! Tap below to listen.</p><a href='" + siteUrl + "/success?order_id=" + orderId + "' style='display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;margin-bottom:20px'>Listen to Your Song</a><p style='color:#7A6A5A;font-size:12px;margin-top:20px'>Not happy? Reply and we will redo it free. - StorySound</p></div>",
          TextBody: "Your song \"" + song.song_title + "\" is ready!\n\nListen here: " + siteUrl + "/success?order_id=" + orderId
        });
      } catch(emailErr) {
        console.error("Email error:", emailErr.message);
      }
    }

    return { statusCode: 200, body: "Song generated successfully for order " + orderId };

  } catch(err) {
    console.error("Generation error:", err.message);
    await store.setJSON(orderId, { status: "error", error: err.message });
    return { statusCode: 500, body: err.message };
  }
};
