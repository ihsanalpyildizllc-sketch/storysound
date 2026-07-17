exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "makesongai.myshopify.com";
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!SHOPIFY_ADMIN_TOKEN) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const { email, name, forWhom, occasion, genre, voice, language, qualities, memories, message } = body;
  if (!email) return { statusCode: 400, body: JSON.stringify({ error: "No email" }) };

  const note = [
    forWhom  ? `Song for: ${forWhom}` : "",
    name     ? `Name: ${name}` : "",
    occasion ? `Occasion: ${occasion}` : "",
    genre    ? `Genre: ${genre}` : "",
    voice    ? `Voice: ${voice}` : "",
    qualities ? `Qualities: ${qualities}` : "",
    memories  ? `Memories: ${memories}` : "",
    message   ? `Message: ${message}` : ""
  ].filter(Boolean).join(" | ");

  const headers = {
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json"
  };

  try {
    // 1. Create or find customer
    let customerId = null;
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-07/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`,
      { headers }
    );
    const searchData = await searchRes.json();
    const existing = searchData.customers?.[0];

    if (existing) {
      customerId = existing.id;
      // Update tags if not already a buyer
      const tags = existing.tags ? existing.tags.split(', ').filter(Boolean) : [];
      if (!tags.includes('bought')) {
        if (!tags.includes('prospect')) tags.push('prospect');
        if (!tags.includes('song-funnel')) tags.push('song-funnel');
        await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/customers/${existing.id}.json`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ customer: { id: existing.id, tags: tags.join(', '), note } })
        });
      }
    } else {
      // Create new customer
      const createRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/customers.json`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          customer: {
            first_name: name || forWhom || "",
            email,
            tags: "prospect, song-funnel",
            note,
            accepts_marketing: true,
            email_marketing_consent: {
              state: "subscribed",
              opt_in_level: "single_opt_in"
            },
            send_email_welcome: false
          }
        })
      });
      const createData = await createRes.json();
      customerId = createData.customer?.id;
    }

    // 2. Create draft order — this enables Shopify abandoned checkout recovery emails
    const MAIN_VARIANT = "43257726730317"; // $39 main song
    const draftRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-07/draft_orders.json`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft_order: {
          line_items: [{ variant_id: MAIN_VARIANT, quantity: 1 }],
          customer: customerId ? { id: customerId } : { email },
          email,
          note,
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
    const draftId = draftData.draft_order?.id;
    const invoiceUrl = draftData.draft_order?.invoice_url;

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        action: existing ? "updated" : "created",
        customerId,
        draftId,
        invoiceUrl
      })
    };

  } catch(e) {
    console.error("Customer/draft error:", e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, error: e.message }) };
  }
};
