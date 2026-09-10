/**
 * Test helpers: a local RSA keypair standing in for Google's signing keys.
 *
 * This lets the tests exercise the real signature-verification path (real
 * RS256, real WebCrypto) instead of stubbing verification out, which is the
 * only way a test can actually demonstrate that a forged token is rejected.
 */
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

export async function makeKeyPair(kid = "test-key-1") {
  const pair = await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const jwk = await subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid }] },
    kid,
  };
}

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const encodeJson = (value) => b64url(new TextEncoder().encode(JSON.stringify(value)));

export async function signToken({ privateKey, kid }, payload, header = {}) {
  const head = encodeJson({ alg: "RS256", typ: "JWT", kid, ...header });
  const body = encodeJson(payload);
  const signature = await subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

export function validPayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: "test-client-id.apps.googleusercontent.com",
    sub: "1234567890",
    email: "abc123@scarletmail.rutgers.edu",
    email_verified: true,
    name: "John Smith",
    hd: "scarletmail.rutgers.edu",
    iat: now - 10,
    exp: now + 3600,
    ...overrides,
  };
}

/** A fetch stand-in that serves the JWKS and the Sheet CSV. */
export function stubFetch({ jwks, csv, csvStatus = 200 }) {
  const calls = { jwks: 0, sheet: 0 };
  const impl = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("googleapis.com/oauth2/v3/certs")) {
      calls.jwks++;
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    }
    if (url.includes("sheet")) {
      calls.sheet++;
      return new Response(csv ?? "", { status: csvStatus });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

export const TEST_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  SHEET_CSV_URL: "https://example.test/sheet.csv",
  ALLOWED_DOMAINS: "scarletmail.rutgers.edu,rutgers.edu",
  ALLOWED_ORIGINS: "https://rsvp-portal.pages.dev",
  THRESHOLD_GOOD: "12",
  THRESHOLD_OKAY: "6",
};

export const SAMPLE_CSV = [
  "Email,Name,Points,Standing",
  "abc123@scarletmail.rutgers.edu,John Smith,14,Good Standing",
  "xyz456@scarletmail.rutgers.edu,Jane Doe,7,Okay Standing",
  "low789@scarletmail.rutgers.edu,Sam Lee,3,At Risk",
  ' spaced@scarletmail.rutgers.edu ,Trailing Space,12,',
  'comma@rutgers.edu,"Smith, John Jr.",6,',
].join("\n");
