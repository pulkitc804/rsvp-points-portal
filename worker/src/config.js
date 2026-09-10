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

  const sheetCsvUrl = text(env.SHEET_CSV_URL);
  if (!sheetCsvUrl) {
    problems.push("SHEET_CSV_URL is not set");
  } else if (!/^https:\/\//i.test(sheetCsvUrl)) {
    problems.push("SHEET_CSV_URL must be an https URL");
  }

  const allowedDomains = list(env.ALLOWED_DOMAINS);
  if (allowedDomains.length === 0) problems.push("ALLOWED_DOMAINS is empty");

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
    sheetCsvUrl,
    allowedDomains,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    requireHostedDomain: flag(env.REQUIRE_HOSTED_DOMAIN),
    thresholds: { good, okay },
    sheetCacheSeconds: wholeNumber(
      env.SHEET_CACHE_SECONDS,
      "SHEET_CACHE_SECONDS",
      30,
      problems
    ),
  };
}

/** True when the email's domain is one the E-Board has allowed. */
export function domainAllowed(email, allowedDomains) {
  const at = String(email).lastIndexOf("@");
  if (at === -1) return false;
  const domain = String(email).slice(at + 1).toLowerCase();
  return allowedDomains.includes(domain);
}
