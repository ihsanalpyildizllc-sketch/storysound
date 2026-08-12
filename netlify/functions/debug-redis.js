// netlify/functions/debug-redis.js — temporary diagnostic + purge tool
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if ((q.key || "") !== (process.env.DASH_KEY || "ss-admin-2026")) return { statusCode: 403, body: "no" };

  const URL = process.env.UPSTASH_REDIS_REST_URL;
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const call = async (cmds) => {
    const r = await fetch(`${URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds)
    });
    return r.json();
  };

  try {
    if (q.action === "scan") {
      // list all keys with sizes (small DB, single SCAN sweep)
      let cursor = "0", keys = [];
      do {
        const res = await call([["SCAN", cursor, "COUNT", "500"]]);
        const [cur, batch] = res[0].result;
        cursor = cur; keys.push(...batch);
      } while (cursor !== "0" && keys.length < 1500);
      const sizes = await call(keys.map(k => ["MEMORY", "USAGE", k]));
      const rows = keys.map((k, i) => ({ k, bytes: sizes[i].result || 0 }))
                       .sort((a, b) => b.bytes - a.bytes);
      const total = rows.reduce((a, r) => a + r.bytes, 0);
      return { statusCode: 200, body: JSON.stringify({ total, count: rows.length, rows: rows.slice(0, 80) }) };
    }
    if (q.action === "merge" && q.k && q.fields) {
      const cur = await call([["GET", q.k]]);
      let obj = {};
      try { obj = JSON.parse(cur[0].result || "{}"); } catch(e) {}
      Object.assign(obj, JSON.parse(q.fields));
      await call([["SET", q.k, JSON.stringify(obj)]]);
      return { statusCode: 200, headers: {"Content-Type":"application/json"},
               body: JSON.stringify({ ok: true, k: q.k }) };
    }

    if (q.action === "read" && q.k) {
      const res = await call([["GET", q.k]]);
      const raw = res[0]?.result || null;
      try { return { statusCode: 200, body: JSON.stringify(JSON.parse(raw)) }; }
      catch(e) { return { statusCode: 200, body: JSON.stringify({ raw: (raw||'').slice(0,5000) }) }; }
    }
    if (q.action === "del" && q.k) {
      const keys = q.k.split(",").filter(Boolean);
      const res = await call([["DEL", ...keys]]);
      return { statusCode: 200, body: JSON.stringify({ deleted: res[0].result, keys: keys.length }) };
    }
    // default: write probe
    const res = await call([["SET", "debug_ping", String(Date.now())], ["DBSIZE"]]);
    return { statusCode: 200, body: JSON.stringify(res) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ error: e.message }) };
  }
};
