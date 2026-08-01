exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const SITE_URL = process.env.SITE_URL || "https://storysound.netlify.app";
  // Any of these means "this is an unlock purchase for an existing preview",
  // NOT a new song to generate.
  const UNLOCK_VARIANTS = [
    "43257750978637",   // legacy $49 unlock
    "44263008763993",   // Custom Song (30 minutes)
    "44263007518809",   // Custom Song (48 hours)
    "44263011287129"    // Lyrics
  ];

  let order;
  try { order = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }
  const orderId = String(order.id || "");
  if (!orderId) return { statusCode: 400, body: "Missing order ID" };

  // Parse order attributes
  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  // --- DETECT UNLOCK ORDER ($49 lyrics + download) ---
  const lineItems = order.line_items || [];
  const isUnlockOrder = lineItems.some(item => UNLOCK_VARIANTS.includes(String(item.variant_id)));

  if (isUnlockOrder) {
    const origOrderId = attrs["Original_Order"] || "";
    if (origOrderId && REDIS_URL && REDIS_TOKEN) {
      // Store unlock flag — success page polls get-song which checks this
      const val = encodeURIComponent(JSON.stringify({
        unlocked: true,
        unlockOrderId: orderId,
        offer: attrs["Offer"] || "",
        priceVariant: attrs["Price_Variant"] || "",
        delivery: attrs["Delivery"] || "",
        lyrics: attrs["Lyrics_Addon"] === "Yes",
        total: order.total_price || null,
        ts: Date.now()
      }));
      await fetch(`${REDIS_URL}/setex/unlocked_${origOrderId}/2592000/${val}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      console.log("Unlock stored for original order:", origOrderId);

      // make the song permanent + record purchase meta + revenue + delivery email
      const country = order.billing_address?.country_code || order.shipping_address?.country_code || null;
      const items = lineItems.map(i => i.title + " ($" + i.price + ")").join(", ");
      const lyricsBought = lineItems.some(i => String(i.variant_id) === "44263011287129") || attrs["Lyrics_Addon"] === "Yes";
      const total = parseFloat(order.total_price || 0) || 0;

      const g = await fetch(`${REDIS_URL}/pipeline`, { method:"POST",
        headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,"Content-Type":"application/json" },
        body: JSON.stringify([["GET", `meta_${origOrderId}`], ["GET", `song_${origOrderId}`], ["PERSIST", `song_${origOrderId}`], ["INCRBY", "dash:revenue:total", String(Math.round(total))]]) });
      const rows = await g.json();
      let meta = {}; try { meta = JSON.parse(rows[0]?.result || "{}") || {}; } catch(e){}
      let songRec = null; try { songRec = JSON.parse(rows[1]?.result || "null"); } catch(e){}

      Object.assign(meta, {
        paid: true, persisted: true, items, total, country: meta.country || country,
        lyrics: lyricsBought || meta.lyrics || false,
        email: meta.email || order.email || attrs["Customer Email"] || "",
        unlock_order: orderId, updated: Date.now()
      });

      // delivery email, immediately — the watchdog re-sends if this fails
      let emailStatus = "skipped";
      if (meta.email && process.env.POSTMARK_SERVER_TOKEN && songRec && songRec.status === "done") {
        const link = `${SITE_URL}/delivery?o=${origOrderId}`;
        const title = songRec.song_title || "Your Song";
        const er = await fetch("https://api.postmarkapp.com/email", { method:"POST",
          headers:{ "Content-Type":"application/json","X-Postmark-Server-Token":process.env.POSTMARK_SERVER_TOKEN },
          body: JSON.stringify({
            From: process.env.FROM_EMAIL || "songs@storysound.ai",
            To: meta.email,
            Subject: `"${title}" is ready to download 🎵`,
            HtmlBody: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px;background:#FAF7F2"><h1 style="font-style:italic;color:#0F0A06">"${title}"</h1><p style="color:#7A6A5A;margin:12px 0 24px">Thank you! Your full song is unlocked. Stream it, download it, keep it forever.</p><a href="${link}" style="display:block;background:#B5471C;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700">🎵 Listen &amp; Download</a><p style="color:#9A8F82;font-size:12px;margin-top:20px">Save this email — your link never expires.</p></div>`,
            TextBody: `"${title}" is unlocked!\n\nListen & download: ${link}`
          })});
        emailStatus = er.ok ? "sent" : "failed";
      }
      meta.email_status = emailStatus === "skipped" ? (meta.email_status || "pending") : emailStatus;
      if (emailStatus === "sent") meta.emailed_at = Date.now();

      await fetch(`${REDIS_URL}/pipeline`, { method:"POST",
        headers:{ Authorization:`Bearer ${REDIS_TOKEN}`,"Content-Type":"application/json" },
        body: JSON.stringify([["SET", `meta_${origOrderId}`, JSON.stringify(meta)]]) });
    }
    return { statusCode: 200, body: "Unlock processed" };
  }

  // --- REGULAR SONG ORDER (pay-first /create funnel) ---
  const country = order.billing_address?.country_code || order.shipping_address?.country_code || null;
  const items = lineItems.map(i => i.title + " ($" + i.price + ")").join(", ");
  const lyricsBought = lineItems.some(i => ["44263011287129","44258586886233"].includes(String(i.variant_id)));
  const meta = {
    source: "create", paid: true,
    email: order.email || attrs["Customer Email"] || "",
    name: (attrs["Song For"] || "").split(" (")[0] || "",
    country, items, total: parseFloat(order.total_price || 0) || 39,
    lyrics: lyricsBought, created: Date.now(), attempts: 0
  };
  await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["SET", `song_${orderId}`, JSON.stringify({ status: "processing", created: Date.now() }), "EX", "86400"],
      ["SET", `meta_${orderId}`, JSON.stringify(meta)],
      ["SET", `payload_${orderId}`, event.body, "EX", "172800"],
      ["LPUSH", "orders_index", orderId],
      ["LTRIM", "orders_index", "0", "4999"]
    ])
  });

  // Trigger background function (15min timeout)
  try {
    await fetch(`${SITE_URL}/.netlify/functions/generate-song-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event.body
    });
  } catch(e) {
    console.log("BG trigger error:", e.message);
  }

  return { statusCode: 200, body: "OK" };
};