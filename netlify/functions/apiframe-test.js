exports.handler = async (event) => {
  const APIFRAME_KEY = process.env.APIFRAME_API_KEY;
  if (!APIFRAME_KEY) return { statusCode: 400, body: 'No API key' };

  const action = event.queryStringParameters?.action || 'account';
  const jobId  = event.queryStringParameters?.jobId;

  if (action === 'poll' && jobId) {
    const r = await fetch(`https://api.apiframe.ai/v2/jobs/${jobId}`, {
      headers: { 'X-API-Key': APIFRAME_KEY }
    });
    const text = await r.text();
    return { statusCode: 200, body: `STATUS: ${r.status}\n${text.slice(0,2000)}` };
  }

  if (action === 'account') {
    const r = await fetch('https://api.apiframe.ai/v2/me', {
      headers: { 'X-API-Key': APIFRAME_KEY }
    });
    const text = await r.text();
    return { statusCode: 200, body: `Account check - STATUS: ${r.status}\nKey: ${APIFRAME_KEY.slice(0,8)}...\n${text.slice(0,1000)}` };
  }

  if (action === 'generate') {
    const r = await fetch('https://api.apiframe.ai/v2/music/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': APIFRAME_KEY },
      body: JSON.stringify({
        model: 'suno',
        prompt: 'Test lyrics\nLa la la\nTest song',
        sunoParams: { custom_mode: true, style: 'pop', title: 'Test', instrumental: false }
      })
    });
    const text = await r.text();
    return { statusCode: 200, body: `Generate - STATUS: ${r.status}\n${text.slice(0,2000)}` };
  }

  return { statusCode: 200, body: 'Use ?action=account|generate|poll&jobId=...' };
};
