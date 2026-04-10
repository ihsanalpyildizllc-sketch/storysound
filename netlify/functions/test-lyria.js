exports.handler = async (event) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!GEMINI_KEY || !ANTHROPIC_KEY) return { statusCode: 400, body: JSON.stringify({ error: "Missing keys" }) };

  const body = event.body ? JSON.parse(event.body) : {};
  const { names, story, genre, mood, vocals, forWhom } = body;

  try {
    // Step 1: Claude writes song
    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 1200,
        messages: [{ role: "user", content: `Write an emotional R&B love song.\nFor: ${names || forWhom || "her"}\nStory: ${story || "A beautiful love story"}\nGenre: ${genre || "Emotional R&B"}\n\nReturn ONLY valid JSON:\n{"song_title":"...","lyria_prompt":"Emotional R&B ballad at 70 BPM. Warm piano, soulful male vocals with reverb, soft guitar, building strings. Vulnerable intimate verses, powerful emotional chorus, cinematic production.","lyrics":"VERSE 1\\n[4 lines]\\n\\nCHORUS\\n[4 lines]\\n\\nVERSE 2\\n[4 lines]\\n\\nCHORUS\\n[4 lines]\\n\\nBRIDGE\\n[3 lines]\\n\\nFINAL CHORUS\\n[4 lines]"}` }]
      })
    });
    const cd = await cr.json();
    const song = JSON.parse(cd.content[0].text.replace(/```json|```/g,"").trim());

    // Step 2: Lyria 3 Clip - using Interactions API format per Google docs
    const lyriaUrl = `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent?key=${GEMINI_KEY}`;
    
    const lyriaBody = {
      contents: [
        {
          role: "user",
          parts: [{ text: song.lyria_prompt }]
        }
      ],
      generationConfig: {
        responseModalities: ["AUDIO"]
      }
    };

    const lr = await fetch(lyriaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lyriaBody)
    });

    const lyriaText = await lr.text();
    let ld;
    try { ld = JSON.parse(lyriaText); } catch(e) { return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, parse_error: lyriaText.substring(0,300) }) }; }

    if (ld.error) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, song_title: song.song_title, lyrics: song.lyrics, lyria_error: ld.error.message, lyria_status: ld.error.code }) };

    // Log full structure to find audio
    const candidates = ld.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];
    
    const allPartTypes = parts.map(p => Object.keys(p).join(","));
    
    const audioPart = parts.find(p => p.inlineData && (p.inlineData.mimeType || "").includes("audio"));
    const textPart = parts.find(p => p.text);

    if (!audioPart) {
      return { statusCode: 200, body: JSON.stringify({
        claude_ok: true, song_title: song.song_title, lyrics: song.lyrics,
        no_audio: true,
        debug_parts_count: parts.length,
        debug_part_types: allPartTypes,
        debug_text: textPart ? textPart.text.substring(0,200) : null,
        debug_first_part: parts[0] ? JSON.stringify(parts[0]).substring(0,300) : null
      })};
    }

    return { statusCode: 200, body: JSON.stringify({
      claude_ok: true, lyria_ok: true,
      song_title: song.song_title, lyrics: song.lyrics,
      audio_mime: audioPart.inlineData.mimeType,
      audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
      audio_b64: audioPart.inlineData.data
    })};

  } catch(e) { return { statusCode: 500, body: JSON.stringify({ error: e.message, stack: e.stack }) }; }
};