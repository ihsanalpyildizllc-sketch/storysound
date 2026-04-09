exports.handler = async () => {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const results = { anthropic: false, gemini: false, lyria_accessible: false };

  // Test Anthropic
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'say ok' }] })
    });
    const d = await r.json();
    results.anthropic = !!d.content;
  } catch(e) { results.anthropic_error = e.message; }

  // Test Gemini/Lyria access (model list - fast)
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}&pageSize=50`);
    const d = await r.json();
    results.gemini = !d.error;
    if (d.models) {
      const lyria = d.models.filter(m => m.name.includes('lyria'));
      results.lyria_models = lyria.map(m => m.name);
      results.lyria_accessible = lyria.length > 0;
    }
    if (d.error) results.gemini_error = d.error.message;
  } catch(e) { results.gemini_error = e.message; }

  return {
    statusCode: 200,
    body: JSON.stringify(results)
  };
};
