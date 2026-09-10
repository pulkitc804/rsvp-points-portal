/**
 * RSVP Points Portal — Cloudflare Worker
 *
 * GET /api/me      Authorization: Bearer <Google ID token>
 *                  Returns the signed-in member's own row, and nothing else.
 * GET /api/health  Liveness check that reveals no member data.
 *
 * There is deliberately no endpoint that takes an email, a member id, or any
 * other identifier. The only way to name a member is to hold a Google token
 * for them, which is what makes "look up someone else's points" impossible
 * rather than merely discouraged.
 */
import { loadConfig, domainAllowed, ConfigError } from "./config.js";
import { buildRoster, findMember, RosterError } from "./roster.js";
import { describeStanding } from "./standing.js";
import { verifyGoogleIdToken, AuthError } from "./google-auth.js";

const FAILURES = {
  invalid_token: {
    status: 401,
    message: "We could not verify your sign-in. Please sign in again.",
  },
  expired_token: {
    status: 401,
    message: "Your sign-in expired. Please sign in again.",
  },
  verification_unavailable: {
    status: 503,
    message: "Google sign-in is temporarily unreachable. Please try again in a moment.",
  },
  domain_not_allowed: {
    status: 403,
    message:
      "Please sign in with your Rutgers account. Personal Google accounts cannot access the portal.",
  },
  not_a_member: {
    status: 404,
    message:
      "You are signed in, but your Rutgers email is not on the RSVP member list yet. Contact the E-Board to be added.",
  },
  roster_unavailable: {
    status: 502,
    message: "We could not read the member list right now. Please try again in a moment.",
  },
  roster_invalid: {
    status: 500,
    message: "The member list is set up incorrectly. The E-Board has been given the details.",
  },
  server_misconfigured: {
    status: 500,
    message: "The portal is not configured correctly yet. Please contact the E-Board.",
  },
  not_found: { status: 404, message: "Not found." },
  method_not_allowed: { status: 405, message: "Method not allowed." },
};

function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  // An explicit allowlist rather than "*": the browser sends the member's
  // token to this Worker, so we only invite the sites we actually deployed.
  if (origin && allowedOrigins.includes(origin.toLowerCase())) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Member data must never be cached by a browser or a shared proxy.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function fail(code, headers, detail) {
  const failure = FAILURES[code] ?? FAILURES.not_found;
  return json(
    { error: code, message: detail ?? failure.message },
    failure.status,
    headers
  );
}

async function readRoster(config) {
  let response;
  try {
    response = await fetch(config.sheetCsvUrl, {
      redirect: "follow",
      cf: { cacheTtl: config.sheetCacheSeconds, cacheEverything: true },
    });
  } catch (cause) {
    throw new RosterFetchError(`Sheet request failed: ${cause?.message ?? cause}`);
  }
  if (!response.ok) {
    throw new RosterFetchError(`Sheet responded ${response.status}`);
  }
  return buildRoster(await response.text());
}

class RosterFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = "RosterFetchError";
  }
}

async function handleMe(request, config, headers) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) {
    return fail("invalid_token", headers, "Please sign in to view your points.");
  }

  const identity = await verifyGoogleIdToken(match[1], { clientId: config.clientId });

  // Check the domain before touching the roster. A personal Gmail address that
  // somehow ends up in the Sheet still must not get in, and this failure needs
  // a different message from "you are not a member yet".
  if (!domainAllowed(identity.email, config.allowedDomains)) {
    return fail("domain_not_allowed", headers);
  }

  // Stricter, opt-in domain enforcement. `hd` is set by Google only for
  // Workspace-managed accounts, so requiring it also rejects a consumer
  // Google account that merely uses a Rutgers address as its login. It is
  // off by default because Rutgers issues rutgers.edu addresses that are not
  // all Google-managed, and turning this on without checking would lock
  // those members out. See README, "Enforcing the Rutgers domain".
  if (config.requireHostedDomain) {
    const hostedDomain = String(identity.hostedDomain ?? "").toLowerCase();
    if (!hostedDomain || !config.allowedDomains.includes(hostedDomain)) {
      console.warn(
        `Rejected ${identity.email}: hosted domain "${hostedDomain || "none"}" not allowed.`
      );
      return fail("domain_not_allowed", headers);
    }
  }

  const roster = await readRoster(config);
  if (roster.duplicates.length > 0) {
    console.warn(
      `Sheet has duplicate rows for: ${roster.duplicates.join(", ")}. Using the last row for each.`
    );
  }

  const member = findMember(roster, identity.email);
  if (!member) {
    return fail("not_a_member", headers);
  }

  if (member.points === null) {
    console.error(`Points cell for ${member.email} is not a number.`);
    return fail(
      "roster_invalid",
      headers,
      "Your points have not been recorded correctly. Contact the E-Board."
    );
  }

  const standing = describeStanding(member.points, config.thresholds);

  return json(
    {
      member: {
        // Identity comes from the verified token; display details come from
        // the Sheet, which is the E-Board's source of truth for names.
        email: member.email,
        name: member.name,
        firstName: member.name.split(/\s+/)[0],
        points: member.points,
        standing: standing.standing,
        standingLabel: standing.label,
        standingMessage: standing.message,
      },
      thresholds: config.thresholds,
    },
    200,
    headers
  );
}

export default {
  async fetch(request, env) {
    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        // Report the misconfiguration without echoing it to members.
        return fail("server_misconfigured", { Vary: "Origin" });
      }
      throw error;
    }

    const headers = corsHeaders(request, config.allowedOrigins);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, thresholds: config.thresholds }, 200, headers);
    }

    if (url.pathname !== "/api/me") {
      return fail("not_found", headers);
    }

    if (request.method !== "GET") {
      return fail("method_not_allowed", headers);
    }

    try {
      return await handleMe(request, config, headers);
    } catch (error) {
      if (error instanceof AuthError) {
        // Log which check failed for us; tell the member only that sign-in
        // did not work. Naming the failed check would help someone probing
        // the endpoint and helps a real member not at all.
        console.warn(`Auth rejected (${error.code}): ${error.message}`);
        return fail(error.code, headers);
      }
      if (error instanceof RosterFetchError) {
        console.error(error.message);
        return fail("roster_unavailable", headers);
      }
      if (error instanceof RosterError) {
        console.error(error.message);
        return fail("roster_invalid", headers);
      }
      console.error("Unexpected failure:", error?.stack ?? error);
      return fail("server_misconfigured", headers, "Something went wrong. Please try again.");
    }
  },
};
