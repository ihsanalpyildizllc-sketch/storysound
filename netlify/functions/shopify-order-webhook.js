const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  // Verify it's a POST from Shopify
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const NETLIFY_SITE_ID = "14e2b75e-7529-4781-a013-1965699a901e";
  const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || "nfp_PZx5LMDX1YTKVzqdxgZQvK87NABitKznbd21";

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "Missing order ID" };

  // Extract story data from order attributes
  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  const songFor = attrs["Song For"] || order.billing_address?.first_name || "them";
  const occasion = attrs["Occasion"] || "Anniversary";
  const genre = attrs["Genre"] || "Pop";
  const language = attrs["Language"] || "English";
  const voice = attrs["Singer Voice"] || "Male";
  const qualities = attrs["Their Qualities"] || "";
  const memories = attrs["Memories"] || "";
  const message = attrs["Special Message"] || "";
  const email = attrs["Customer Email"] || order.email || "";

  const story = [
    songFor ? `Song for: ${songFor}` : "",
    occasion ? `Occasion: ${occasion}` : "",
    qualities ? `Their qualities: ${qualities}` : "",
    memories ? `Memories: ${memories}` : "",
    message ? `Special message: ${message}` : ""
  ].filter(Boolean).join(". ");

  // Store as processing
  const store = getStore({ name: "songs", siteID: NETLIFY_SITE_ID, token: NETLIFY_TOKEN });
  await store.setJSON(orderId, { status: "processing", created: Date.now() });

  try {
    // Step 1: Claude writes lyrics
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1500,
        messages: [{ role: "user", content: `You are a professional songwriter. Write a deeply personal love song.
Story: ${story}
Genre: ${genre}
Language: ${language}
Voice: ${voice}
Occasion: ${occasion}

Return ONLY valid JSON:
{"song_title":"...","song_meta":"For ${songFor} · ${occasion} · ${genre}","music_style":"${genre} song at 75 BPM, ${voice.toLowerCase()} vocals, emotional and personal","lyrics":"[Verse 1]\n[4 lines]\n\n[Chorus]\n[4 lines]\n\n[Verse 2]\n[4 lines]\n\n[Chorus]\n[4 lines]\n\n[Bridge]\n[3 lines]\n\n[Final Chorus]\n[4 lines]"}` }]
      })
    });
    const cd = await cr.json();
    const song = JSON.parse(cd.content[0].text.replace(/\`\`\`json|\`\`\`/g,"").trim());

    // Update status
    await store.setJSON(orderId, { status: "processing", stage: "lyria", song_title: song.song_title, lyrics: song.lyrics });

    // Step 2: Lyria generates audio
    const lyriaPrompt = `${song.music_style}\n\nLyrics:\n${song.lyrics}`;
    const lr = await fetch(
      \`https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=\${GEMINI_KEY}\`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }], generationConfig: { responseModalities: ["AUDIO"] } }) }
    );
    const ld = await lr.json();
    if (ld.error) throw new Error(ld.error.message);

    const parts = ld.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes("audio"));
    if (!audioPart) throw new Error("No audio from Lyria");

    // Store completed song
    await store.setJSON(orderId, {
      status: "done",
      song_title: song.song_title,
      song_meta: song.song_meta || \`For \${songFor} · \${occasion} · \${genre}\`,
      lyrics: song.lyrics,
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    });

    // Send email if we have one
    if (email && process.env.POSTMARK_SERVER_TOKEN) {
      const { ServerClient } = require("postmark");
      const postmark = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
      const firstName = songFor.split(" ")[0] || "there";
      await postmark.sendEmail({
        From: process.env.FROM_EMAIL || "songs@storysound.ai",
        To: email,
        Subject: \`🎵 "\${song.song_title}" is ready!\`,
        HtmlBody: \`<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#FAF7F2">
          <h1 style="font-size:28px;color:#0F0A06;font-style:italic">"&{song.song_title}"</h1>
          <p style="color:#7A6A5A;font-size:15px;margin:12px 0 20px">Your custom song is ready! Tap below to listen, download, and share.</p>
          <a href="\${process.env.SITE_URL}/success?order_id=\${orderId}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;margin-bottom:20px">🎵 Listen to Your Song</a>
          <div style="background:#fff;border-radius:12px;padding:16px;border:1px solid rgba(0,0,0,0.08)">
            <p style="font-size:12px;color:#7A6A5A;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px">Lyrics</p>
            <pre style="font-family:Georgia,serif;font-size:14px;color:#2C1F14;line-height:2;white-space:pre-wrap;font-style:italic">\${song.lyrics}</pre>
          </div>
          <p style="color:#7A6A5A;font-size:12px;margin-top:20px">Not in love with your song? Reply and we'll redo it. — StorySound</p>
        </div>\`,
        Attachments: [{
          Name: song.song_title.replace(/[^a-z0-9]/gi,"_") + ".mp3",
          Content: audioPart.inlineData.data,
          ContentType: audioPart.inlineData.mimeType
        }]
      });
    }

    return { statusCode: 200, body: "Song generated and delivered" };

  } catch(err) {
    await store.setJSON(orderId, { status: "error", error: err.message });
    return { statusCode: 500, body: err.message };
  }
};