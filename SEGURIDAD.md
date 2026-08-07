# SEGURIDAD.md — Bridg Connects LLC

Living security specification for the `bridg-connects` web application.

**Last updated:** August 6, 2026
**Firebase project:** `bridg-connects`
**Production host:** Vercel → `bridgconnects.com`

This document is the reference of record. Any new endpoint, Cloud Function,
security rule, or page must be reviewed against it, and this file must be
updated in the same commit that changes behavior. If code and this document
disagree, that is a defect — resolve it before shipping.

---

## 1. Architecture at a glance

Static HTML/JS on Vercel. No application server of our own. All authorization
is enforced server-side by Firebase Security Rules, never by the browser.

| Layer | Service | Enforcement point |
|---|---|---|
| Identity | Firebase Authentication (email/password) | Firebase |
| Structured data | Cloud Firestore | Firestore Security Rules |
| Documents (PDF) | Firebase Storage | Storage Security Rules |
| Bot / abuse defense | Firebase App Check (reCAPTCHA v3) | Firebase, enforced |
| Transport & content | Vercel response headers | Browser (CSP, HSTS) |
| Delivery operations | Shipday (third party) | Shipday |

**Design principle:** the client is untrusted. Any control implemented only in
JavaScript is a convenience, not a security boundary. Every real boundary lives
in Firebase Rules.

---

## 2. Identity and the two gates

Access is governed by two independent gates. Confusing them is the most likely
source of future mistakes, so they are stated explicitly.

### Gate 1 — Manual approval (controls portal access)

Every new signup writes `clients/{uid}` with `status: 'pending'`. The portal
refuses to render its operational views unless `status === 'approved'`.
Approval is granted by a human (admin) through **Admin → Review accounts**.

- Set by: admin, via `_bridgListClients` + status update
- Enforced in: Firestore rules on `clients/{uid}`, plus portal render logic
- Effect if missing: user sees "Your account is being reviewed"

### Gate 2 — Verified email address (controls document access)

Storage rules require `request.auth.token.email_verified == true`. A signed-in,
approved client whose email is unverified can use the portal and book pickups,
but cannot list or download any PDF.

- Set by: the user, by clicking the link in the verification email
- Sent by: `sendEmailVerification()` at signup (`index.html`)
- Enforced in: Storage rules only
- Effect if missing: Invoices & PODs panels show a notice explaining what to do,
  with a resend button (`window.resendVerification`)

**Deliberate asymmetry:** booking a pickup does *not* require a verified email.
Blocking revenue-generating actions because a client could not find an email in
their spam folder costs more than it protects. Reading financial documents does
require it, because that is the asset worth protecting.

### Admin authority

Admin status is an email allowlist inside the Firestore rules `isAdmin()`
function. It is not a field in the database, not a custom claim, and not a
front-end flag — so it cannot be granted by writing to Firestore.

Current admins:

- `admin@bridgconnects.com`
- `89pgu8-jqp3u3@novarholding.com`
- `k.vargas@novarholding.com`

**Operational rule:** always keep at least two working admin accounts. Losing
the only admin account means losing the ability to approve any client, and it
cannot be recovered from the app — only by editing rules in the Firebase console.

**Known incident (Aug 6, 2026):** restoring an earlier version of the Firestore
rules silently reverted an admin allowlist change made the day before, removing
admin access. Rules are versioned in the Firebase console; before restoring an
old version, diff it against current to see what else the restore will undo.

---

## 3. Public vs. private surfaces

### Public (no authentication)

| Path | Purpose |
|---|---|
| `/` (`index.html`) | Marketing, quoting, signup, login |
| `/drivers`, `/recruit` | Driver recruiting |
| `/help` | Help center, Sage AI assistant |
| `/portfolio`, `/ai-core` | Company pages |
| `/terms`, `/privacy`, `/sms-terms`, `/ai-disclosure` | Legal |
| `/sitemap.xml`, `/robots.txt` | Crawler metadata |

Public pages may create data (quote requests, driver applications) but may never
read another party's data.

### Private (authentication required)

| Path | Requires |
|---|---|
| `/portal` | Signed in + `status === 'approved'` |
| `/portal` → Invoices & PODs (documents) | The above + verified email |
| `/portal` → Admin section | Email present in `isAdmin()` allowlist |

The Admin section is not merely hidden in CSS. `probeAdmin()` asks the server
for the client list; a non-admin receives `permission-denied` and the section is
never mounted. A non-admin cannot reveal it by editing the DOM, because the data
it would display is refused by Firestore.

### Local-only (never deployed)

`bridg-docs-LOCAL.html` — invoice and BOL generator. Runs from the local
filesystem. No Firebase, no network, no authentication. History in
`localStorage`. **This file must never be committed to a public repository.**
An earlier public version contained a hardcoded password and has been removed.

---

## 4. Firestore collections and rules

Rules helpers: `isSignedIn()`, `isAdmin()`, `ownsExisting()` (compares
`resource.data.uid` to the caller), `ownsIncoming()` (compares
`request.resource.data.uid` to the caller).

| Collection | Read | Write | Notes |
|---|---|---|---|
| `invoices/{id}` | admin only | admin only | Financial records. No client access. |
| `clients/{uid}` | owner or admin | owner (own doc) or admin | Document ID **is** the uid; a client cannot address another client's profile. `status` is admin-controlled. |
| `bookings/{id}` | owner or admin | owner (`ownsIncoming`) or admin | Written from both `/` and `/portal`. |
| everything else | denied | denied | Default-deny catch-all is intentional and must remain the last rule. |

**Client isolation was verified manually in the Firebase Rules Playground.**
Repeat that verification after any change to these rules.

**Closed privilege-escalation path (Aug 6, 2026).** The `clients/{clientUid}`
rule originally granted `read, write` in a single statement. Because a client
may legitimately write their own profile document, that also let them rewrite
`status` — meaning a signed-in client could set `status: 'approved'` from the
browser console and walk straight past Gate 1. Discovered while writing this
document; closed the same day.

The rule is now split by operation:

- `read` — admin, or the owner of the document
- `create` — admin, or the owner **and** `request.resource.data.status == 'pending'`
- `update` — admin, or the owner **and** `request.resource.data.status == resource.data.status`
- `delete` — admin only

Approval is therefore reachable only through `isAdmin()`. Verified after
publishing by completing a fresh signup and an admin approval.

**Lesson to carry forward:** `allow read, write` on a collection users can write
is a smell worth checking every time. Ask which individual fields the user is
being handed control of, not just which documents.

---

## 5. Storage layout and rules

Bucket: `bridg-connects.firebasestorage.app` (region `us-east1`).

```
docs/{clientEmail}/BC-INV-####.pdf     invoices
docs/{clientEmail}/BC-BOL-####.pdf     bills of lading
```

Folder names are the client's **login email, lowercased**. Chosen over uid so
folders are human-readable and match the operator's local folder structure.

**Rules:**

- Read: signed in, `email_verified == true`, and token email (lowercased)
  matches the folder name.
- Write: `allow write: if false` for all web clients. Uploads happen through the
  Firebase console or the Admin SDK, which bypass rules by design. No browser
  session can write, overwrite, or delete a document.
- Default-deny catch-all on `/{allPaths=**}`.

**Client-side hardening:** filenames are validated against a strict allowlist
(`/^BC-(INV|BOL)-[A-Za-z0-9._-]{1,40}\.pdf$/`) and HTML-escaped before being
inserted into the DOM. This prevents a maliciously named uploaded file from
becoming stored XSS. Firebase account emails cannot contain `/`, so folder
traversal is not reachable through the email path segment.

**Accepted risk — permanent download tokens.** `getDownloadURL()` returns a URL
containing a long-lived token that works without a session. If a client
forwards that link, the recipient can open that one file. Scope is a single
document belonging to a client who already had it; it is not an access path to
anyone else's data. Mitigation available if needed: a Cloud Function issuing
short-lived signed URLs (the project is on the Blaze plan, so this is
available). Revocation today is manual: rotate the file's token in the console.

**Operational note:** creating a client folder is a manual step. If document
volume exceeds roughly ten deliveries per day, automate it — manual steps get
skipped under load, and a skipped folder looks to the client like a broken portal.

---

## 6. App Check

Enforced (not monitor-only) on Cloud Firestore and Authentication.

- Provider: reCAPTCHA v3
- Site key: `6Lfjz2YtAAAAAHnuivJ87A0p_BD0_-3AzjJaOYXN`
- Initialized in both `index.html` and `portal.html`
- `isTokenAutoRefreshEnabled: true`
- Initialization is wrapped in `try/catch`; failure is logged, not fatal

Verified metrics reached 100% before enforcement was turned on. Enforcement is
**not** yet enabled on Storage — the console still shows the "Configure App
Check" prompt on the Storage tab. Consider enabling it, and watch the verified
percentage for a period before enforcing, or legitimate document reads will
start failing.

---

## 7. Transport and content security

Set in `vercel.json` for all routes:

| Header | Value / intent |
|---|---|
| `Strict-Transport-Security` | 2 years, `includeSubDomains`, `preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, payment, USB, magnetometer, accelerometer denied; microphone allowed only for the ElevenLabs voice assistant |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |
| `Content-Security-Policy` | strict allowlist, see below |

CSP notes:

- `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`
- `connect-src` is an explicit allowlist. **Adding a new Google or third-party
  service requires adding its domain here, or the browser silently blocks it.**
  This has already caused one debugging session: Storage reads failed until
  `https://firebasestorage.googleapis.com` was added.
- `script-src` includes `'unsafe-inline'`. This is a real weakness, required by
  the current inline-script architecture. It means a successful HTML injection
  anywhere could execute script. Mitigation today is rigorous output escaping at
  every sink. Moving to nonces or external scripts would be a genuine
  improvement; treat it as technical debt, not as resolved.

The Firebase Web API key in client code is a public project identifier, not a
secret. It grants nothing on its own — authorization comes from rules and App
Check.

---

## 8. Input handling standard

Every user-supplied value must be validated against a strict schema — type,
length, allowed characters, enum where applicable — and escaped at the point of
output, **before** it is written to Firestore or rendered.

Rules that apply without exception:

1. Client-side validation is for user experience only. Never rely on it as a
   control; the same request can be replayed from a console.
2. Escape at the sink. Anything reaching `innerHTML` passes through an HTML
   escaper first. Prefer `textContent` when markup is not required.
3. Allowlist, never blocklist. Filenames, IDs, and enums are matched against
   patterns of what is permitted.
4. Never interpolate untrusted values into a Firestore document path.
5. Bound the size of every string written to Firestore.

---

## 9. Third-party services

| Service | Trust boundary |
|---|---|
| Shipday | Dispatch, driver app, tracking, proof of delivery. Holds delivery addresses and POD images. |
| ElevenLabs | "Sage" voice assistant on `/help`. Microphone access is granted only to this origin. |
| EmailJS | Form-to-email relay. Public key is exposed by design; treat templates as untrusted routing. |
| Stripe | Payment links. No card data touches our code. |
| Google Apps Script | Sage callback notifications. |
| Calendly | Scheduling. Framed via CSP allowlist. |

**Outstanding:** EmailJS dashboard templates still route submissions to legacy
Novar addresses instead of `@bridgconnects.com`. Correct the `To` field.

---

## 10. Red team protocol (standing requirement)

Whenever backend code, an endpoint, a security rule, or a Cloud Function is
written or modified, it must then be reviewed as an adversary would, without
waiting to be asked. Coverage:

- OWASP Top 10
- Broken authorization and IDOR — can identifier substitution reach another
  tenant's data?
- Injection at every sink — HTML, Firestore paths, query construction
- Authentication bypass — can a gate be skipped by replaying a request or
  editing client state?
- Rate limiting and abuse — what does repeated invocation cost?

Findings are reported with severity and a concrete mitigation, including
findings that are accepted rather than fixed. An accepted risk that is written
down is manageable; an unrecorded one is not.

---

## 11. Open items

| Item | Severity | Status |
|---|---|---|
| App Check not enforced on Storage | Medium | Pending |
| `'unsafe-inline'` in `script-src` | Medium | Accepted, technical debt |
| Verification emails land in spam (`firebaseapp.com` sender) | Medium | Blocked — Firebase template editing disabled for this project; resolve via custom SMTP or custom domain with SPF/DKIM |
| Permanent Storage download tokens | Low | Accepted |
| Pre-existing accounts were created before email verification existed | Low | Resolve individually via password-reset flow |
| Manual folder creation per client | Low | Automate above ~10 deliveries/day |

---

## 12. Incident response

1. **Contain.** Revoke the affected account in Firebase Authentication, or set
   the relevant rule to `allow read, write: if false` to close the surface.
   Rules deploy in seconds and are the fastest available kill switch.
2. **Assess.** Firestore and Storage rules are versioned in the console; compare
   the active version against the last known-good one.
3. **Recover.** Restore rules from version history — after diffing, so a restore
   does not silently undo an unrelated later change (see §2).
4. **Record.** Add the incident to this document. The Aug 6 admin-lockout entry
   exists because an undocumented incident is an incident that repeats.

---

*Bridg Connects LLC · USDOT 9709109 · MC-88040280 · Licensed Property Broker · Burbank, CA*
