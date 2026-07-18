exports.handler = async (event) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "No order ID" };

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
    message   ? "Message: " + message : ""
  ].filter(Boolean).join(". ");

  async function save(id, data) {
    // Use pipeline API to handle large values (audio base64 can be 1MB+)
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", `song_${id}`, JSON.stringify(data), "EX", "86400"]])
    });
    return res.ok;
  }

  try {
    await save(orderId, { status: "processing", stage: "writing", created: Date.now() });

    // Step 1: Claude writes lyrics
    if (!ANTHROPIC_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1500,
        messages: [{ role: "user", content: `Write a deeply personal love song.

Story: ${story}
Genre: ${genre}
Language: ${language}
Voice: ${voice}
Occasion: ${occasion}

Return ONLY valid JSON:
{"song_title":"...","song_meta":"For ${songFor} - ${occasion} - ${genre}","music_style":"${genre} song, ${voice.toLowerCase()} vocals, 70 BPM, emotional and personal","lyrics":"[Verse 1]\\n[4 short singable lines]\\n\\n[Chorus]\\n[4 lines - include the name]\\n\\n[Verse 2]\\n[4 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Bridge]\\n[3 emotional lines]\\n\\n[Final Chorus]\\n[4 lines]"}` }]
      })
    });
    const cdRaw = await cr.text();
    let cd;
    try { cd = JSON.parse(cdRaw); } catch(e) { throw new Error("Claude parse error: " + cdRaw.slice(0,100)); }
    if (cd.error) throw new Error("Claude API error: " + cd.error.message);
    if (!cd.content || !cd.content[0]) throw new Error("Claude returned no content: " + JSON.stringify(cd).slice(0,200));

    let song;
    try {
      song = JSON.parse(cd.content[0].text.replace(/```json|```/g, "").trim());
    } catch(e) {
      throw new Error("Song JSON parse error: " + cd.content[0].text.slice(0,100));
    }

    await save(orderId, { status: "processing", stage: "composing", song_title: song.song_title, lyrics: song.lyrics });

    // Step 2: Lyria generates audio
    if (!GEMINI_KEY) throw new Error("Missing GEMINI_API_KEY");
    const lyriaPrompt = song.music_style + "\n\nLyrics:\n" + song.lyrics;
    const lr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }], generationConfig: { responseModalities: ["AUDIO"] } }) }
    );
    const ldRaw = await lr.text();
    let ld;
    try { ld = JSON.parse(ldRaw); } catch(e) { throw new Error("Lyria parse error: " + ldRaw.slice(0,100)); }
    if (ld.error) throw new Error("Lyria error: " + ld.error.message);

    const parts = (ld.candidates || [{}])[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes("audio"));
    if (!audioPart) throw new Error(`No audio from Lyria. Candidates: ${JSON.stringify(ld.candidates||[]).slice(0,200)}`);

    // Step 3: Save completed song
    await save(orderId, {
      status: "done",
      song_title: song.song_title,
      song_meta: song.song_meta || `For ${songFor} - ${occasion} - ${genre}`,
      lyrics: song.lyrics,
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    });

    // Step 4: Email
    if (email && process.env.POSTMARK_SERVER_TOKEN) {
      const siteUrl = process.env.SITE_URL || "https://storysound.netlify.app";
      await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN },
        body: JSON.stringify({
          From: process.env.FROM_EMAIL || "songs@storysound.ai",
          To: email,
          Subject: `"${song.song_title}" is ready! 🎵`,
          HtmlBody: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">"${song.song_title}"</h1><p style="color:#7A6A5A;margin:12px 0 24px">Your song is ready!</p><a href="${siteUrl}/success?order_id=${orderId}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">🎵 Listen Now</a></div>`,
          TextBody: `"${song.song_title}" is ready!\n\n${siteUrl}/success?order_id=${orderId}`
        })
      });
    }

    return { statusCode: 200, body: "Done: " + song.song_title };

  } catch(err) {
    console.error("Generation error:", err.message);
    await save(orderId, { status: "error", error: err.message });
    return { statusCode: 500, body: err.message };
  }
};
