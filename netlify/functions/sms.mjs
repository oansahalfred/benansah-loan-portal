// Benansah Loan Manager — sends SMS through G Online.
// The G Online API key lives in Netlify's environment variables, never in the website.
// Required environment variables (Netlify → Project configuration → Environment variables):
//   GONLINE_API_KEY    your G Online API key
//   GONLINE_SENDER_ID  your approved sender ID, e.g. BENANSAH
//   FIREBASE_API_KEY   the apiKey from your Firebase config (used to check who is signed in)
//   ALLOWED_EMAILS     staff emails allowed to send, separated by commas

const GONLINE = "https://sms.gonlinesites.com/app/sms/api";
const GONLINE_HTTP = "http://sms.gonlinesites.com/app/sms/api";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Ghana numbers: 024 123 4567 / +233 24 123 4567 → 233241234567
function normalizePhone(raw) {
  let p = String(raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("00")) p = p.slice(2);
  if (/^0\d{9}$/.test(p)) p = "233" + p.slice(1);
  return p;
}

async function callGOnline(query) {
  // Try the secure address first, then the plain one the official plugin uses.
  for (const base of [GONLINE, GONLINE_HTTP]) {
    try {
      const r = await fetch(`${base}?${query}`, { headers: { Accept: "application/json" } });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      return { status: r.status, ok: r.ok, data, text };
    } catch (e) { /* try next */ }
  }
  return { status: 0, ok: false, data: null, text: "Could not reach G Online" };
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  const KEY = process.env.GONLINE_API_KEY;
  const SENDER = process.env.GONLINE_SENDER_ID;
  const FB_KEY = process.env.FIREBASE_API_KEY;
  const ALLOWED = (process.env.ALLOWED_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!KEY || !SENDER || !FB_KEY || !ALLOWED.length) {
    return json({ ok: false, error: "SMS sending is not set up yet — add the settings on Netlify (Environment variables)." }, 500);
  }

  // Only signed-in staff on the allowed list may send.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not signed in." }, 401);
  let email = "";
  try {
    const look = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FB_KEY)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: token })
    });
    const lj = await look.json().catch(() => ({}));
    email = (look.ok && lj.users && lj.users[0] && lj.users[0].email || "").toLowerCase();
  } catch (e) { /* handled below */ }
  if (!email) return json({ ok: false, error: "Your sign-in has expired — sign out and sign in again." }, 401);
  if (!ALLOWED.includes(email)) return json({ ok: false, error: `${email} is not allowed to send SMS.` }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }

  if (body.action === "balance") {
    const r = await callGOnline(`action=check-balance&api_key=${encodeURIComponent(KEY)}`);
    return json({ ok: r.ok, balance: r.data || r.text.slice(0, 300) }, r.ok ? 200 : 502);
  }

  const to = normalizePhone(body.to);
  const message = String(body.message || "").trim();
  if (!/^233\d{9}$/.test(to)) return json({ ok: false, error: `"${body.to}" is not a valid Ghana phone number.` }, 400);
  if (!message) return json({ ok: false, error: "The message is empty." }, 400);
  if (message.length > 918) return json({ ok: false, error: "The message is too long (over 6 SMS)." }, 400);

  const r = await callGOnline(
    `action=send-sms&api_key=${encodeURIComponent(KEY)}&to=${encodeURIComponent(to)}&from=${encodeURIComponent(SENDER)}&sms=${encodeURIComponent(message)}`
  );
  const code = r.data && r.data.code !== undefined ? String(r.data.code).toLowerCase() : "";
  const sent = r.ok && (r.data ? code === "ok" : true);
  return json({
    ok: sent, to, sender: SENDER, by: email,
    provider: r.data || r.text.slice(0, 300),
    error: sent ? undefined : ((r.data && (r.data.message || r.data.msg || r.data.code)) || "G Online did not accept the message.")
  }, sent ? 200 : 502);
};
