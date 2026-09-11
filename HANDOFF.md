# Handing the portal over to RSVP

V1 was built on personal accounts, as the E-Board suggested. Four things need
to move. None of them require code changes — the portal reads all of its
configuration from environment variables.

## 1. The Google Sheet

Easiest of the four. Transfer ownership to an RSVP-controlled Google account
(**Share → the new owner → Transfer ownership**), then re-publish it to the web
from that account and update `SHEET_CSV_URL` on the Worker.

Publishing produces a *new* URL when the owner changes, so the Worker will
return `roster_unavailable` until the variable is updated. Do these two steps
together.

## 2. The Google OAuth client

The client ID lives in a Google Cloud project. Two options:

- **Move the project.** Add the RSVP account as Owner on the Cloud project
  (IAM → Grant access), then remove the personal account. The client ID stays
  the same, so nothing else needs to change. This is the less disruptive path.
- **Create a fresh client** in an RSVP-owned project. Then update
  `GOOGLE_CLIENT_ID` in both `web/config.js` and the Worker, and re-add the
  authorized JavaScript origins. Every signed-in member is signed out when the
  client ID changes.

Whoever owns the consent screen also controls whether the app stays in
"testing" mode, which caps it at 100 test users. For a club roster that limit
is worth checking before an event, not after.

## 3. The Cloudflare account

Cloudflare has no ownership transfer for a Worker, so the cleanest route is to
redeploy from an RSVP-owned account:

```bash
npx wrangler logout && npx wrangler login   # as the RSVP account
```

```bash
cd worker && npx wrangler deploy
```

```bash
npx wrangler deploy -c site.wrangler.jsonc
```

Run the last command from the repository root, not from `worker/`. The two
deploys use different config files and different working directories, and
mixing them up deploys the wrong project while reporting success — see the
README's "Deploying" section for why.

The API Worker URL and the portal URL will both change. That means updating, in
order: `WORKER_URL` in `web/config.js`, `ALLOWED_ORIGINS` on the Worker, and
the authorized JavaScript origins in Google Cloud. Redeploy the frontend after
editing `config.js`.

Alternatively, invite the RSVP account to the existing Cloudflare account as a
member — no URLs change, but the account itself stays personal, which only
defers the problem.

## 4. This repository

Push it to an RSVP-owned GitHub organization. Nothing in the repo is secret:
the Google client ID and Worker URL are public by design, and `.gitignore`
excludes `.dev.vars` and `.wrangler/`. There are no API keys or client secrets
anywhere in the project — the portal never needs one.

## Verifying after the move

Work through these in order; each one catches a different missed step.

1. `curl https://<new-worker-url>/api/health` returns `ok: true` and the
   expected thresholds. A `server_misconfigured` here means a variable did not
   carry over — `npx wrangler tail` names it.
2. Sign in on the deployed URL with a Rutgers account that **is** in the
   Sheet. Correct name, points, and standing.
3. Sign in with a Rutgers account that is **not** in the Sheet. Expect
   "You're not on the list yet".
4. Sign in with a personal Gmail. Expect "Use your Rutgers account".
5. Edit a member's points in the Sheet, wait 30 seconds, reload. The new
   number appears.
6. Open devtools, Network tab, and confirm the request to `/api/me` carries
   only an `Authorization` header — no email anywhere in the request.

If sign-in silently does nothing, the cause is almost always step 3 of the
Cloudflare section: the new Pages origin is missing from either
`ALLOWED_ORIGINS` or Google's authorized origins.

## Who to hand it to

Whoever maintains this next needs access to: the Cloudflare account, the
Google Cloud project, the Sheet, and the repository. Handing over fewer than
all four leaves the portal unmaintainable — the most common failure is
inheriting the repo without the Cloud project, which means no one can add the
next year's authorized origin.
