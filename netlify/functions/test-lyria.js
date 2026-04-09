exports.handler = async () => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!GEMINI_KEY || !ANTHROPIC_KEY) return { statusCode: 400, body: JSON.stringify({ error: 'Missing API keys' }) };

  try {
    // Claude writes the song
    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        messages: [{ role: 'user', content: 'Give me a short indie folk music prompt for a 30-second clip. A couple met at a Portland farmers market. Just return the prompt text, nothing else, max 2 sentences.' }] })
    });
    const cd = await cr.json();
    const prompt = cd.content[0].text.trim();

    // Lyria 3 CLIP (30s, much faster than Pro)
    const lr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-clip-preview:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO','TEXT'] } }) }
    );
    const ld = await lr.json();
    if (ld.error) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, prompt, lyria_error: ld.error.message }) };

    const parts = ld.candidates?.[0]?.content?.parts || [];
    const audio = parts.find(p => p.inlineData?.mimeType?.includes('audio'));
    if (!audio) return { statusCode: 200, body: JSON.stringify({ claude_ok: true, prompt, no_audio: true, response: JSON.stringify(ld).substring(0,300) }) };

    return { statusCode: 200, body: JSON.stringify({
      claude_ok: true, lyria_ok: true, prompt,
      audio_mime: audio.inlineData.mimeType,
      audio_size_kb: Math.round(audio.inlineData.data.length * 0.75 / 1024),
      audio_b64: audio.inlineData.data
    })};
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
