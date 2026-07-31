exports.handler = async (event) => {
  const APIFRAME_KEY = process.env.APIFRAME_API_KEY;
  if (!APIFRAME_KEY) return { statusCode: 400, body: 'No API key' };

  const action = event.queryStringParameters?.action || 'generate';
  const jobId  = event.queryStringParameters?.jobId;

  if (action === 'poll' && jobId) {
    const r = await fetch(`https://api.apiframe.ai/v2/jobs/${jobId}`, {
      headers: { 'X-API-Key': APIFRAME_KEY }
    });
    const d = await r.json();
    return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify(d, null, 2) };
  }

  // Generate a short test song
  const r = await fetch('https://api.apiframe.ai/v2/music/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': APIFRAME_KEY },
    body: JSON.stringify({
      model: 'suno',
      prompt: '[Verse 1]\nTesting the song\nJust a quick test\nOne two three four\nWorks the best\n\n[Chorus]\nTest song test song\nLa la la la la',
      sunoParams: {
        custom_mode: true,
        style: 'pop song, male vocals',
        title: 'Test Song',
        instrumental: false,
        model_version: 'V4_5PLUS'
      }
    })
  });
  const d = await r.json();
  return { statusCode: r.status, headers: {'Content-Type':'application/json'}, body: JSON.stringify(d, null, 2) };
};
