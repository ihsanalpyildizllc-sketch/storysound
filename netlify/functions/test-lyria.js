exports.handler = async (event) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 400, body: JSON.stringify({ error: "Missing Anthropic key" }) };

  const body = event.body ? JSON.parse(event.body) : {};
  const { names, story, genre, mood, vocals, forWhom, claude_only } = body;

  try {
    // Claude writes full song lyrics
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1500,
        messages: [{ role: "user", content: `Write a full emotional R&B love song in Daniel Caesar style.\nFor: ${names || forWhom || "her"}\nStory: ${story || "A beautiful love story"}\nGenre: ${genre || "Emotional R&B 70 BPM"}\n\nReturn ONLY valid JSON:\n{"song_title":"...","music_style":"Emotional R&B ballad 70 BPM, warm piano chords, soulful male vocals with rich reverb, soft acoustic guitar, subtle strings. Intimate and vulnerable.","lyrics":"[Verse 1]\\n[4 short singable lines]\\n\\n[Pre-Chorus]\\n[2 lines]\\n\\n[Chorus]\\n[4 lines — include the name]\\n\\n[Verse 2]\\n[4 lines]\\n\\n[Pre-Chorus]\\n[2 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Bridge]\\n[3 lines — apology, future, nickname]\\n\\n[Final Chorus]\\n[4 lines]"}` }]
      })
    });
    const cd = await cr.json();
    const song = JSON.parse(cd.content[0].text.replace(/```json|```/g,"").trim());

    // If claude_only flag, return just lyrics (browser will call Lyria directly)
    if (claude_only) {
      return { statusCode: 200, body: JSON.stringify({
        claude_ok: true,
        song_title: song.song_title,
        music_style: song.music_style,
        lyrics: song.lyrics
      })};
    }

    // Otherwise call Lyria Clip (30s, within timeout)
    if (!GEMINI_KEY) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, error: "No Gemini key" }) };

    const lyriaPrompt = `${song.music_style}\n\nLyrics:\n${song.lyrics}`;
    const lr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }], generationConfig: { responseModalities: ["AUDIO"] } }) }
    );
    const lyriaText = await lr.text();
    let ld; try { ld = JSON.parse(lyriaText); } catch(e) { return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, parse_error: lyriaText.substring(0,200) }) }; }
    if (ld.error) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, lyria_error: ld.error.message }) };
    const parts = (ld.candidates?.[0]?.content?.parts) || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes("audio"));
    if (!audioPart) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, no_audio: true, parts_count: parts.length }) };
    return { statusCode: 200, body: JSON.stringify({ claude_ok: true, lyria_ok: true, song_title: song.song_title, lyrics: song.lyrics, audio_mime: audioPart.inlineData.mimeType, audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024), audio_b64: audioPart.inlineData.data }) };
  } catch(e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};