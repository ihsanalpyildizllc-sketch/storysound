exports.handler = async (event) => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!GEMINI_KEY || !ANTHROPIC_KEY) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing API keys' }) };
  }

  try {
    // Step 1: Claude writes the song
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Write a short indie folk love song for Sofia & Marco who met at a Portland farmers market in 2018. He left his number on the bottom of a ceramic mug. She almost missed it doing dishes. He proposed 2 years later with a ring inside a handmade bowl at the same stall. They have a dog named Luna and honeymooned in Lisbon.

Return ONLY valid JSON:
{"song_title":"...","lyria_prompt":"Indie folk ballad at 85 BPM, fingerpicked acoustic guitar, warm male vocals, subtle strings, nostalgic romantic mood, verse-chorus-bridge structure, gentle fade ending","lyrics":"[4-line verse]\\n\\n[4-line chorus]\\n\\n[4-line verse 2]\\n\\n[bridge]"}`
        }]
      })
    });

    const cData = await claudeRes.json();
    const song = JSON.parse(cData.content[0].text.replace(/```json|```/g, '').trim());

    // Step 2: Lyria generates audio
    const lyriaRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: song.lyria_prompt }] }],
          generationConfig: { responseModalities: ['AUDIO', 'TEXT'] }
        })
      }
    );

    const lData = await lyriaRes.json();

    if (lData.error) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          claude_ok: true,
          song_title: song.song_title,
          lyrics: song.lyrics,
          lyria_error: lData.error.message,
          lyria_status: lData.error.code
        })
      };
    }

    const parts = lData.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes('audio'));

    if (!audioPart) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          claude_ok: true,
          song_title: song.song_title,
          lyria_response: JSON.stringify(lData).substring(0, 500)
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        claude_ok: true,
        lyria_ok: true,
        song_title: song.song_title,
        lyrics: song.lyrics,
        audio_mime: audioPart.inlineData.mimeType,
        audio_size_kb: Math.round(audioPart.inlineData.data.length * 0.75 / 1024),
        audio_b64: audioPart.inlineData.data.substring(0, 100) + '...[truncated]'
      })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
