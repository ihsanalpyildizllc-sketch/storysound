exports.handler = async (event) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!GEMINI_KEY || !ANTHROPIC_KEY) return { statusCode: 400, body: JSON.stringify({ error: "Missing keys" }) };
  const body = event.body ? JSON.parse(event.body) : {};
  const { names, story, moments, genre, mood, vocals, years, forWhom } = body;
  try {
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1500,
        messages: [{ role: "user", content: `You are a professional songwriter. Write a deeply personal love song.
For: ${names || forWhom}
Years together: ${years || "unknown"}
Story: ${story}
Memories/qualities: ${moments || ""}
Genre: ${genre || "Emotional R&B"}
Mood: ${mood || "Romantic"}
Style: ${vocals === "instrumental" ? "Instrumental" : "With vocals"}

Return ONLY valid JSON:
{"song_title":"...","lyria_prompt":"4-sentence detailed music production prompt for Lyria 3 Pro","lyrics":"VERSE 1\n[4 lines]\n\nCHORUS\n[4 lines]\n\nVERSE 2\n[4 lines]\n\nCHORUS\n[4 lines]\n\nBRIDGE\n[3 lines]\n\nFINAL CHORUS\n[4 lines]"}` }] })
    });
    const cd = await cr.json();
    const song = JSON.parse(cd.content[0].text.replace(/```json|```/g,"").trim());
    const lr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent?key=${GEMINI_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: song.lyria_prompt }] }], generationConfig: { responseModalities: ["AUDIO","TEXT"] } })
    });
    const ld = await lr.json();
    if (ld.error) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, lyria_error: ld.error.message }) };
    const parts = ld.candidates?.[0]?.content?.parts || [];
    const audio = parts.find(p => p.inlineData?.mimeType?.includes("audio"));
    if (!audio) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, no_audio: true }) };
    return { statusCode: 200, body: JSON.stringify({ claude_ok: true, lyria_ok: true, song_title: song.song_title, lyrics: song.lyrics, audio_mime: audio.inlineData.mimeType, audio_size_kb: Math.round(audio.inlineData.data.length * 0.75 / 1024), audio_b64: audio.inlineData.data }) };
  } catch(e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};
