# Requirements traceability

Every requirement from *RSVP Points Portal V1 Project Instructions*, mapped to
the code that implements it and the test that proves it.

## Core Requirements

| Requirement | Implementation | Proof |
|---|---|---|
| Deploy and understand the existing Cloudflare Worker | `worker/` — verify token, extract email, read Sheet CSV, return that member's row, as described in the brief | `npm test`; README documents each stage |
| Set up Google Sign-In on the frontend and connect it to the Worker | `web/app.js` (Google Identity Services) → `GET /api/me` | Verified in browser; four states screenshotted |
| Restrict access appropriately to Rutgers/RSVP members | Two-stage check: `config.js` `domainAllowed()` then roster lookup | `security.test.mjs` — Gmail refused, Gmail-in-Sheet refused |
| Explicitly enforce the Rutgers email domain rather than only checking the Sheet | `ALLOWED_DOMAINS`, checked *before* the Sheet is read; plus opt-in `REQUIRE_HOSTED_DOMAIN` for Workspace-only accounts, with the trade-off written up in the README | "a Gmail address present in the Sheet still cannot sign in"; four strict-mode tests |
| Use Google Sheets as the source of truth | `roster.js`, read fresh per request (30s cache) | "thresholds come from configuration" and roster tests |
| Clean member dashboard: name, total points, standing | `web/index.html` `#state-dashboard` — greeting ("Welcome, John") plus full name, email, points and standing | Driven through app.js's real render path in a browser, not a DOM mock |
| Three standing levels | `standing.js` — `good`, `okay`, `at_risk` | "standing thresholds are inclusive at each boundary" |
| Thresholds easy for the E-Board to change later | `THRESHOLD_GOOD` / `THRESHOLD_OKAY` env vars; validated | "standing follows changed thresholds without code edits" |
| Handle errors cleanly, including a valid Google user not in the member list | Eight error codes, each with member-facing copy | "a valid Rutgers user who is not a member gets a clear, actionable error" |
| Mobile-friendly and usable on desktop | `styles.css`, mobile first, one breakpoint at 560px | Screenshotted at 375×812 and 1240×800, light and dark |
| Deploy the frontend to a publicly accessible URL | Cloudflare Pages; README step 4 | Pending your Cloudflare account |
| A member cannot access another member's data by changing a value in the browser | Email read only from the verified token; no endpoint accepts an identifier | Six ATTACK tests, incl. `?email=` ignored and edited-token rejection; frontend request verified to carry only an `Authorization` header |

## Explicitly out of scope for V1 — and absent

Attendance automation, activity history, upcoming events, leaderboard or
rankings, admin dashboard, notifications, custom database or password system.
None are implemented. `/api/me` returns exactly one row, which is what makes a
leaderboard impossible to assemble client-side rather than merely omitted.

## Definition of Done

| Clause | Status |
|---|---|
| Member opens the deployed website | Ready to deploy; needs a Cloudflare account |
| Signs in with the appropriate Rutgers Google account | Built; needs a Google OAuth client ID |
| Securely matched to their row in the Sheet | Done — signature-verified email, tested |
| Sees correct name, points, and standing | Done |
| Clean mobile-friendly dashboard | Done |
| A member not in the Sheet receives a clear error | Done |
| Members cannot view another member's information | Done — tested from six attack angles |

The three "needs an account" rows are the only work left, and all three are
account setup rather than code: a Google OAuth client ID, a published Sheet
URL, and a Cloudflare login. README steps 2–4 cover each.
