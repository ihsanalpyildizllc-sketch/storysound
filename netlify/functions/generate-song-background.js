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
        messages: [{ role: 'user', content: `You are a professional songwriter who writes commissioned personal songs. Someone paid for a song about a real person, built from real memories. Your job is to turn their raw story into a song with a NARRATIVE ARC — not a pile of feelings.

THE STORY (real details from the buyer):
${story}

Genre: ${genre} | Language: ${language} | Voice: ${voice} | Occasion: ${occasion}

STRUCTURE — each section has ONE job, and no two sections may do the same job:

[Verse 1] — THE ORIGIN. Where it began. Use the earliest or most scene-setting memory from the story. Paint one specific moment the listener can see (a place, a season, an object). Past tense.
[Chorus] — THE CORE TRUTH. The one sentence this whole song exists to say, with ${songFor}'s name in it. Not a list of compliments — ONE central truth, stated memorably. This exact chorus repeats later, so make it strong enough to hear three times.
[Verse 2] — THE JOURNEY. Time passes. What changed, what was survived, what grew. Use a DIFFERENT memory than Verse 1 — never re-describe the origin. If the story mentions hard times, this is where they live, resolved with warmth.
[Chorus] — repeat exactly.
[Bridge] — THE TURN. Shift perspective: speak directly to ${songFor} in present tense, quieter and more intimate than everything before it. This is the line that makes them cry. 2-3 lines, no rhyme required.
[Final Chorus] — repeat, with ONE line changed to point at the future ("always will" energy).

HARD RULES:
- Every memory/detail from the story appears AT MOST ONCE. Never restate a detail in different words.
- Verses tell a story in concrete images (nouns you can touch). Choruses carry emotion. Do not put abstract emotion-words (love, heart, soul, forever) in verses more than once each.
- No filler lines that could belong in any love song ("you mean the world to me", "I can't live without you"). If a line would work for a stranger's song, cut it and use a real detail instead.
- Lines must be SHORT and singable: 6-10 words. Natural ${language}.
- If the story is thin on details, invent small sensory specifics consistent with what's given — never invent major events.

Return ONLY valid JSON (no markdown):
{"song_title":"...","song_meta":"For ${songFor} - ${occasion} - ${genre}","music_style":"${genre} song, ${voice.toLowerCase()} vocals, emotional and deeply personal, radio quality","lyrics":"[Verse 1]\\n...\\n\\n[Chorus]\\n...\\n\\n[Verse 2]\\n...\\n\\n[Chorus]\\n...\\n\\n[Bridge]\\n...\\n\\n[Final Chorus]\\n..."}` }]
      })
    });
    const cdRaw = await cr.text();
    let cd; try { cd = JSON.parse(cdRaw); } catch(e) { throw new Error('[claude-api] non-JSON response: ' + cdRaw.slice(0,120)); }
    if (cd.error) throw new Error('[claude-api] ' + cd.error.message);
    if (!cd.content?.[0]) throw new Error('[claude-api] empty content');

    // robust: strip fences, then take the first balanced {...} block regardless of any preamble
    let song;
    const txt = cd.content[0].text.replace(/```json|```/g, '').trim();
    try { song = JSON.parse(txt); }
    catch(e) {
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('[claude-lyrics] no JSON in reply: ' + txt.slice(0,150));
      try { song = JSON.parse(m[0]); }
      catch(e2) { throw new Error('[claude-lyrics] JSON invalid: ' + m[0].slice(0,150)); }
    }
    if (!song.lyrics || !song.song_title) throw new Error('[claude-lyrics] missing fields: ' + JSON.stringify(Object.keys(song)));

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
      let sd;
      { const raw = await sr.text();
        try { sd = JSON.parse(raw); }
        catch(e) {
          // transient gateway HTML — one retry after 4s
          await new Promise(r => setTimeout(r, 4000));
          const sr2 = await fetch('https://api.apiframe.ai/v2/music/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': APIFRAME_KEY },
            body: JSON.stringify({ model: 'suno', prompt: song.lyrics,
              sunoParams: { custom_mode: true, style: song.music_style, title: song.song_title.slice(0,80),
                instrumental: false, model_version: 'V5_5', vocal_gender: vocalGender } })
          });
          const raw2 = await sr2.text();
          try { sd = JSON.parse(raw2); }
          catch(e2) { throw new Error('[apiframe-submit] non-JSON twice: ' + raw2.slice(0,120)); }
        }
      }
      if (!sr.ok || sd.error) throw new Error('Suno v2 error: ' + (sd.error || JSON.stringify(sd).slice(0,200)));
      taskId = sd.jobId || sd.id || sd.task_id;

      // Poll for completion (up to 8 minutes, uppercase status in v2)
      for (let i = 0; i < 96; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pr = await fetch(`https://api.apiframe.ai/v2/jobs/${taskId}`, {
          headers: { 'X-API-Key': APIFRAME_KEY }
        });
        let pd;
        { const praw = await pr.text();
          try { pd = JSON.parse(praw); }
          catch(e) { console.log('[apiframe-poll] non-JSON blip, retrying:', praw.slice(0,80)); continue; }
        }
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
      let sd;
      { const raw = await sr.text();
        try { sd = JSON.parse(raw); }
        catch(e) {
          // transient gateway HTML — one retry after 4s
          await new Promise(r => setTimeout(r, 4000));
          const sr2 = await fetch('https://api.apiframe.ai/v2/music/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': APIFRAME_KEY },
            body: JSON.stringify({ model: 'suno', prompt: song.lyrics,
              sunoParams: { custom_mode: true, style: song.music_style, title: song.song_title.slice(0,80),
                instrumental: false, model_version: 'V5_5', vocal_gender: vocalGender } })
          });
          const raw2 = await sr2.text();
          try { sd = JSON.parse(raw2); }
          catch(e2) { throw new Error('[apiframe-submit] non-JSON twice: ' + raw2.slice(0,120)); }
        }
      }
      if (!sr.ok || sd.error) throw new Error('Suno v1 error: ' + (sd.error || JSON.stringify(sd).slice(0,200)));
      taskId = sd.task_id;

      // Poll v1
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const pr = await fetch(`https://api.apiframe.pro/fetch/${taskId}`, {
          headers: { 'Authorization': APIFRAME_KEY }
        });
        let pd;
        { const praw = await pr.text();
          try { pd = JSON.parse(praw); }
          catch(e) { console.log('[apiframe-poll] non-JSON blip, retrying:', praw.slice(0,80)); continue; }
        }
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
      completed_at: Date.now(),
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
      ['EXPIRE', `dash:songs:date:${today}`, '2592000']
    ];
    // revenue is recorded ONLY by the webhook (real totals incl. bumps), never here
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

    // Email is handled by delivery-agent (10-min delay after completed_at)

    return { statusCode: 200, body: 'Done: ' + song.song_title + ' (' + sizeKb + 'KB)' };

  } catch(err) {
    console.error('Generation error:', err.message);
    await save(orderId, { status: 'error', error: err.message });
    return { statusCode: 500, body: err.message };
  }
};


