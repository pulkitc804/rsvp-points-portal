/**
 * Verifies a Google ID token.
 *
 * This is the security core of the portal. The browser never tells us who the
 * member is; it sends a token that Google signed, and we check that signature
 * ourselves before reading the email out of the payload. A member who edits
 * anything in devtools produces a token that fails verification.
 */

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

let keyCache = { keys: null, expiresAt: 0, fetchedAt: 0 };

// An unknown key id may mean Google rotated its signing keys, so we refetch.
// Without a floor on how often, anyone can send tokens bearing random key ids
// and turn this Worker into an amplifier against Google's endpoint, adding a
// round trip to every request while they do it. Google publishes a new key
// well before it signs with it, so a minute of staleness costs nothing.
const MIN_REFETCH_SECONDS = 60;

function decodeBase64Url(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  let binary;
  try {
    binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    // atob throws on characters outside the alphabet. Every segment here is
    // attacker-supplied, so this has to be a clean rejection rather than an
    // exception escaping into the generic 500 handler.
    throw new AuthError("invalid_token", "Sign-in token is not correctly encoded.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
  } catch {
    throw new AuthError("invalid_token", "Sign-in token could not be read.");
  }
}

async function fetchKeys(fetchImpl, now) {
  const response = await fetchImpl(JWKS_URL);
  if (!response.ok) {
    throw new AuthError(
      "verification_unavailable",
      "Could not reach Google to verify your sign-in."
    );
  }
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];

  // Respect Google's cache header; fall back to an hour.
  const cacheControl = response.headers?.get?.("cache-control") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
  keyCache = {
    keys,
    expiresAt: now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 3600),
    fetchedAt: now,
  };
  return keys;
}

async function keyFor(kid, fetchImpl, now) {
  if (!keyCache.keys || keyCache.expiresAt <= now) {
    await fetchKeys(fetchImpl, now);
  }

  let jwk = keyCache.keys.find((key) => key.kid === kid);
  if (!jwk && now - keyCache.fetchedAt >= MIN_REFETCH_SECONDS) {
    // Google rotates signing keys. An unknown kid may just mean our cache is
    // stale, so refetch — but no more often than MIN_REFETCH_SECONDS.
    await fetchKeys(fetchImpl, now);
    jwk = keyCache.keys.find((key) => key.kid === kid);
  }
  if (!jwk) {
    throw new AuthError("invalid_token", "Sign-in token was not signed by Google.");
  }
  return jwk;
}

/** Exposed for tests, which need a clean cache between cases. */
export function resetKeyCache() {
  keyCache = { keys: null, expiresAt: 0, fetchedAt: 0 };
}

export async function verifyGoogleIdToken(token, options) {
  const {
    clientId,
    now = Math.floor(Date.now() / 1000),
    fetchImpl = fetch,
    subtle = crypto.subtle,
  } = options;

  if (typeof token !== "string" || token.length === 0) {
    throw new AuthError("invalid_token", "No sign-in token was provided.");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthError("invalid_token", "Sign-in token is malformed.");
  }

  const header = decodeJson(parts[0]);
  // Reject "none" and any algorithm we are not actually checking. Without this
  // an attacker could present an unsigned token and claim to be anyone.
  if (header.alg !== "RS256") {
    throw new AuthError("invalid_token", "Sign-in token uses an unsupported signature.");
  }
  if (!header.kid) {
    throw new AuthError("invalid_token", "Sign-in token is missing its key id.");
  }

  const jwk = await keyFor(header.kid, fetchImpl, now);
  const key = await subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    signed
  );
  if (!valid) {
    throw new AuthError("invalid_token", "Sign-in token failed verification.");
  }

  const payload = decodeJson(parts[1]);

  if (!ISSUERS.has(payload.iss)) {
    throw new AuthError("invalid_token", "Sign-in token came from an unexpected issuer.");
  }

  // Without the audience check, a token issued for any other Google app could
  // be replayed against this Worker.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) {
    throw new AuthError("invalid_token", "Sign-in token was issued for a different app.");
  }

  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) {
    throw new AuthError("expired_token", "Your sign-in has expired.");
  }
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_SECONDS > now) {
    throw new AuthError("invalid_token", "Sign-in token is not valid yet.");
  }

  const email = String(payload.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new AuthError("invalid_token", "Sign-in token does not include an email address.");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new AuthError("invalid_token", "This Google account's email is not verified.");
  }

  return {
    email,
    name: String(payload.name ?? "").trim(),
    subject: payload.sub,
    hostedDomain: payload.hd ?? null,
  };
}
