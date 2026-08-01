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
    // attempt counter (watchdog reads this to cap retries)
    await fetch(`${REDIS_URL}/pipeline`, { method:'POST',
      headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json' },
      body: JSON.stringify([['INCR', `attempts_${orderId}`], ['EXPIRE', `attempts_${orderId}`, '604800']]) }).catch(()=>{});
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
      // In v2 custom mode: prompt = lyrics, sunoParams.style = music style
      const vocalGender = voice.toLowerCase().includes('female') ? 'f' : 'm';
      const sr = await fetch('https://api.apiframe.ai/v2/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': APIFRAME_KEY },
        body: JSON.stringify({
          model: 'suno',
          prompt: song.lyrics,
          sunoParams: {
            custom_mode: true,
            style: song.music_style,
            title: song.song_title.slice(0, 80),
            instrumental: false,
            model_version: 'V5_5',
            vocal_gender: vocalGender
          }
        })
      });
      const sd = await sr.json();
      if (!sr.ok || sd.error) throw new Error('Suno v2 error: ' + (sd.error || JSON.stringify(sd).slice(0,200)));
      taskId = sd.jobId || sd.id || sd.task_id;

      // Poll for completion (up to 8 minutes, uppercase status in v2)
      for (let i = 0; i < 96; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pr = await fetch(`https://api.apiframe.ai/v2/jobs/${taskId}`, {
          headers: { 'X-API-Key': APIFRAME_KEY }
        });
        const pd = await pr.json();
        const jobStatus = (pd.status || '').toUpperCase();

        if (jobStatus === 'COMPLETED' || jobStatus === 'FINISHED' || jobStatus === 'SUCCEEDED') {
          // v2 result structure: pd.result contains the media output
          // v2 result: pd.result.tracks[0].audioUrl
          const tracks = pd.result?.tracks || pd.result?.songs || [];
          audioUrl = tracks[0]?.audioUrl || tracks[0]?.audio_url || tracks[0]?.url
                  || pd.result?.audioUrl || pd.result?.audio_url;
          if (audioUrl) break;
          throw new Error('Suno done but no audio URL. Result: ' + JSON.stringify(pd.result).slice(0,300));
        }
        if (jobStatus === 'FAILED' || jobStatus === 'ERROR') {
          throw new Error('Suno generation failed: ' + (pd.error || JSON.stringify(pd).slice(0,200)));
        }
        // Log progress every 30s
        if (i % 6 === 0) console.log('Suno progress:', pd.progress, '%', 'status:', pd.status);
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
    if (sizeKb < 500) throw new Error('QA gate: audio too small (' + sizeKb + 'KB) — refusing to deliver an empty file');

    await save(orderId, {
      status: 'done',
      song_title:   song.song_title,
      song_meta:    song.song_meta || `For ${songFor} - ${occasion} - ${genre}`,
      lyrics:       song.lyrics,
      audio_mime:   'audio/mpeg',
      audio_size_kb: sizeKb,
      audio_b64:    audioB64
    });

    // ── Step 3b: metrics + order meta + index ────────────────────────────────
    const source = order.source || 'create';
    const today = new Date().toISOString().slice(0,10);
    const dashCmds = [
      ['INCR', 'dash:songs:total'],
      ['INCR', `dash:songs:date:${today}`],
      ['EXPIRE', `dash:songs:date:${today}`, '2592000'],
      ['LPUSH', 'orders_index', orderId],
      ['LTRIM', 'orders_index', '0', '4999']
    ];
    // revenue only for pay-first orders; create2 revenue is recorded at unlock by the webhook
    if (source === 'create') dashCmds.push(['INCRBY', 'dash:revenue:total', '39']);
    await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(dashCmds)
    });

    // merge meta (attempts, recipient, size) without clobbering webhook-written fields
    try {
      const mres = await fetch(`${REDIS_URL}/pipeline`, { method:'POST',
        headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json' },
        body: JSON.stringify([['GET', `meta_${orderId}`], ['GET', `attempts_${orderId}`]]) });
      const mrows = await mres.json();
      let meta = {}; try { meta = JSON.parse(mrows[0]?.result || '{}') || {}; } catch(e){}
      const attempts = parseInt(mrows[1]?.result || '1', 10) || 1;
      Object.assign(meta, {
        source: meta.source || source,
        email: meta.email || email,
        name: meta.name || attrs['Recipient Name'] || songFor,
        rel:  meta.rel  || attrs['Relationship'] || '',
        genre: genre, title: song.song_title, sizeKb, attempts,
        created: meta.created || Date.now(), updated: Date.now()
      });
      // paid /create orders: song is permanent from day one
      if (source === 'create') {
        await fetch(`${REDIS_URL}/pipeline`, { method:'POST',
          headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json' },
          body: JSON.stringify([['PERSIST', `song_${orderId}`], ['SET', `meta_${orderId}`, JSON.stringify(Object.assign(meta,{persisted:true}))]]) });
      } else {
        // free preview: keep 7 days so the email link survives the weekend
        await fetch(`${REDIS_URL}/pipeline`, { method:'POST',
          headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json' },
          body: JSON.stringify([['EXPIRE', `song_${orderId}`, '604800'], ['SET', `meta_${orderId}`, JSON.stringify(meta)]]) });
      }
    } catch(e) { console.log('meta merge skipped:', e.message); }

    // ── Step 4: email (funnel-aware, status recorded for the watchdog) ───────
    if (email && process.env.POSTMARK_SERVER_TOKEN) {
      const siteUrl = process.env.SITE_URL || 'https://storysound.netlify.app';
      const isFree = source === 'create2';
      const link = isFree
        ? `${siteUrl}/create2-preview?o=${orderId}`
        : `${siteUrl}/delivery?o=${orderId}`;
      const subject = isFree
        ? `${(attrs['Recipient Name'] || songFor)}'s song preview is ready 🎧`
        : `"${song.song_title}" is ready to download 🎵`;
      const cta = isFree ? '▶ Hear My Free Preview' : '🎵 Listen & Download';
      const body = isFree
        ? 'The first 20 seconds are ready to hear — free.'
        : 'Your song is ready. Stream it, download it, keep it forever.';
      const er = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN },
        body: JSON.stringify({
          From: process.env.FROM_EMAIL || 'songs@storysound.ai',
          To: email, Subject: subject,
          HtmlBody: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">"${song.song_title}"</h1><p style="color:#7A6A5A;margin:12px 0 24px">${body}</p><a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">${cta}</a><p style="color:#9A8F82;font-size:12px;margin-top:20px">Save this email — your link is here whenever you need it.</p></div>`,
          TextBody: `"${song.song_title}"\n\n${body}\n${link}`
        })
      });
      const eOk = er.ok;
      const statusField = isFree ? 'preview_email' : 'email_status';
      const tsField = isFree ? 'preview_emailed_at' : 'emailed_at';
      try {
        const g = await fetch(`${REDIS_URL}/get/meta_${orderId}`, { headers:{ Authorization:`Bearer ${REDIS_TOKEN}` } });
        let m2 = {}; try { m2 = JSON.parse((await g.json())?.result || '{}') || {}; } catch(e){}
        m2[statusField] = eOk ? 'sent' : 'failed'; m2[tsField] = Date.now();
        await fetch(`${REDIS_URL}/pipeline`, { method:'POST',
          headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json' },
          body: JSON.stringify([['SET', `meta_${orderId}`, JSON.stringify(m2)]]) });
      } catch(e){}
    }

    return { statusCode: 200, body: 'Done: ' + song.song_title + ' (' + sizeKb + 'KB)' };

  } catch(err) {
    console.error('Generation error:', err.message);
    await save(orderId, { status: 'error', error: err.message });
    return { statusCode: 500, body: err.message };
  }
};

