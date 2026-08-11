// netlify/functions/klaviyo.js
// Klaviyo profile + event tracking. Called fire-and-forget by the delivery agent.
// POST { email, name, properties:{}, event:"Song Ready", eventProps:{} }

const API = "https://a.klaviyo.com/api";
const REV = "2024-10-15";

function headers() {
  return {
    "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
    "Content-Type": "application/json",
    "revision": REV
  };
}

async function upsertProfile(email, name, props = {}) {
  const body = {
    data: {
      type: "profile",
      attributes: {
        email,
        first_name: name || "",
        properties: props
      }
    }
  };
  const r = await fetch(`${API}/profile-import/`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  return d?.data?.id || null;
}

async function trackEvent(email, eventName, props = {}) {
  const body = {
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: eventName } } },
        profile: { data: { type: "profile", attributes: { email } } },
        properties: props,
        time: new Date().toISOString()
      }
    }
  };
  const r = await fetch(`${API}/events/`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body)
  });
  return r.status === 202;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };
  const KEY = process.env.KLAVIYO_API_KEY;
  if (!KEY) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: "no KLAVIYO_API_KEY" }) };

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "bad json" }; }

  const email = (b.email || "").toLowerCase().trim();
  if (!email) return { statusCode: 400, body: "no email" };

  try {
    const pid = await upsertProfile(email, b.name || "", b.properties || {});
    let evOk = false;
    if (b.event) evOk = await trackEvent(email, b.event, b.eventProps || {});
    return { statusCode: 200, body: JSON.stringify({ ok: true, profileId: pid, eventTracked: evOk }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
