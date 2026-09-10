# RSVP Points Portal — V1

A member signs in with their Rutgers Google account and sees their own points
and membership standing. The E-Board maintains points by hand in a Google
Sheet. That is the whole of V1: no attendance automation, no activity history,
no rankings, no upcoming events.

```
Browser  ──  Google ID token  ──▶  Cloudflare Worker  ──  reads CSV  ──▶  Google Sheet
   ▲                                      │
   └────────  name, points, standing ─────┘
```

## Repository layout

```
worker/          Cloudflare Worker — the only thing that reads the Sheet
  src/
    index.js         routing, CORS, error responses
    google-auth.js   Google ID token verification (the security core)
    roster.js        Sheet CSV -> members, looked up by header name
    standing.js      points -> standing, from configured thresholds
    config.js        env vars, validated at request time
    csv.js           RFC 4180 CSV parser
  test/          42 tests, including the attacks the brief asks us to prevent
web/             Static frontend — deploy to Cloudflare Pages
  index.html         four states: sign in, loading, dashboard, error
  app.js             Google Sign-In, fetches /api/me, renders
  styles.css         mobile first, light and dark
  config.js          public client ID and Worker URL
docs/
  sample-roster.csv  test data covering every standing and both boundaries
HANDOFF.md       transferring everything to RSVP-controlled accounts
```

## How a member's identity is established

This is the part that satisfies *"make sure a member cannot access another
member's data by changing an email or other value in the browser."*

The browser never tells the Worker who the member is. It sends the Google ID
token, and the Worker:

1. **Verifies the signature** against Google's published keys (JWKS), using
   RS256. A token that has been edited in devtools no longer matches its
   signature.
2. **Checks `aud`** equals our own client ID, so a token issued for some other
   Google app cannot be replayed here.
3. **Checks `iss` and `exp`**, and requires `email_verified`.
4. **Reads the email out of the verified payload** — never from a query
   parameter, header, or request body.

There is deliberately no endpoint that accepts an email or member id. `/api/me`
returns the token holder's row and nothing else, so there is no value in the
request a member could change to see someone else's data. `GET /api/me?email=…`
is accepted and the parameter is ignored; there is a test for exactly that.

Access is then checked in two separate stages, because they fail for different
reasons and deserve different messages:

| Stage | Fails when | Member sees |
|---|---|---|
| Domain allowlist | Personal Gmail, or any non-Rutgers domain | 403 "Use your Rutgers account" |
| Roster lookup | Valid Rutgers user who is not an RSVP member | 404 "You're not on the list yet" |

The domain check runs **before** the Sheet is read. A Gmail address that
somehow ends up in the Sheet still cannot sign in — membership in the Sheet is
not by itself sufficient authorization.

## Setup

### 1. The member Sheet

Create a Sheet with a header row. Column **order does not matter** and extra
columns are ignored, because columns are found by name:

| Email | Name | Points | Standing |
|---|---|---|---|
| abc123@scarletmail.rutgers.edu | John Smith | 14 | Good Standing |
| xyz456@scarletmail.rutgers.edu | Jane Doe | 7 | Okay Standing |

`docs/sample-roster.csv` is ready-made test data. Import it to get started.

The **Standing** column is optional and for the E-Board's own reference. The
portal always recalculates standing from Points, so the two can never disagree
on screen. Accepted header spellings include `Email`, `Name`, and `Points` or
`Total Points`.

Publish it: **File → Share → Publish to web → Comma-separated values (.csv)**.
Copy that URL. (See the note on Sheet privacy below before real member data
goes in.)

### 2. Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. Create a project, e.g. `rsvp-points-portal`.
2. **APIs & Services → OAuth consent screen**: External, add your test
   accounts while in testing mode.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins**, add every origin the frontend is
   served from — `http://localhost:8790` for local work, and the Pages URL
   once it exists. Google matches these exactly, so `http` vs `https` and a
   trailing slash both matter.
5. Copy the client ID. It is public; it belongs in `web/config.js` and in the
   Worker's `GOOGLE_CLIENT_ID`. The client *secret* is not used by this
   project at all — nothing here needs it.

### 3. The Worker

```bash
cd worker
npm install
npx wrangler login
```

Set the two values that have no sensible default, in `wrangler.toml`:

```toml
GOOGLE_CLIENT_ID = "your-id.apps.googleusercontent.com"
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv"
```

Then deploy:

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL. Check it:

```bash
curl https://rsvp-points-worker.YOUR-SUBDOMAIN.workers.dev/api/health
```

That returns `{"ok": true, "thresholds": {...}}` and no member data. If it
returns `server_misconfigured`, run `npx wrangler tail` and the log will name
the variable that is missing.

### 4. The frontend

Fill in `web/config.js` with the client ID and the Worker URL, add the Pages
origin to the Worker's `ALLOWED_ORIGINS`, redeploy the Worker, then:

```bash
npx wrangler pages deploy web --project-name rsvp-points-portal
```

Add the resulting `*.pages.dev` origin to **both** the Worker's
`ALLOWED_ORIGINS` and Google's authorized JavaScript origins. Missing either
one produces a sign-in that appears to do nothing.

### Local development

```bash
cd worker && npx wrangler dev      # Worker on http://localhost:8787
```

Serve `web/` on the origin you authorized with Google (this repo's
`.claude/launch.json` uses port 8790), point `WORKER_URL` at
`http://localhost:8787`, and add both to `ALLOWED_ORIGINS`.

## Configuration

Every value the E-Board is likely to change is an environment variable. Edit
`wrangler.toml` and redeploy, or change it live in the Cloudflare dashboard
under **Workers & Pages → rsvp-points-worker → Settings → Variables**.

| Variable | Default | Controls |
|---|---|---|
| `THRESHOLD_GOOD` | `12` | Points for Good Standing |
| `THRESHOLD_OKAY` | `6` | Floor for Okay Standing; below this is At Risk |
| `ALLOWED_DOMAINS` | `scarletmail.rutgers.edu,rutgers.edu` | Who may sign in at all |
| `ALLOWED_ORIGINS` | localhost | Which sites may call the Worker |
| `GOOGLE_CLIENT_ID` | — | Which OAuth app tokens must be issued for |
| `SHEET_CSV_URL` | — | Which Sheet is the roster |
| `SHEET_CACHE_SECONDS` | `30` | How long a cached copy of the Sheet may be reused |

**Changing the thresholds** is two edits and a redeploy; no code changes. The
Worker refuses to start with `THRESHOLD_GOOD` less than or equal to
`THRESHOLD_OKAY`, so a typo cannot silently produce a standing no one can
reach.

Note that points update on screen within `SHEET_CACHE_SECONDS` of an E-Board
edit. If someone reports that a change "didn't save", wait half a minute and
reload before investigating further.

## Errors a member can see

Every failure states what happened and what to do next.

| Code | Status | When |
|---|---|---|
| `invalid_token` | 401 | Signature, audience, or issuer check failed |
| `expired_token` | 401 | Sign-in older than one hour |
| `domain_not_allowed` | 403 | Not a Rutgers address |
| `not_a_member` | 404 | Rutgers address, not in the Sheet |
| `roster_unavailable` | 502 | The Sheet could not be fetched |
| `roster_invalid` | 500 | The Sheet is missing a column, or a Points cell is not a number |
| `verification_unavailable` | 503 | Google's key endpoint was unreachable |
| `server_misconfigured` | 500 | A required variable is not set |

Member-facing messages never name a variable, a column, or which specific
check failed; the details go to `wrangler tail` instead. Telling someone
probing the endpoint exactly which check rejected them helps them and does not
help a real member.

## Tests

```bash
cd worker && npm test
```

42 tests, no cloud accounts needed. The security tests generate a real RSA
keypair and sign real tokens, so the signature path is genuinely exercised
rather than stubbed out. Each attack in the brief has a test:

- a token signed with a different key
- a real token whose email was edited (signature no longer matches)
- an unsigned `alg: none` token
- a token issued for a different Google app
- `?email=` pointing at another member
- a Gmail address that appears in the Sheet
- a response asserted to contain no other member's name or email

## Two things to decide with the E-Board

**A published-CSV Sheet is readable by anyone with the link.** That is the
whole roster — every member's name, email, and points. The brief assumes this
approach and it is fine for testing, but it is worth a conversation before real
member data goes in. The alternative is a service account reading the private
Sheet through the Sheets API. All Sheet reading is isolated in
`worker/src/index.js` `readRoster()`, so switching is one function, not a
rewrite.

**The thresholds are placeholders.** 12 and 6 come from the brief's own
"example only" table. Confirm the real numbers before a member sees a screen
telling them they are At Risk.

## Adding V2 features later

The V1 shape was chosen so the listed future work does not require a rebuild:

- **Extra Sheet columns** are already ignored rather than fatal, so a Notes or
  Dues column can be added today without touching the Worker.
- **Activity history** becomes a second sheet tab read by the same
  `readRoster()` pattern and a second field in the `/api/me` response; the
  dashboard grows a section.
- **QR or Google Form check-ins** write to the Sheet, which is already the
  source of truth. Points become a formula rather than a typed number and the
  portal does not change at all.
- **Rankings and leaderboards** are deliberately absent, and the API shape
  supports that: the Worker only ever returns one row, so no client can
  assemble a ranking from it.
