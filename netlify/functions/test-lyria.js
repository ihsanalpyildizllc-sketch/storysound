exports.handler = async (event) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!GEMINI_KEY || !ANTHROPIC_KEY) return { statusCode: 400, body: JSON.stringify({ error: "Missing keys" }) };

  const body = event.body ? JSON.parse(event.body) : {};
  const { names, story, genre, mood, vocals, forWhom } = body;

  try {
    // Step 1: Claude writes the lyrics
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1200,
        messages: [{ role: "user", content: `You are a professional songwriter. Write a deeply personal emotional love song.
For: ${names || forWhom || "her"}
Story: ${story || "A beautiful love story"}
Genre: ${genre || "Emotional R&B"}

Write short singable lyrics (max 4 lines per section, keep it tight for a 30-second clip).
Return ONLY valid JSON:
{"song_title":"...","music_style":"Emotional R&B ballad at 70 BPM. Warm piano chords, soulful male vocals with rich reverb, soft acoustic guitar. Intimate vulnerable verses building to emotional chorus.","lyrics":"[Verse]\n[line 1]\n[line 2]\n[line 3]\n[line 4]\n\n[Chorus]\n[line 1]\n[line 2]\n[line 3]\n[line 4]\n\n[Bridge]\n[line 1]\n[line 2]"}` }]
      })
    });
    const cd = await cr.json();
    const song = JSON.parse(cd.content[0].text.replace(/```json|```/g,"").trim());

    // Step 2: Build the Lyria prompt with lyrics embedded
    // Google docs format: style description + "Lyrics:" + actual lyrics
    const lyriaPrompt = `${song.music_style}

Lyrics:
${song.lyrics}`;

    // Step 3: Call Lyria with lyrics in prompt
    const lr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: lyriaPrompt }] }],
          generationConfig: { responseModalities: ["AUDIO"] }
        })
      }
    );

    const lyriaText = await lr.text();
    let ld;
    try { ld = JSON.parse(lyriaText); } catch(e) {
      return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, parse_error: lyriaText.substring(0,200) }) };
    }

    if (ld.error) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, lyria_error: ld.error.message }) };

    const parts = (ld.candidates?.[0]?.content?.parts) || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes("audio"));

    if (!audioPart) {
      return { statusCode: 200, body: JSON.stringify({
        claude_ok: true, song_title: song.song_title, lyrics: song.lyrics,
        no_audio: true, parts_count: parts.length,
        lyria_prompt_used: lyriaPrompt.substring(0, 300)
      })};
    }

    return { statusCode: 200, body: JSON.stringify({
      claude_ok: true, lyria_ok: true,
      song_title: song.song_title,
      lyrics: song.lyrics,
      lyria_prompt_used: lyriaPrompt.substring(0, 200),
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    })};

  } catch(e) { return { statusCode: 500, body: JSON.stringify({ error: e.message }) }; }
};