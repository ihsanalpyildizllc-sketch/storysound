exports.handler = async (event) => {
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];
  
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const meta = session.metadata;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1200,
        messages: [{ role: 'user', content: `You are a professional songwriter. Create a custom song.
Names: ${meta.names}
Years: ${meta.years}
Story: ${meta.story}
Memories: ${meta.moments||'N/A'}
Genre: ${meta.genre}
Mood: ${meta.mood}
Style: ${meta.vocals==='vocals'?'with vocals':'instrumental'}
Return ONLY valid JSON:
{"song_title":"...","lyria_prompt":"4-sentence detailed music prompt for Lyria 3 Pro","lyrics":"VERSE 1\n[4 lines]\n\nCHORUS\n[4 lines]\n\nVERSE 2\n[4 lines]\n\nCHORUS\n[4 lines]\n\nBRIDGE\n[2 lines]\n\nFINAL CHORUS\n[4 lines]"}` }]
      })
    });
    const cData = await claudeRes.json();
    const songData = JSON.parse(cData.content[0].text.replace(/```json|```/g,'').trim());

    const lyriaRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: songData.lyria_prompt }] }], generationConfig: { responseModalities: ['AUDIO','TEXT'] } }) }
    );
    const lData = await lyriaRes.json();
    if (lData.error) throw new Error(lData.error.message);
    const parts = lData.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find(p => p.inlineData?.mimeType?.includes('audio'));
    if (!audioPart) throw new Error('No audio from Lyria');

    const { ServerClient } = require('postmark');
    const postmark = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
    const firstName = meta.names?.split('&')?.[0]?.trim() || 'there';
    await postmark.sendEmail({
      From: process.env.FROM_EMAIL || 'songs@storysound.ai',
      To: meta.email,
      Subject: `🎵 Your song "${songData.song_title}" is ready!`,
      HtmlBody: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px"><h1 style="font-size:28px;color:#1A1614">Your song is here, ${firstName} 🎵</h1><p style="color:#666;font-size:16px">We turned your love story into <strong>"${songData.song_title}"</strong> — ${meta.genre}, ${meta.mood.toLowerCase()} mood. The MP3 is attached.</p><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><h2 style="font-size:18px;color:#1A1614">Lyrics</h2><pre style="font-family:Georgia,serif;font-size:15px;color:#333;line-height:1.9;white-space:pre-wrap">${songData.lyrics}</pre><p style="color:#999;font-size:13px;margin-top:24px">Not in love with your song? Reply and we'll revise it free. — StorySound</p></div>`,
      Attachments: [{ Name: `${songData.song_title.replace(/[^a-z0-9]/gi,'_')}.mp3`, Content: audioPart.inlineData.data, ContentType: audioPart.inlineData.mimeType || 'audio/mpeg' }]
    });
    console.log('✅ Song delivered to:', meta.email);
  } catch (err) {
    console.error('Song gen error:', err.message);
    try {
      const { ServerClient } = require('postmark');
      const postmark = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
      await postmark.sendEmail({ From: process.env.FROM_EMAIL||'songs@storysound.ai', To: meta?.email, Subject: 'Your StorySound is being composed 🎵', TextBody: `Hi ${meta?.names?.split('&')?.[0]?.trim()||'there'},

Your song is being composed — you'll receive it within 15 minutes.

— StorySound` });
    } catch(e) {}
  }

  return { statusCode: 200, body: 'OK' };
};
