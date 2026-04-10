const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!GEMINI_KEY || !ANTHROPIC_KEY) return { statusCode: 400, body: "Missing keys" };

  const body = event.body ? JSON.parse(event.body) : {};
  const { jobId, names, story, genre, forWhom } = body;
  if (!jobId) return { statusCode: 400, body: "Missing jobId" };

  // Explicit Blobs config
  const store = getStore({
    name: "songs",
    siteID: "14e2b75e-7529-4781-a013-1965699a901e",
    token: "nfp_PZx5LMDX1YTKVzqdxgZQvK87NABitKznbd21"
  });

  try {
    await store.setJSON(jobId, { status: "processing", created: Date.now() });

    // Claude writes lyrics
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1500,
        messages: [{ role: "user", content: `Write a full 2-minute emotional R&B love song in Daniel Caesar style.\nFor: ${names || forWhom}\nStory: ${story}\nReturn ONLY valid JSON:\n{"song_title":"...","music_style":"Emotional R&B ballad 70 BPM warm piano soulful male vocals reverb soft guitar strings 2 minutes","lyrics":"[Verse 1]\\n[4 short singable lines]\\n\\n[Pre-Chorus]\\n[2 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Verse 2]\\n[4 lines]\\n\\n[Pre-Chorus]\\n[2 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Bridge]\\n[3 lines]\\n\\n[Final Chorus]\\n[4 lines]"}`  }]
      })
    });
    const cd = await cr.json();
    const song = JSON.parse(cd.content[0].text.replace(/```json|```/g,"").trim());
    await store.setJSON(jobId, { status: "processing", stage: "lyria", song_title: song.song_title, lyrics: song.lyrics });

    // Lyria 3 Pro with full lyrics
    const lyriaPrompt = `Create a 2-minute ${song.music_style}\n\nLyrics:\n${song.lyrics}`;
    const lr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }], generationConfig: { responseModalities: ["AUDIO"] } }) }
    );
    const ld = await lr.json();
    if (ld.error) {
      await store.setJSON(jobId, { status: "error", error: ld.error.message, song_title: song.song_title, lyrics: song.lyrics });
      return { statusCode: 200, body: "Lyria error" };
    }
    const parts = ld.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes("audio"));
    if (!audioPart) {
      await store.setJSON(jobId, { status: "error", error: "No audio from Lyria (parts=" + parts.length + ")", song_title: song.song_title, lyrics: song.lyrics });
      return { statusCode: 200, body: "No audio" };
    }
    await store.setJSON(jobId, {
      status: "done",
      song_title: song.song_title, lyrics: song.lyrics,
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    });
    return { statusCode: 200, body: "Done!" };
  } catch(e) {
    try { await store.setJSON(jobId, { status: "error", error: e.message }); } catch(_) {}
    return { statusCode: 500, body: e.message };
  }
};