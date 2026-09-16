/**
 * Reads the roster from a PRIVATE Google Sheet via the Sheets API.
 *
 * The alternative — publishing the Sheet to the web as CSV — makes the whole
 * roster readable by anyone who obtains the link: every member's name, email
 * and point total. This path keeps the Sheet private and shared only with a
 * service account that has read-only access.
 *
 * Google does not issue long-lived API keys for this. Instead the Worker signs
 * a short JWT with the service account's private key and exchanges it for an
 * access token that lasts an hour. All of that is doable with WebCrypto, so
 * there is no dependency to install.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export class SheetsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SheetsError";
  }
}

// An access token is good for an hour, so signing a new JWT per request would
// add a round trip to Google on every page load for no reason.
let tokenCache = { token: null, expiresAt: 0 };

/** Exposed for tests, which need a clean cache between cases. */
export function resetTokenCache() {
  tokenCache = { token: null, expiresAt: 0 };
}

function base64UrlFromBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromJson(value) {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Service account keys are PEM. Environment variables frequently carry the
 * newlines as a literal backslash-n, especially when pasted through a
 * dashboard, so both forms are accepted.
 */
function privateKeyToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new SheetsError("The service account private key is empty.");

  let binary;
  try {
    binary = atob(body);
  } catch {
    throw new SheetsError("The service account private key is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function requestAccessToken(config, now, fetchImpl, subtle) {
  const claims = {
    iss: config.serviceAccountEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlFromJson({ alg: "RS256", typ: "JWT" })}.${base64UrlFromJson(claims)}`;

  let key;
  try {
    key = await subtle.importKey(
      "pkcs8",
      privateKeyToDer(config.serviceAccountKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch (cause) {
    if (cause instanceof SheetsError) throw cause;
    throw new SheetsError(
      "The service account private key could not be read. Paste the whole private_key value from the JSON key file, including the BEGIN and END lines."
    );
  }

  const signature = await subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const assertion = `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;

  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
    });
  } catch (cause) {
    throw new SheetsError(`Could not reach Google to authorise: ${cause?.message ?? cause}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SheetsError(
      `Google refused the service account (${response.status}). ${detail.slice(0, 200)}`
    );
  }

  const body = await response.json().catch(() => null);
  if (!body?.access_token) {
    throw new SheetsError("Google's token response did not contain an access token.");
  }

  const lifetime = Number(body.expires_in);
  tokenCache = {
    token: body.access_token,
    expiresAt: now + (Number.isFinite(lifetime) ? lifetime : 3600),
  };
  return tokenCache.token;
}

async function accessToken(config, now, fetchImpl, subtle) {
  // Renew a minute early so a token cannot expire mid-request.
  if (tokenCache.token && tokenCache.expiresAt > now + 60) return tokenCache.token;
  return requestAccessToken(config, now, fetchImpl, subtle);
}

/**
 * Returns the Sheet's rows as an array of arrays, header row first — the same
 * shape the CSV parser produces, so buildRosterFromRows handles both.
 */
export async function fetchRosterRows(config, options = {}) {
  const {
    now = Math.floor(Date.now() / 1000),
    fetchImpl = fetch,
    subtle = crypto.subtle,
  } = options;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.sheetId)}` +
    `/values/${encodeURIComponent(config.sheetRange)}` +
    `?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;

  let response;
  let token = await accessToken(config, now, fetchImpl, subtle);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (cause) {
      throw new SheetsError(`Could not reach the Sheets API: ${cause?.message ?? cause}`);
    }

    // A cached token can be revoked before it expires. Re-mint once, then give up.
    if (response.status === 401 && attempt === 0) {
      resetTokenCache();
      token = await accessToken(config, now, fetchImpl, subtle);
      continue;
    }
    break;
  }

  if (response.status === 403) {
    throw new SheetsError(
      `The Sheet is not shared with ${config.serviceAccountEmail}. Share it with that address as a Viewer.`
    );
  }
  if (response.status === 404) {
    throw new SheetsError(`No Sheet found with id ${config.sheetId}.`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SheetsError(`Sheets API responded ${response.status}. ${detail.slice(0, 200)}`);
  }

  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.values)) {
    throw new SheetsError("The Sheets API response did not contain any rows.");
  }

  // UNFORMATTED_VALUE returns numbers as numbers; downstream expects strings
  // it can trim and parse, and a genuinely empty cell must stay empty.
  return body.values.map((row) =>
    row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
  );
}
