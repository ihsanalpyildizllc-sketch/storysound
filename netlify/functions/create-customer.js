// netlify/functions/create-customer.js
// Uses Shopify client credentials grant (2026 Dev Dashboard apps)
// Token is short-lived (24h) — cached in Redis, auto-refreshed on expiry

const SHOPIFY_STORE  = "gut-1809.myshopify.com";
const MAIN_VARIANT   = "44258532819033"; // $39 base song

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_APP_KEY || process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_ADMIN_TOKEN;
  const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!CLIENT_SECRET) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: "no credentials" }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const { email, name, forWhom, occasion, genre, voice, language, qualities, memories, message, source } = body;
  if (!email) return { statusCode: 400, body: JSON.stringify({ error: "No email" }) };

  // ── 1. Get access token (cached in Redis, refreshed every 23h) ──────────────
  let accessToken = null;

  // Try Redis cache first
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const cached = await fetch(`${REDIS_URL}/get/shopify_access_token`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const cachedData = await cached.json();
      if (cachedData?.result) accessToken = cachedData.result;
    } catch(e) {}
  }

  // If no cached token, request a new one
  if (!accessToken) {
    if (!CLIENT_ID) {
      const availableKeys = Object.keys(process.env).filter(k => k.toLowerCase().includes("shopify") || k.toLowerCase().includes("client")).join(", ");
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: "Client ID not found", checkedVars: "SHOPIFY_CLIENT_ID, SHOPIFY_API_KEY, SHOPIFY_APP_KEY, CLIENT_ID", shopifyVarsFound: availableKeys }) };
    }

    try {
      const tokenRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}`
        }
      );
      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;

      // Cache in Redis for 23 hours (token expires in 24h)
      if (accessToken && REDIS_URL && REDIS_TOKEN) {
        await fetch(`${REDIS_URL}/pipeline`, {
          method: "POST",
          headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify([
            ["SET", "shopify_access_token", accessToken],
            ["EXPIRE", "shopify_access_token", "82800"]  // 23 hours
          ])
        });
      }

      if (!accessToken) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: "Token exchange failed", shopifyError: tokenData }) };
      }
    } catch(e) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: "Token request failed: " + e.message }) };
    }
  }

  // ── 2. Create/update Shopify customer ────────────────────────────────────────
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json"
  };

  const note = [
    forWhom   ? `Song for: ${forWhom}` : "",
    name      ? `Name: ${name}` : "",
    occasion  ? `Occasion: ${occasion}` : "",
    genre     ? `Genre: ${genre}` : "",
    voice     ? `Voice: ${voice}` : "",
    qualities ? `Qualities: ${qualities}` : "",
    memories  ? `Memories: ${memories}` : "",
    message   ? `Message: ${message}` : ""
  ].filter(Boolean).join(" | ");

  try {
    let customerId = null;
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-07/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`,
      { headers }
    );
    const searchData = await searchRes.json();
    const existing = searchData.customers?.[0];

    if (existing) {
      customerId = existing.id;
      const tags = existing.tags ? existing.tags.split(", ").filter(Boolean) : [];
      if (!tags.includes("bought")) {
        if (!tags.includes("prospect")) tags.push("prospect");
        if (!tags.includes("song-funnel")) tags.push("song-funnel");
        await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/customers/${existing.id}.json`, {
          method: "PUT", headers,
          body: JSON.stringify({ customer: { id: existing.id, tags: tags.join(", "), note } })
        });
      }
    } else {
      const createRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/customers.json`, {
        method: "POST", headers,
        body: JSON.stringify({
          customer: {
            first_name: name || forWhom || "",
            email,
            tags: ["prospect", "song-funnel", source ? "source-" + source : "source-unknown"].filter(Boolean).join(", "),
            note,
            accepts_marketing: true,
            email_marketing_consent: { state: "subscribed", opt_in_level: "single_opt_in" },
            send_email_welcome: false
          }
        })
      });
      const createData = await createRes.json();

      // If token expired mid-request, clear cache and return (will retry next time)
      if (createRes.status === 401) {
        if (REDIS_URL && REDIS_TOKEN) {
          await fetch(`${REDIS_URL}/del/shopify_access_token`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
        }
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: "Token expired, cleared cache — will retry" }) };
      }

      customerId = createData.customer?.id;
      if (!customerId) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, shopifyError: createData }) };
      }
    }

    // ── 3. Create draft order for abandoned cart recovery ──────────────────────
    const draftRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/draft_orders.json`, {
      method: "POST", headers,
      body: JSON.stringify({
        draft_order: {
          line_items: [{ variant_id: MAIN_VARIANT, quantity: 1 }],
          customer: customerId ? { id: customerId } : { email },
          email, note,
          note_attributes: [
            { name: "Song For", value: name || forWhom || "" },
            { name: "Occasion", value: occasion || "" },
            { name: "Genre", value: genre || "" },
            { name: "Singer Voice", value: voice || "" },
            { name: "Language", value: language || "English" },
            { name: "Their Qualities", value: qualities || "" },
            { name: "Memories", value: memories || "" },
            { name: "Special Message", value: message || "" },
            { name: "Customer Email", value: email }
          ],
          tags: "abandoned-candidate",
          send_invoice: false
        }
      })
    });
    const draftData = await draftRes.json();
    const draftId    = draftData.draft_order?.id;
    const invoiceUrl = draftData.draft_order?.invoice_url;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        action: existing ? "updated" : "created",
        customerId: customerId || null,
        draftId: draftId || null,
        invoiceUrl: invoiceUrl || null
      })
    };

  } catch(e) {
    console.error("Shopify API error:", e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, error: e.message }) };
  }
};
