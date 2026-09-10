import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";
import { buildRoster, findMember, parsePoints, normalizeEmail, RosterError } from "../src/roster.js";
import { standingFor, describeStanding, STANDING } from "../src/standing.js";
import { loadConfig, domainAllowed, ConfigError } from "../src/config.js";
import { SAMPLE_CSV, TEST_ENV } from "./helpers.mjs";

test("CSV parser keeps commas inside quoted names", () => {
  const rows = parseCsv('Email,Name\na@b.c,"Smith, John Jr."');
  assert.deepEqual(rows[1], ["a@b.c", "Smith, John Jr."]);
});

test("CSV parser handles CRLF, escaped quotes and a BOM", () => {
  const rows = parseCsv('﻿Name\r\n"He said ""hi"""\r\n');
  assert.deepEqual(rows, [["Name"], ['He said "hi"']]);
});

test("roster finds columns by name regardless of order", () => {
  const { members } = buildRoster("Points,Name,Email\n9,Jane Doe,jane@rutgers.edu");
  assert.equal(findMember({ members }, "jane@rutgers.edu").points, 9);
});

test("roster tolerates an unknown extra column (forward compatibility)", () => {
  const { members } = buildRoster(
    "Email,Name,Points,Notes,Activity History\nj@rutgers.edu,Jane,9,paid dues,3 events"
  );
  assert.equal(findMember({ members }, "j@rutgers.edu").points, 9);
});

test("roster accepts Total Points as a header spelling", () => {
  const { members } = buildRoster("Email,Name,Total Points\nj@rutgers.edu,Jane,20");
  assert.equal(findMember({ members }, "j@rutgers.edu").points, 20);
});

test("roster rejects a Sheet missing a required column, naming what is missing", () => {
  assert.throws(
    () => buildRoster("Email,Name\nj@rutgers.edu,Jane"),
    (error) => error instanceof RosterError && /points/i.test(error.message)
  );
});

test("emails match despite spreadsheet whitespace and casing", () => {
  const { members } = buildRoster(SAMPLE_CSV);
  assert.ok(findMember({ members }, "SPACED@ScarletMail.Rutgers.edu"));
  assert.equal(normalizeEmail("  A@B.C  "), "a@b.c");
});

test("a blank Name cell falls back to the email local part", () => {
  const { members } = buildRoster("Email,Name,Points\nnobody@rutgers.edu,,4");
  assert.equal(findMember({ members }, "nobody@rutgers.edu").name, "nobody");
});

test("unreadable points become null rather than zero", () => {
  assert.equal(parsePoints("abc"), null);
  assert.equal(parsePoints(""), null);
  assert.equal(parsePoints(" 1,200 "), 1200);
  assert.equal(parsePoints("0"), 0);
});

test("duplicate rows are reported", () => {
  const { duplicates } = buildRoster(
    "Email,Name,Points\nj@rutgers.edu,Jane,9\nj@rutgers.edu,Jane,11"
  );
  assert.deepEqual(duplicates, ["j@rutgers.edu"]);
});

test("standing thresholds are inclusive at each boundary", () => {
  const thresholds = { good: 12, okay: 6 };
  assert.equal(standingFor(12, thresholds), STANDING.GOOD);
  assert.equal(standingFor(11, thresholds), STANDING.OKAY);
  assert.equal(standingFor(6, thresholds), STANDING.OKAY);
  assert.equal(standingFor(5, thresholds), STANDING.AT_RISK);
  assert.equal(standingFor(0, thresholds), STANDING.AT_RISK);
});

test("standing follows changed thresholds without code edits", () => {
  assert.equal(standingFor(14, { good: 20, okay: 10 }), STANDING.OKAY);
  assert.equal(describeStanding(20, { good: 20, okay: 10 }).label, "Good Standing");
});

test("standing copy matches the wording in the brief", () => {
  assert.equal(
    describeStanding(14, { good: 12, okay: 6 }).message,
    "You are currently meeting RSVP's active-member expectations."
  );
});

test("config rejects thresholds that overlap", () => {
  assert.throws(
    () => loadConfig({ ...TEST_ENV, THRESHOLD_GOOD: "5", THRESHOLD_OKAY: "6" }),
    (error) => error instanceof ConfigError && /must be greater/.test(error.message)
  );
});

test("config rejects a missing client id or sheet url", () => {
  assert.throws(() => loadConfig({ ...TEST_ENV, GOOGLE_CLIENT_ID: "" }), ConfigError);
  assert.throws(() => loadConfig({ ...TEST_ENV, SHEET_CSV_URL: "" }), ConfigError);
  assert.throws(() => loadConfig({ ...TEST_ENV, SHEET_CSV_URL: "http://insecure.test" }), ConfigError);
});

test("domain allowlist accepts both Rutgers domains and rejects lookalikes", () => {
  const domains = loadConfig(TEST_ENV).allowedDomains;
  assert.ok(domainAllowed("a@scarletmail.rutgers.edu", domains));
  assert.ok(domainAllowed("a@RUTGERS.EDU", domains));
  assert.equal(domainAllowed("a@gmail.com", domains), false);
  assert.equal(domainAllowed("a@notrutgers.edu", domains), false);
  // The check must read the domain, not merely find the string somewhere.
  assert.equal(domainAllowed("rutgers.edu@evil.test", domains), false);
  assert.equal(domainAllowed("a@rutgers.edu.evil.test", domains), false);
});
