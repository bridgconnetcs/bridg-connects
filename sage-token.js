/**
 * POST /api/sage-token
 *
 * Returns a short-lived ElevenLabs signed WebSocket URL, but only for a
 * signed-in Bridg Connects client whose email is verified AND whose account
 * has been manually approved.
 *
 * WHY THE EXTRA GATES (added Aug 7, 2026):
 * Requiring a Firebase ID token is not the same as requiring a customer.
 * Signup on bridgconnects.com is open and automatic, so anyone could create
 * an account, mint a valid token, and call this endpoint. The per-user
 * throttle did not help: creating users is free, so a thousand accounts
 * meant a thousand times the quota. Two gates now close that:
 *
 *   Gate A - email verified. Kills scripted mass signup: each account needs
 *            a real mailbox and a human click.
 *   Gate B - clients/{uid}.status == 'approved'. Approval is manual and only
 *            granted after a conversation, so an attacker cannot self-serve.
 *
 * The ElevenLabs API key lives ONLY in Vercel environment variables.
 * It is never sent to the browser and never committed to the repo.
 *
 * Required environment variables (Vercel > Settings > Environment Variables):
 *   ELEVENLABS_API_KEY     - your ElevenLabs API key  (SECRET)
 *   ELEVENLABS_AGENT_ID    - the Sage agent id
 *   FIREBASE_WEB_API_KEY   - the Firebase Web API key already used in the browser
 *   FIREBASE_PROJECT_ID    - optional; defaults to 'bridg-connects'
 */

const ALLOWED_ORIGINS = [
  'https://www.bridgconnects.com',
  'https://bridgconnects.com'
];

// Best-effort throttles. These live in lambda memory, so they are speed bumps,
// not guarantees: Vercel runs many instances and recycles them, which resets
// the counters. The real limits are the two gates above plus a usage alert on
// the provider dashboard. Move to Vercel KV or a Firestore counter for a hard
// ceiling.
const RECENT = new Map();
const MAX_PER_HOUR = 12;
const HOUR = 60 * 60 * 1000;

const DAY = 24 * 60 * 60 * 1000;
const GLOBAL_MAX_PER_DAY = 300;
let globalHits = [];

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

// Absolute ceiling across all accounts. Even legitimate traffic should never
// reach this; if it does, something is wrong and stopping is the right answer.
function globalCapReached() {
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < DAY);
  if (globalHits.length >= GLOBAL_MAX_PER_DAY) return true;
  globalHits.push(now);
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Only our own pages may call this. The Origin header is now REQUIRED:
  // the previous version only checked it when present, and command-line
  // clients omit it by default, so the check protected browsers only —
  // exactly the clients that are not attacking.
  const origin = req.headers.origin || '';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  // 1) Require a Firebase ID token.
  const auth = req.headers.authorization || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) {
    console.error('sage-token: request arrived with no Authorization header');
    return res.status(401).json({ error: 'auth_required' });
  }

  const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    FIREBASE_WEB_API_KEY
  } = process.env;

  const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bridg-connects';

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

    if (!vr.ok) {
      // Surface Google's own reason. These are error codes, never secrets.
      let why = '';
      try {
        const eb = await vr.json();
        why = (eb && eb.error && (eb.error.message || eb.error.status)) || '';
      } catch (e) {}
      console.error('sage-token: firebase lookup rejected. http=' + vr.status + ' reason=' + why);
      return res.status(401).json({ error: 'auth_invalid' });
    }

    const vj = await vr.json();
    const user = vj && vj.users && vj.users[0];
    if (!user || !user.localId) {
      console.error('sage-token: firebase returned no user for a valid-looking token');
      return res.status(401).json({ error: 'auth_invalid' });
    }
    if (user.disabled) return res.status(403).json({ error: 'account_disabled' });

    // GATE A — verified email. A scripted signup cannot pass this.
    if (user.emailVerified !== true) {
      console.error('sage-token: unverified email rejected. uid=' + user.localId);
      return res.status(403).json({ error: 'email_unverified' });
    }

    uid = user.localId;
  } catch (e) {
    console.error('sage-token: verification threw: ' + (e && e.message));
    return res.status(401).json({ error: 'auth_invalid' });
  }

  // 3) GATE B — the account must be approved.
  //
  // Read clients/{uid} through the Firestore REST API using the CALLER'S own
  // ID token. No service account and no new credential is needed: the security
  // rules already allow a client to `get` their own profile, and nothing else.
  //
  // The two failure modes are reported with DIFFERENT error codes on purpose:
  //   not_approved       - the document was read and the account is not approved
  //   profile_unreadable - the read itself failed (network, or App Check
  //                        enforcement rejecting a server-side REST call)
  // Both deny access. The distinction exists so a single glance at the browser
  // console says whether this is a policy decision or a plumbing problem.
  try {
    const fsUrl =
      'https://firestore.googleapis.com/v1/projects/' +
      encodeURIComponent(PROJECT_ID) +
      '/databases/(default)/documents/clients/' +
      encodeURIComponent(uid);

    const pr = await fetch(fsUrl, {
      headers: { Authorization: 'Bearer ' + idToken }
    });

    if (!pr.ok) {
      console.error('sage-token: profile read failed. http=' + pr.status + ' uid=' + uid);
      return res.status(403).json({ error: 'profile_unreadable' });
    }

    const doc = await pr.json();
    const status =
      doc && doc.fields && doc.fields.status && doc.fields.status.stringValue;

    if (status !== 'approved') {
      console.error('sage-token: account not approved. uid=' + uid);
      return res.status(403).json({ error: 'not_approved' });
    }
  } catch (e) {
    console.error('sage-token: profile check threw: ' + (e && e.message));
    return res.status(403).json({ error: 'profile_unreadable' });
  }

  // 4) Throttle per user, then check the absolute daily ceiling.
  if (throttled(uid)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  if (globalCapReached()) {
    console.error('sage-token: GLOBAL DAILY CAP REACHED — investigate usage');
    return res.status(503).json({ error: 'daily_cap' });
  }

  // 5) Ask ElevenLabs for a signed URL. Valid ~15 minutes.
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
