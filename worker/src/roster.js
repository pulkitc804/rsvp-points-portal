/**
 * Turns the published Sheet CSV into a lookup of members by email.
 *
 * Columns are found by header NAME, not by position, so the E-Board can
 * reorder columns, or add ones we do not know about yet (a Notes column, or
 * the activity history that V2 will want), without breaking the portal.
 */
import { parseCsv } from "./csv.js";

export class RosterError extends Error {
  constructor(message) {
    super(message);
    this.name = "RosterError";
  }
}

// Accepted spellings for each column we need. Compared case-insensitively
// with punctuation and spacing removed, so "Total Points" and "points" match.
const COLUMNS = {
  email: ["email", "emailaddress", "rutgersemail", "scarletmail"],
  name: ["name", "fullname", "membername"],
  points: ["points", "totalpoints", "pointtotal", "pointstotal"],
};

const canonical = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Points come from a spreadsheet cell, so they may be blank, "12", " 12 ",
 * or "1,200". Anything we cannot read as a number becomes null, which the
 * caller reports as a roster problem rather than silently scoring as zero.
 */
export function parsePoints(value) {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function findHeaderIndexes(headerRow) {
  const seen = headerRow.map(canonical);
  const indexes = {};
  const missing = [];

  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const index = seen.findIndex((cell) => aliases.includes(cell));
    if (index === -1) missing.push(field);
    else indexes[field] = index;
  }

  if (missing.length > 0) {
    throw new RosterError(
      `The member Sheet is missing a column for: ${missing.join(", ")}. ` +
        `Found headers: ${headerRow.map((h) => h.trim()).filter(Boolean).join(", ") || "(none)"}`
    );
  }

  return indexes;
}

/**
 * Build the roster from rows, whichever source produced them: a published CSV
 * or the Sheets API. Both arrive as an array of arrays with a header row, so
 * the column-name matching below is shared rather than duplicated.
 *
 * The Sheets API omits trailing empty cells, so a row may be shorter than the
 * header. Cell reads below tolerate that.
 */
export function buildRosterFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RosterError("The member Sheet is empty.");
  }

  const indexes = findHeaderIndexes(rows[0]);
  const members = new Map();
  const duplicates = [];

  for (const row of rows.slice(1)) {
    const email = normalizeEmail(row[indexes.email]);
    if (!email) continue;

    const name = String(row[indexes.name] ?? "").trim();
    const points = parsePoints(row[indexes.points]);

    if (members.has(email)) duplicates.push(email);

    members.set(email, {
      email,
      // A blank Name cell should not render "Welcome, undefined".
      name: name || email.slice(0, email.indexOf("@")),
      points,
    });
  }

  return { members, duplicates };
}

export function buildRoster(csvText) {
  return buildRosterFromRows(parseCsv(csvText));
}

export function findMember(roster, email) {
  return roster.members.get(normalizeEmail(email)) ?? null;
}
