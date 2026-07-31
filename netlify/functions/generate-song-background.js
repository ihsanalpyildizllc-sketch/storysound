exports.handler = async (event) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const APIFRAME_KEY  = process.env.APIFRAME_API_KEY;
  const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Invalid JSON' }; }
  const orderId = String(order.id || '');
  if (!orderId) return { statusCode: 400, body: 'No order ID' };

  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });
  const songFor   = attrs['Song For']       || 'them';
  const occasion  = attrs['Occasion']       || 'Anniversary';
  const genre     = attrs['Genre']          || 'Pop';
  const language  = attrs['Language']       || 'English';
  const voice     = attrs['Singer Voice']   || 'Male';
  const qualities = attrs['Their Qualities']|| '';
  const memories  = attrs['Memories']      || '';
  const message   = attrs['Special Message']|| '';
  const email     = attrs['Customer Email'] || order.email || '';

  const story = [
    'Song for: ' + songFor,
    occasion  ? 'Occasion: '  + occasion  : '',
    qualities ? 'Their qualities: ' + qualities : '',
    memories  ? 'Memories: '  + memories  : '',
    message   ? 'Message: '   + message   : ''
  ].filter(Boolean).join('. ');

  async function save(id, data) {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', `song_${id}`, JSON.stringify(data), 'EX', '86400']])
    });
    return res.ok;
  }

  try {
    await save(orderId, { status: 'processing', stage: 'writing', created: Date.now() });

    // ── Step 1: Claude writes lyrics ──────────────────────────────────────────
    if (!ANTHROPIC_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
    const cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1500,
        messages: [{ role: 'user', content: `Write a deeply personal love song.

Story: ${story}
Genre: ${genre}
Language: ${language}
Voice: ${voice}
Occasion: ${occasion}

Return ONLY valid JSON (no markdown):
{"song_title":"...","song_meta":"For ${songFor} - ${occasion} - ${genre}","music_style":"${genre} song, ${voice.toLowerCase()} vocals, emotional and deeply personal, radio quality","lyrics":"[Verse 1]\\n[4 short singable lines]\\n\\n[Chorus]\\n[4 memorable lines that include the name]\\n\\n[Verse 2]\\n[4 lines]\\n\\n[Chorus]\\n[4 lines]\\n\\n[Bridge]\\n[2-3 emotional lines]\\n\\n[Final Chorus]\\n[4 lines]"}` }]
      })
    });
    const cdRaw = await cr.text();
    let cd; try { cd = JSON.parse(cdRaw); } catch(e) { throw new Error('Claude parse error: ' + cdRaw.slice(0,100)); }
    if (cd.error) throw new Error('Claude API error: ' + cd.error.message);
    if (!cd.content?.[0]) throw new Error('Claude returned no content');

    let song;
    try { song = JSON.parse(cd.content[0].text.replace(/```json|```/g, '').trim()); }
    catch(e) { throw new Error('Song JSON parse error: ' + cd.content[0].text.slice(0,200)); }

    await save(orderId, { status: 'processing', stage: 'composing', song_title: song.song_title, lyrics: song.lyrics });

    // ── Step 2: Suno generates full song via Apiframe ─────────────────────────
    if (!APIFRAME_KEY) throw new Error('Missing APIFRAME_API_KEY');

    // Determine if key is v2 (afk_) or v1
    const isV2 = APIFRAME_KEY.startsWith('afk_');
    let taskId, audioUrl;

    if (isV2) {
      // Apiframe v2 endpoint
      const sr = await fetch('https://api.apiframe.ai/v2/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': APIFRAME_KEY },
        body: JSON.stringify({
          model: 'suno',
          prompt: song.music_style,
          sunoParams: {
            custom_mode: true,
            lyrics: song.lyrics,
            title: song.song_title,
            instrumental: false,
            model_version: 'V5_5'
          }
        })
      });
      const sd = await sr.json();
      if (!sr.ok || sd.error) throw new Error('Suno v2 error: ' + (sd.error || JSON.stringify(sd).slice(0,200)));
      taskId = sd.id || sd.task_id;

      // Poll for completion (up to 5 minutes)
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pr = await fetch(`https://api.apiframe.ai/v2/jobs/${taskId}`, {
          headers: { 'X-API-Key': APIFRAME_KEY }
        });
        const pd = await pr.json();
        if (pd.status === 'finished' || pd.status === 'completed' || pd.status === 'succeeded') {
          // Get audio URL from result
          const output = pd.output || pd.result || pd;
          audioUrl = output?.songs?.[0]?.audio_url || output?.audio_url || output?.[0]?.audio_url || pd.audio_url;
          if (audioUrl) break;
        }
        if (pd.status === 'failed' || pd.status === 'error') {
          throw new Error('Suno generation failed: ' + JSON.stringify(pd).slice(0,200));
        }
      }
    } else {
      // Apiframe v1 endpoint
      const sr = await fetch('https://api.apiframe.pro/suno-imagine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': APIFRAME_KEY },
        body: JSON.stringify({
          prompt: song.music_style,
          lyrics: song.lyrics,
          custom_mode: true,
          title: song.song_title,
          model: 'chirp-v4'
        })
      });
      const sd = await sr.json();
      if (!sr.ok || sd.error) throw new Error('Suno v1 error: ' + (sd.error || JSON.stringify(sd).slice(0,200)));
      taskId = sd.task_id;

      // Poll v1
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pr = await fetch(`https://api.apiframe.pro/fetch/${taskId}`, {
          headers: { 'Authorization': APIFRAME_KEY }
        });
        const pd = await pr.json();
        if (pd.status === 'finished') {
          audioUrl = pd.songs?.[0]?.audio_url;
          if (audioUrl) break;
        }
        if (pd.status === 'error') throw new Error('Suno v1 failed: ' + JSON.stringify(pd).slice(0,200));
      }
    }

    if (!audioUrl) throw new Error('Suno timed out — no audio URL returned');

    // ── Step 3: Download the MP3 and store as base64 ──────────────────────────
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error('Failed to download audio: ' + audioResp.status);
    const audioBuffer = await audioResp.arrayBuffer();
    const audioB64 = Buffer.from(audioBuffer).toString('base64');
    const sizeKb = Math.round(audioBuffer.byteLength / 1024);

    await save(orderId, {
      status: 'done',
      song_title:   song.song_title,
      song_meta:    song.song_meta || `For ${songFor} - ${occasion} - ${genre}`,
      lyrics:       song.lyrics,
      audio_mime:   'audio/mpeg',
      audio_size_kb: sizeKb,
      audio_b64:    audioB64
    });

    // ── Step 4: Postmark email ────────────────────────────────────────────────
    if (email && process.env.POSTMARK_SERVER_TOKEN) {
      const siteUrl = process.env.SITE_URL || 'https://storysound.netlify.app';
      await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN },
        body: JSON.stringify({
          From: process.env.FROM_EMAIL || 'songs@storysound.ai',
          To: email,
          Subject: `"${song.song_title}" is ready! 🎵`,
          HtmlBody: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">"${song.song_title}"</h1><p style="color:#7A6A5A;margin:12px 0 24px">Your personalized song is ready to listen and download.</p><a href="${siteUrl}/.netlify/functions/song-page?orderId=${orderId}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">🎵 Listen & Download</a></div>`,
          TextBody: `"${song.song_title}" is ready!\n\n${siteUrl}/.netlify/functions/song-page?orderId=${orderId}`
        })
      });
    }

    return { statusCode: 200, body: 'Done: ' + song.song_title + ' (' + sizeKb + 'KB)' };

  } catch(err) {
    console.error('Generation error:', err.message);
    await save(orderId, { status: 'error', error: err.message });
    return { statusCode: 500, body: err.message };
  }
};
