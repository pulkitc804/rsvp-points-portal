/**
 * The security requirements from the brief, as executable tests.
 *
 * "Make sure a member cannot access another member's data by changing an
 * email or other value in the browser" is the requirement these exist to
 * prove. Each test names the attack it represents.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { resetKeyCache } from "../src/google-auth.js";
import {
  makeKeyPair,
  signToken,
  validPayload,
  stubFetch,
  TEST_ENV,
  SAMPLE_CSV,
} from "./helpers.mjs";

const google = await makeKeyPair("google-kid");
const attacker = await makeKeyPair("google-kid"); // same kid, wrong key

function request(token, { origin = "https://rsvp-portal.pages.dev", path = "/api/me", method = "GET" } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://worker.test${path}`, { method, headers });
}

async function call(token, options = {}, env = TEST_ENV, csv = SAMPLE_CSV) {
  globalThis.fetch = stubFetch({ jwks: google.jwks, csv, csvStatus: options.csvStatus ?? 200 });
  const response = await worker.fetch(request(token, options), env);
  return { response, body: await response.json().catch(() => null) };
}

beforeEach(() => resetKeyCache());

test("a valid Rutgers member sees their own name, points and standing", async () => {
  const token = await signToken(google, validPayload());
  const { response, body } = await call(token);

  assert.equal(response.status, 200);
  assert.equal(body.member.email, "abc123@scarletmail.rutgers.edu");
  assert.equal(body.member.name, "John Smith");
  assert.equal(body.member.firstName, "John");
  assert.equal(body.member.points, 14);
  assert.equal(body.member.standing, "good");
  assert.equal(body.member.standingLabel, "Good Standing");
});

test("ATTACK: a token signed with someone else's key is rejected", async () => {
  const token = await signToken(attacker, validPayload());
  const { response, body } = await call(token);
  assert.equal(response.status, 401);
  assert.equal(body.error, "invalid_token");
});

test("ATTACK: editing the email in a real token invalidates its signature", async () => {
  const real = await signToken(google, validPayload());
  const [header, , signature] = real.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify(validPayload({ email: "xyz456@scarletmail.rutgers.edu" }))
  )
    .toString("base64url");

  const { response, body } = await call(`${header}.${forgedPayload}.${signature}`);
  assert.equal(response.status, 401);
  assert.equal(body.error, "invalid_token");
});

test("ATTACK: an unsigned alg=none token is rejected", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "google-kid" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(validPayload())).toString("base64url");

  const { response, body } = await call(`${header}.${payload}.`);
  assert.equal(response.status, 401);
  assert.equal(body.error, "invalid_token");
});

test("ATTACK: a token issued for a different Google app is rejected", async () => {
  const token = await signToken(google, validPayload({ aud: "some-other-app.apps.googleusercontent.com" }));
  const { response, body } = await call(token);
  assert.equal(response.status, 401);
  assert.equal(body.error, "invalid_token");
});

test("ATTACK: a token from an unexpected issuer is rejected", async () => {
  const token = await signToken(google, validPayload({ iss: "https://evil.test" }));
  const { response } = await call(token);
  assert.equal(response.status, 401);
});

test("ATTACK: an email query parameter is ignored, not honoured", async () => {
  const token = await signToken(google, validPayload());
  const { response, body } = await call(token, {
    path: "/api/me?email=xyz456@scarletmail.rutgers.edu",
  });

  assert.equal(response.status, 200);
  // Still the token holder's own row, not the email that was asked for.
  assert.equal(body.member.email, "abc123@scarletmail.rutgers.edu");
  assert.equal(body.member.points, 14);
});

test("a successful response leaks no other member's data", async () => {
  const token = await signToken(google, validPayload());
  const { body } = await call(token);
  const text = JSON.stringify(body);

  // The Worker reads the whole roster to find one row; only that row may
  // leave the Worker.
  for (const other of ["xyz456", "low789", "comma@rutgers.edu", "Jane Doe", "Sam Lee"]) {
    assert.ok(!text.includes(other), `response should not mention ${other}`);
  }
});

test("an expired sign-in is reported as expired, not as invalid", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(google, validPayload({ iat: now - 7200, exp: now - 3600 }));
  const { response, body } = await call(token);
  assert.equal(response.status, 401);
  assert.equal(body.error, "expired_token");
  assert.match(body.message, /sign in again/i);
});

test("an unverified Google email is rejected", async () => {
  const token = await signToken(google, validPayload({ email_verified: false }));
  const { response } = await call(token);
  assert.equal(response.status, 401);
});

test("no Authorization header asks the member to sign in", async () => {
  const { response, body } = await call(null);
  assert.equal(response.status, 401);
  assert.match(body.message, /sign in/i);
});

test("a personal Gmail account is refused on domain, before the roster is read", async () => {
  const token = await signToken(google, validPayload({ email: "someone@gmail.com", hd: undefined }));
  const fetchStub = stubFetch({ jwks: google.jwks, csv: SAMPLE_CSV });
  globalThis.fetch = fetchStub;

  const response = await worker.fetch(request(token), TEST_ENV);
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error, "domain_not_allowed");
  assert.match(body.message, /Rutgers account/);
  // The roster is never even fetched for a disallowed domain.
  assert.equal(fetchStub.calls.sheet, 0);
});

test("a Gmail address present in the Sheet still cannot sign in", async () => {
  const csv = "Email,Name,Points\nsomeone@gmail.com,Sneaky Sam,99";
  const token = await signToken(google, validPayload({ email: "someone@gmail.com" }));
  const { response, body } = await call(token, {}, TEST_ENV, csv);
  assert.equal(response.status, 403);
  assert.equal(body.error, "domain_not_allowed");
});

test("a valid Rutgers user who is not a member gets a clear, actionable error", async () => {
  const token = await signToken(google, validPayload({ email: "new999@scarletmail.rutgers.edu" }));
  const { response, body } = await call(token);

  assert.equal(response.status, 404);
  assert.equal(body.error, "not_a_member");
  assert.match(body.message, /not on the RSVP member list yet/);
  assert.match(body.message, /E-Board/);
});

test("thresholds come from configuration, so the E-Board can change them", async () => {
  const token = await signToken(google, validPayload());
  const strict = { ...TEST_ENV, THRESHOLD_GOOD: "20", THRESHOLD_OKAY: "10" };
  const { body } = await call(token, {}, strict);

  assert.equal(body.member.points, 14);
  assert.equal(body.member.standing, "okay");
  assert.deepEqual(body.thresholds, { good: 20, okay: 10 });
});

test("a member whose email has a stray space in the Sheet still matches", async () => {
  const token = await signToken(google, validPayload({ email: "spaced@scarletmail.rutgers.edu" }));
  const { response, body } = await call(token);
  assert.equal(response.status, 200);
  assert.equal(body.member.points, 12);
  assert.equal(body.member.standing, "good");
});

test("an unreachable Sheet returns a retry message, not a crash", async () => {
  const token = await signToken(google, validPayload());
  const { response, body } = await call(token, { csvStatus: 500 });
  assert.equal(response.status, 502);
  assert.equal(body.error, "roster_unavailable");
});

test("a Sheet missing the Points column fails loudly for the E-Board, softly for members", async () => {
  const token = await signToken(google, validPayload());
  const { response, body } = await call(token, {}, TEST_ENV, "Email,Name\nabc123@scarletmail.rutgers.edu,John");
  assert.equal(response.status, 500);
  assert.equal(body.error, "roster_invalid");
  // The member-facing message must not expose spreadsheet internals.
  assert.ok(!/column/i.test(body.message));
});

test("a non-numeric points cell is reported rather than scored as zero", async () => {
  const token = await signToken(google, validPayload());
  const csv = "Email,Name,Points\nabc123@scarletmail.rutgers.edu,John Smith,TBD";
  const { response, body } = await call(token, {}, TEST_ENV, csv);
  assert.equal(response.status, 500);
  assert.equal(body.error, "roster_invalid");
});

test("an unconfigured Worker fails safe without naming its variables", async () => {
  const { response, body } = await call(null, {}, { ...TEST_ENV, GOOGLE_CLIENT_ID: "" });
  assert.equal(response.status, 500);
  assert.equal(body.error, "server_misconfigured");
  assert.ok(!/GOOGLE_CLIENT_ID/.test(body.message));
});

test("CORS admits the deployed frontend and no one else", async () => {
  const token = await signToken(google, validPayload());
  globalThis.fetch = stubFetch({ jwks: google.jwks, csv: SAMPLE_CSV });

  const allowed = await worker.fetch(request(token), TEST_ENV);
  assert.equal(
    allowed.headers.get("Access-Control-Allow-Origin"),
    "https://rsvp-portal.pages.dev"
  );

  const denied = await worker.fetch(request(token, { origin: "https://evil.test" }), TEST_ENV);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(denied.headers.get("Vary"), "Origin");
});

test("member data is never cached", async () => {
  const token = await signToken(google, validPayload());
  const { response } = await call(token);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("preflight is answered for the allowed origin", async () => {
  globalThis.fetch = stubFetch({ jwks: google.jwks, csv: SAMPLE_CSV });
  const response = await worker.fetch(request(null, { method: "OPTIONS" }), TEST_ENV);
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Methods") ?? "", /GET/);
});

test("only GET is allowed on /api/me", async () => {
  const token = await signToken(google, validPayload());
  const { response, body } = await call(token, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(body.error, "method_not_allowed");
});

test("health check exposes thresholds but no member data", async () => {
  globalThis.fetch = stubFetch({ jwks: google.jwks, csv: SAMPLE_CSV });
  const response = await worker.fetch(request(null, { path: "/api/health" }), TEST_ENV);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, thresholds: { good: 12, okay: 6 } });
});

test("unknown paths 404", async () => {
  globalThis.fetch = stubFetch({ jwks: google.jwks, csv: SAMPLE_CSV });
  const response = await worker.fetch(request(null, { path: "/api/members" }), TEST_ENV);
  assert.equal(response.status, 404);
});

// --- Optional stricter domain enforcement (REQUIRE_HOSTED_DOMAIN) ----------

const STRICT_ENV = { ...TEST_ENV, REQUIRE_HOSTED_DOMAIN: "true" };

test("strict mode accepts a Rutgers Workspace account", async () => {
  const token = await signToken(google, validPayload({ hd: "scarletmail.rutgers.edu" }));
  const { response } = await call(token, {}, STRICT_ENV);
  assert.equal(response.status, 200);
});

test("strict mode rejects a consumer account using a Rutgers address", async () => {
  // No `hd` claim: Google is telling us this account is not domain-managed,
  // even though its email ends in a Rutgers domain.
  const token = await signToken(google, validPayload({ hd: undefined }));
  const { response, body } = await call(token, {}, STRICT_ENV);
  assert.equal(response.status, 403);
  assert.equal(body.error, "domain_not_allowed");
});

test("strict mode rejects a Workspace account from another domain", async () => {
  const token = await signToken(google, validPayload({ hd: "someothercollege.edu" }));
  const { response } = await call(token, {}, STRICT_ENV);
  assert.equal(response.status, 403);
});

test("default mode admits a Rutgers address with no hosted domain", async () => {
  const token = await signToken(google, validPayload({ hd: undefined }));
  const { response } = await call(token);
  assert.equal(response.status, 200);
});

// --- Hardening found in security review -----------------------------------

test("a token with a malformed signature segment is a 401, not a crash", async () => {
  const real = await signToken(google, validPayload());
  const [header, payload] = real.split(".");
  // "!!!!" is not valid base64url. Decoding it throws, and an uncaught throw
  // here would surface as a 500 "something went wrong" instead of a clean
  // rejection — and would log as an unexpected failure, burying real ones.
  const { response, body } = await call(`${header}.${payload}.!!!!`);
  assert.equal(response.status, 401);
  assert.equal(body.error, "invalid_token");
});

test("unknown key ids cannot be used to hammer Google's JWKS endpoint", async () => {
  const fetchStub = stubFetch({ jwks: google.jwks, csv: SAMPLE_CSV });
  globalThis.fetch = fetchStub;

  // Each request presents a different unknown kid. A naive implementation
  // refetches the key set every time, turning any unauthenticated caller
  // into an amplifier against Google and adding a round trip to every
  // request. Refetching must be throttled.
  for (let i = 0; i < 8; i++) {
    const token = await signToken(
      { privateKey: google.privateKey, kid: `rotated-${i}` },
      validPayload()
    );
    const response = await worker.fetch(request(token), TEST_ENV);
    assert.equal(response.status, 401);
  }

  assert.ok(
    fetchStub.calls.jwks <= 2,
    `expected at most 2 JWKS fetches, made ${fetchStub.calls.jwks}`
  );
});

// --- Findings from the completeness audit ---------------------------------

test("a network failure reaching Google is a retryable 503, not 'portal not configured'", async () => {
  // A real outage is a thrown fetch (DNS/TLS/reset), not a tidy non-200.
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("googleapis.com")) throw new TypeError("network error");
    return new Response(SAMPLE_CSV, { status: 200 });
  };
  const token = await signToken(google, validPayload());
  const response = await worker.fetch(request(token), TEST_ENV);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "verification_unavailable");
});

test("a non-JSON body from Google's key endpoint is also a 503", async () => {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("googleapis.com")) {
      return new Response("<html>proxy error</html>", { status: 200 });
    }
    return new Response(SAMPLE_CSV, { status: 200 });
  };
  const token = await signToken(google, validPayload());
  const response = await worker.fetch(request(token), TEST_ENV);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "verification_unavailable");
});

test("an unexpected internal failure is retryable, not reported as misconfiguration", async () => {
  // server_misconfigured tells the member the portal was never set up and
  // offers no retry. A transient bug must not present that way.
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("googleapis.com")) {
      return new Response(JSON.stringify(google.jwks), { status: 200 });
    }
    throw { notAnError: true }; // a non-Error throw from the Sheet read
  };
  const token = await signToken(google, validPayload());
  const response = await worker.fetch(request(token), TEST_ENV);
  const body = await response.json();
  assert.notEqual(body.error, "server_misconfigured");
});

test("a malformed SHEET_CACHE_SECONDS is reported, not silently defaulted", async () => {
  const { loadConfig, ConfigError } = await import("../src/config.js");
  assert.throws(
    () => loadConfig({ ...TEST_ENV, SHEET_CACHE_SECONDS: "30s" }),
    (error) => error instanceof ConfigError && /SHEET_CACHE_SECONDS/.test(error.message)
  );
});
