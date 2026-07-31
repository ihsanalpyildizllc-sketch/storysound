exports.handler = async (event) => {
  const APIFRAME_KEY = process.env.APIFRAME_API_KEY;
  const REDIS_URL    = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const today = new Date().toISOString().slice(0,10);

    // Fetch all data in parallel
    const [apiframeRes, redisRes] = await Promise.all([
      // Apiframe credits
      fetch('https://api.apiframe.ai/v2/me', {
        headers: { 'X-API-Key': APIFRAME_KEY }
      }).then(r => r.json()).catch(() => null),

      // Upstash metrics
      fetch(`${REDIS_URL}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          ['GET', 'dash:songs:total'],
          ['GET', `dash:songs:date:${today}`],
          ['GET', 'dash:revenue:total'],
          ['LRANGE', 'dash:orders', '0', '9']
        ])
      }).then(r => r.json()).catch(() => null)
    ]);

    // Parse Apiframe credits
    const apiframeCredits = apiframeRes?.team?.credits || 0;
    const apiframePlan    = apiframeRes?.team?.plan || 'unknown';
    const songsLeft       = Math.floor(apiframeCredits / 11);

    // Parse Redis metrics
    const results    = redisRes || [];
    const totalSongs = parseInt(results[0]?.result || '0');
    const todaySongs = parseInt(results[1]?.result || '0');
    const totalRev   = parseInt(results[2]?.result || '0');
    const recentRaw  = results[3]?.result || [];
    const recentOrders = recentRaw.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    // Cost estimates
    const costPerSong  = 0.08; // ~$0.01 Claude + ~$0.07 Suno
    const totalCost    = totalSongs * costPerSong;
    const totalProfit  = totalRev - totalCost;
    const margin       = totalRev > 0 ? ((totalProfit / totalRev) * 100).toFixed(1) : '99.8';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        apiframe: {
          credits:   apiframeCredits,
          plan:      apiframePlan,
          songsLeft: songsLeft,
          costPer:   0.07,
          status:    apiframeCredits > 100 ? 'healthy' : apiframeCredits > 30 ? 'warning' : 'critical'
        },
        claude: {
          status:  'active',
          costPer: 0.01,
          note:    'Check balance at console.anthropic.com'
        },
        stats: {
          totalSongs,
          todaySongs,
          totalRevenue: totalRev,
          totalCost:    parseFloat(totalCost.toFixed(2)),
          totalProfit:  parseFloat(totalProfit.toFixed(2)),
          margin,
          revenueToday: todaySongs * 39
        },
        recentOrders,
        timestamp: new Date().toISOString()
      })
    };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
