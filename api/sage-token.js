/**
 * POST /api/sage-token
 *
 * Returns a short-lived ElevenLabs signed WebSocket URL, but only for a
 * signed-in Bridg Connects client.
 *
 * The Firebase ID token is verified CRYPTOGRAPHICALLY against Google's
 * public signing keys. We never call the Firebase REST API, so App Check
 * enforcement does not apply to this server-to-server path — and the
 * check is stricter: signature, issuer, audience and expiry are all
 * validated locally.
 *
 * Required environment variables (Vercel > Settings > Environment Variables):
 *   ELEVENLABS_API_KEY   - your ElevenLabs API key  (SECRET)
 *   ELEVENLABS_AGENT_ID  - agent_2801kymqshm9eyfs3a1gkfertk3v
 *
 * FIREBASE_WEB_API_KEY is no longer used and can be deleted.
 */

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bridg-connects';
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const ISSUER = 'https://securetoken.google.com/' + PROJECT_ID;

const ALLOWED_ORIGINS = [
  'https://www.bridgconnects.com',
  'https://bridgconnects.com'
];

/* ── tiny helpers ─────────────────────────────────────────────── */

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = Buffer.from(s, 'base64');
  return new Uint8Array(bin);
}

function b64urlToJson(s) {
  return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/* Google rotates these keys. Cache them, but not forever. */
let JWKS_CACHE = { keys: null, at: 0 };

async function getKeys() {
  const now = Date.now();
  if (JWKS_CACHE.keys && now - JWKS_CACHE.at < 60 * 60 * 1000) return JWKS_CACHE.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('jwks fetch failed: ' + r.status);
  const j = await r.json();
  JWKS_CACHE = { keys: j.keys || [], at: now };
  return JWKS_CACHE.keys;
}

/**
 * Verifies a Firebase ID token. Returns the uid, or throws.
 */
async function verifyIdToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);

  if (header.alg !== 'RS256') throw new Error('unexpected alg: ' + header.alg);
  if (!header.kid) throw new Error('missing kid');

  const keys = await getKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found for kid');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    signed
  );
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('wrong audience');
  if (payload.iss !== ISSUER) throw new Error('wrong issuer');
  if (!payload.sub) throw new Error('missing subject');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('token expired');
  if (typeof payload.iat === 'number' && payload.iat > now + 300) throw new Error('issued in future');

  return payload.sub;
}

/* Best-effort throttle. Lives in lambda memory, so it is a speed bump,
   not a guarantee. Move to Vercel KV for a hard limit. */
const RECENT = new Map();
const MAX_PER_HOUR = 12;
const HOUR = 60 * 60 * 1000;

function throttled(uid) {
  const now = Date.now();
  const hits = (RECENT.get(uid) || []).filter(t => now - t < HOUR);
  if (hits.length >= MAX_PER_HOUR) return true;
  hits.push(now);
  RECENT.set(uid, hits);
  if (RECENT.size > 500) {
    for (const [k, v] of RECENT) if (!v.some(t => now - t < HOUR)) RECENT.delete(k);
  }
  return false;
}

/* ── handler ──────────────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const origin = req.headers.origin || '';
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.error('sage-token: blocked origin ' + origin);
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  const auth = req.headers.authorization || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) {
    console.error('sage-token: request arrived with no Authorization header');
    return res.status(401).json({ error: 'auth_required' });
  }

  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.error('sage-token: missing environment variables');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  let uid;
  try {
    uid = await verifyIdToken(idToken);
  } catch (e) {
    console.error('sage-token: id token rejected — ' + (e && e.message));
    return res.status(401).json({ error: 'auth_invalid' });
  }

  if (throttled(uid)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  try {
    const url =
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=' +
      encodeURIComponent(ELEVENLABS_AGENT_ID);

    const r = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });

    if (!r.ok) {
      let why = '';
      try { why = (await r.text()).slice(0, 200); } catch (e) {}
      console.error('sage-token: elevenlabs http=' + r.status + ' body=' + why);
      if (r.status === 401 || r.status === 403) return res.status(502).json({ error: 'provider_auth' });
      if (r.status === 429) return res.status(503).json({ error: 'provider_busy' });
      return res.status(502).json({ error: 'provider_error' });
    }

    const data = await r.json();
    const signedUrl = data && data.signed_url;
    if (!signedUrl || !/^wss:\/\/api\.elevenlabs\.io\//.test(signedUrl)) {
      console.error('sage-token: unexpected provider payload');
      return res.status(502).json({ error: 'provider_error' });
    }

    return res.status(200).json({ signedUrl });
  } catch (e) {
    console.error('sage-token: provider request failed — ' + (e && e.message));
    return res.status(502).json({ error: 'provider_error' });
  }
}
