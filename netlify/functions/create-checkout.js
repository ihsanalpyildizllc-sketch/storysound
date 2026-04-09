const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_MAP = {
  STRIPE_PRICE_STORYSOUND_BASIC:    process.env.STRIPE_PRICE_STORYSOUND_BASIC,
  STRIPE_PRICE_STORYSOUND_STANDARD: process.env.STRIPE_PRICE_STORYSOUND_STANDARD,
  STRIPE_PRICE_STORYSOUND_ANNUAL:   process.env.STRIPE_PRICE_STORYSOUND_ANNUAL,
};
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const { priceId, email, metadata } = JSON.parse(event.body);
    const resolvedPriceId = PRICE_MAP[priceId] || priceId;
    if (!resolvedPriceId) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan' }) };
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      success_url: `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/?cancelled=true`,
      metadata: {
        ...metadata,
        story: metadata.story?.substring(0, 490),
        moments: metadata.moments?.substring(0, 490),
      },
    });
    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
