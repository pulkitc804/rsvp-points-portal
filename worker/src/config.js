/**
 * Reads and validates the Worker's configuration.
 *
 * Everything the E-Board is likely to change lives in environment variables
 * (see wrangler.toml) so that adjusting thresholds or allowed domains never
 * requires editing code.
 */

export class ConfigError extends Error {
  constructor(problems) {
    super(`Worker is misconfigured: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return text(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function flag(value) {
  return /^(true|1|yes)$/i.test(text(value));
}

function wholeNumber(value, name, fallback, problems) {
  const raw = text(value);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    problems.push(`${name} must be a whole number of points, got "${raw}"`);
    return fallback;
  }
  return n;
}

export function loadConfig(env = {}) {
  const problems = [];

  const clientId = text(env.GOOGLE_CLIENT_ID);
  if (!clientId) problems.push("GOOGLE_CLIENT_ID is not set");

  // Two ways to read the roster. The Sheets API keeps the Sheet private and
  // is preferred; the published CSV is the simpler fallback, and is readable
  // by anyone holding the link.
  const sheetId = text(env.SHEET_ID);
  const serviceAccountEmail = text(env.GOOGLE_SA_EMAIL);
  const serviceAccountKey = text(env.GOOGLE_SA_PRIVATE_KEY);
  const sheetCsvUrl = text(env.SHEET_CSV_URL);

  // Any one of the three API settings signals intent to use the API, so a
  // half-finished migration fails loudly rather than quietly falling back to
  // the public CSV — which would be a silent downgrade in privacy.
  const wantsApi = Boolean(sheetId || serviceAccountEmail || serviceAccountKey);

  if (wantsApi) {
    if (!sheetId) problems.push("SHEET_ID is not set");
    if (!serviceAccountEmail) problems.push("GOOGLE_SA_EMAIL is not set");
    if (!serviceAccountKey) problems.push("GOOGLE_SA_PRIVATE_KEY is not set");
  } else if (!sheetCsvUrl) {
    problems.push(
      "No roster source configured: set SHEET_ID, GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY, or SHEET_CSV_URL"
    );
  } else if (!/^https:\/\//i.test(sheetCsvUrl)) {
    problems.push("SHEET_CSV_URL must be an https URL");
  }

  const allowedDomains = list(env.ALLOWED_DOMAINS);
  if (allowedDomains.length === 0) problems.push("ALLOWED_DOMAINS is empty");

  // Computed before the throw below, or its validation complaints are
  // collected into an array nobody reads and a typo silently defaults.
  const sheetCacheSeconds = wholeNumber(
    env.SHEET_CACHE_SECONDS,
    "SHEET_CACHE_SECONDS",
    30,
    problems
  );

  const good = wholeNumber(env.THRESHOLD_GOOD, "THRESHOLD_GOOD", 12, problems);
  const okay = wholeNumber(env.THRESHOLD_OKAY, "THRESHOLD_OKAY", 6, problems);
  if (good <= okay) {
    problems.push(
      `THRESHOLD_GOOD (${good}) must be greater than THRESHOLD_OKAY (${okay})`
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    clientId,
    rosterSource: wantsApi ? "api" : "csv",
    sheetId,
    sheetRange: text(env.SHEET_RANGE) || "A:D",
    serviceAccountEmail,
    serviceAccountKey,
    sheetCsvUrl,
    allowedDomains,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    requireHostedDomain: flag(env.REQUIRE_HOSTED_DOMAIN),
    thresholds: { good, okay },
    sheetCacheSeconds,
  };
}

/** True when the email's domain is one the E-Board has allowed. */
export function domainAllowed(email, allowedDomains) {
  const at = String(email).lastIndexOf("@");
  if (at === -1) return false;
  const domain = String(email).slice(at + 1).toLowerCase();
  return allowedDomains.includes(domain);
}
