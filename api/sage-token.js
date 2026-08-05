/**
 * POST /api/sage-token
 *
 * Returns a short-lived ElevenLabs signed WebSocket URL, but only for a
 * signed-in Bridg Connects client.
 *
 * The ElevenLabs API key lives ONLY in Vercel environment variables.
 * It is never sent to the browser and never committed to the repo.
 *
 * Required environment variables (Vercel > Settings > Environment Variables):
 *   ELEVENLABS_API_KEY     - your ElevenLabs API key  (SECRET)
 *   ELEVENLABS_AGENT_ID    - agent_2801kymqshm9eyfs3a1gkfertk3v
 *   FIREBASE_WEB_API_KEY   - the Firebase Web API key already used in the browser
 */

const ALLOWED_ORIGINS = [
  'https://www.bridgconnects.com',
  'https://bridgconnects.com'
];

// Best-effort throttle. Lives in lambda memory, so it is a speed bump,
// not a guarantee. See notes: move to Vercel KV for a hard limit.
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Only our own pages may call this.
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  // 1) Require a Firebase ID token.
  const auth = req.headers.authorization || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) {
    return res.status(401).json({ error: 'auth_required' });
  }

  const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    FIREBASE_WEB_API_KEY
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !FIREBASE_WEB_API_KEY) {
    console.error('sage-token: missing environment variables');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // 2) Validate the token against Firebase. An invalid or expired token fails here.
  let uid;
  try {
    const vr = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
        encodeURIComponent(FIREBASE_WEB_API_KEY),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );
    if (!vr.ok) return res.status(401).json({ error: 'auth_invalid' });
    const vj = await vr.json();
    const user = vj && vj.users && vj.users[0];
    if (!user || !user.localId) return res.status(401).json({ error: 'auth_invalid' });
    if (user.disabled) return res.status(403).json({ error: 'account_disabled' });
    uid = user.localId;
  } catch (e) {
    console.error('sage-token: verification failed');
    return res.status(401).json({ error: 'auth_invalid' });
  }

  // 3) Throttle per user so no single account can drain the credit balance.
  if (throttled(uid)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  // 4) Ask ElevenLabs for a signed URL. Valid ~15 minutes.
  try {
    const url =
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=' +
      encodeURIComponent(ELEVENLABS_AGENT_ID);

    const r = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });

    if (!r.ok) {
      // Do not forward provider error bodies to the browser.
      console.error('sage-token: elevenlabs responded', r.status);
      if (r.status === 401 || r.status === 403) {
        return res.status(502).json({ error: 'provider_auth' });
      }
      if (r.status === 429) {
        return res.status(503).json({ error: 'provider_busy' });
      }
      return res.status(502).json({ error: 'provider_error' });
    }

    const data = await r.json();
    const signedUrl = data && data.signed_url;
    if (!signedUrl || !/^wss:\/\/api\.elevenlabs\.io\//.test(signedUrl)) {
      return res.status(502).json({ error: 'provider_error' });
    }

    return res.status(200).json({ signedUrl });
  } catch (e) {
    console.error('sage-token: request failed');
    return res.status(502).json({ error: 'provider_error' });
  }
}
