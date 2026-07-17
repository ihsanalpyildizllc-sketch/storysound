exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "makesongai.myshopify.com";
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!SHOPIFY_ADMIN_TOKEN) return { statusCode: 200, body: JSON.stringify({ ok: false, error: "No admin token" }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: "Invalid JSON" }; }

  const { email, name, forWhom, occasion, genre } = body;
  if (!email) return { statusCode: 400, body: JSON.stringify({ error: "No email" }) };

  const firstName = name || "";
  const note = `Song for: ${forWhom || ""} | Occasion: ${occasion || ""} | Genre: ${genre || ""} | Source: StorySound Funnel`;

  try {
    // Check if customer already exists
    const searchRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-07/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`,
      { headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.customers?.[0];

    if (existing) {
      // Update existing customer - add prospect tag if not already customer
      const tags = existing.tags ? existing.tags.split(', ') : [];
      if (!tags.includes('bought') && !tags.includes('prospect')) {
        tags.push('prospect', 'song-funnel');
      }
      await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2026-07/customers/${existing.id}.json`,
        {
          method: "PUT",
          headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ customer: { id: existing.id, tags: tags.join(', '), note } })
        }
      );
      return { statusCode: 200, body: JSON.stringify({ ok: true, action: "updated", customerId: existing.id }) };
    }

    // Create new customer
    const createRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-07/customers.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          customer: {
            first_name: firstName,
            email,
            tags: "prospect, song-funnel",
            note,
            accepts_marketing: true,
            send_email_welcome: false
          }
        })
      }
    );
    const createData = await createRes.json();

    if (createData.errors) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, errors: createData.errors }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, action: "created", customerId: createData.customer?.id }) };

  } catch(e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
