/**
 * The private-Sheet path: service account JWT -> access token -> Sheets API.
 *
 * These tests generate a real RSA keypair, let the Worker sign a real
 * assertion with it, and verify that assertion with the matching public key —
 * so they prove the JWT Google would receive is genuinely valid, rather than
 * just asserting our code called something.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "../src/index.js";
import { fetchRosterRows, resetTokenCache, SheetsError } from "../src/sheets.js";
import { resetKeyCache } from "../src/google-auth.js";
import { loadConfig, ConfigError } from "../src/config.js";
import { makeKeyPair, signToken, validPayload, TEST_ENV } from "./helpers.mjs";

const { subtle } = webcrypto;

async function makeServiceAccount() {
  const pair = await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    email: "rsvp-portal@rsvp-points-portal.iam.gserviceaccount.com",
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

const sa = await makeServiceAccount();
const google = await makeKeyPair("google-kid");

const ROWS = [
  ["Email", "Name", "Points", "Standing"],
  ["abc123@scarletmail.rutgers.edu", "John Smith", 14, "Good Standing"],
  ["low789@scarletmail.rutgers.edu", "Sam Lee", 3],
];

const API_ENV = {
  ...TEST_ENV,
  SHEET_CSV_URL: "",
  SHEET_ID: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
  GOOGLE_SA_EMAIL: sa.email,
  GOOGLE_SA_PRIVATE_KEY: sa.pem,
};

function apiStub({ rows = ROWS, valuesStatus = 200, tokenStatus = 200 } = {}) {
  const calls = { token: 0, values: 0, assertions: [], authHeaders: [] };
  const impl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("oauth2.googleapis.com/token")) {
      calls.token++;
      calls.assertions.push(new URLSearchParams(init.body).get("assertion"));
      if (tokenStatus !== 200) {
        return new Response("bad key", { status: tokenStatus });
      }
      return new Response(
        JSON.stringify({ access_token: `tok-${calls.token}`, expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("sheets.googleapis.com")) {
      calls.values++;
      calls.authHeaders.push(init?.headers?.Authorization);
      if (valuesStatus !== 200) return new Response("nope", { status: valuesStatus });
      return new Response(JSON.stringify({ values: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("googleapis.com/oauth2/v3/certs")) {
      return new Response(JSON.stringify(google.jwks), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => {
  resetTokenCache();
  resetKeyCache();
});

test("the assertion we send Google is a genuinely valid RS256 JWT", async () => {
  const stub = apiStub();
  const config = loadConfig(API_ENV);
  await fetchRosterRows(config, { fetchImpl: stub, now: 1_700_000_000, subtle });

  const [header, payload, signature] = stub.calls.assertions[0].split(".");
  const verified = await subtle.verify(
    "RSASSA-PKCS1-v1_5",
    sa.publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`)
  );
  assert.ok(verified, "Google would reject an assertion that fails this check");

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, sa.email);
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets.readonly");
  // Read-only: the portal must never be able to modify the roster.
  assert.ok(!claims.scope.includes("drive"));
  assert.equal(claims.exp - claims.iat, 3600);
});

test("a private Sheet produces the same roster the CSV did", async () => {
  globalThis.fetch = apiStub();
  const token = await signToken(google, validPayload());
  const response = await worker.fetch(
    new Request("https://worker.test/api/me", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://rsvp-portal.pages.dev" },
    }),
    API_ENV
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.member.name, "John Smith");
  assert.equal(body.member.points, 14);
  assert.equal(body.member.standing, "good");
});

test("the access token is reused rather than re-minted per request", async () => {
  const stub = apiStub();
  const config = loadConfig(API_ENV);
  await fetchRosterRows(config, { fetchImpl: stub, now: 1_700_000_000, subtle });
  await fetchRosterRows(config, { fetchImpl: stub, now: 1_700_000_030, subtle });

  assert.equal(stub.calls.token, 1, "signed a second JWT unnecessarily");
  assert.equal(stub.calls.values, 2);
});

test("an expired cached token is re-minted", async () => {
  const stub = apiStub();
  const config = loadConfig(API_ENV);
  await fetchRosterRows(config, { fetchImpl: stub, now: 1_700_000_000, subtle });
  await fetchRosterRows(config, { fetchImpl: stub, now: 1_700_004_000, subtle });
  assert.equal(stub.calls.token, 2);
});

test("a revoked token is retried once with a fresh one", async () => {
  let seen = 0;
  const stub = apiStub();
  const wrapped = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("sheets.googleapis.com") && seen++ === 0) {
      return new Response("expired", { status: 401 });
    }
    return stub(input, init);
  };
  wrapped.calls = stub.calls;

  const config = loadConfig(API_ENV);
  const rows = await fetchRosterRows(config, { fetchImpl: wrapped, now: 1_700_000_000, subtle });
  assert.equal(rows[1][1], "John Smith");
  assert.equal(stub.calls.token, 2, "should have minted a replacement token");
});

test("a Sheet not shared with the service account says exactly that", async () => {
  const config = loadConfig(API_ENV);
  await assert.rejects(
    () => fetchRosterRows(config, { fetchImpl: apiStub({ valuesStatus: 403 }), now: 1, subtle }),
    (error) => error instanceof SheetsError && error.message.includes(sa.email)
  );
});

test("a wrong Sheet id says so, rather than a generic failure", async () => {
  const config = loadConfig(API_ENV);
  await assert.rejects(
    () => fetchRosterRows(config, { fetchImpl: apiStub({ valuesStatus: 404 }), now: 1, subtle }),
    (error) => error instanceof SheetsError && /No Sheet found/.test(error.message)
  );
});

test("a rejected service account key surfaces Google's reason", async () => {
  const config = loadConfig(API_ENV);
  await assert.rejects(
    () => fetchRosterRows(config, { fetchImpl: apiStub({ tokenStatus: 400 }), now: 1, subtle }),
    (error) => error instanceof SheetsError && /refused the service account/.test(error.message)
  );
});

test("a private key pasted with literal backslash-n still works", async () => {
  const escaped = { ...API_ENV, GOOGLE_SA_PRIVATE_KEY: sa.pem.replace(/\n/g, "\\n") };
  const stub = apiStub();
  const rows = await fetchRosterRows(loadConfig(escaped), {
    fetchImpl: stub,
    now: 1_700_000_000,
    subtle,
  });
  assert.equal(rows[1][1], "John Smith");
});

test("numbers from the API are read as points, and short rows survive", async () => {
  const stub = apiStub();
  const rows = await fetchRosterRows(loadConfig(API_ENV), {
    fetchImpl: stub,
    now: 1_700_000_000,
    subtle,
  });
  // UNFORMATTED_VALUE gives 14 as a number; the roster needs a usable string.
  assert.equal(rows[1][2], "14");
  // Sheets omits trailing empty cells — this row has no Standing column.
  assert.equal(rows[2].length, 3);
});

test("a half-configured migration fails loudly instead of using the public CSV", async () => {
  // Silently falling back would be an invisible downgrade in privacy.
  assert.throws(
    () => loadConfig({ ...TEST_ENV, SHEET_ID: "abc" }),
    (error) =>
      error instanceof ConfigError &&
      /GOOGLE_SA_EMAIL/.test(error.message) &&
      /GOOGLE_SA_PRIVATE_KEY/.test(error.message)
  );
});

test("the CSV path still works when no API settings are present", async () => {
  const config = loadConfig(TEST_ENV);
  assert.equal(config.rosterSource, "csv");
  assert.equal(loadConfig(API_ENV).rosterSource, "api");
});
