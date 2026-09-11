# Handing the portal over to RSVP

V1 was built on personal accounts, as the E-Board asked. Four things need to
move: the Sheet, the Google Cloud project, the Cloudflare account, and this
repository. None of them require code changes — the portal reads all of its
configuration from environment variables and secrets.

Read the "Internal" warning under section 2 before deciding who owns the
Google Cloud project. It is the one choice here that is awkward to reverse.

## 1. The Google Sheet

Easiest of the four. Transfer ownership to an RSVP-controlled Google account
(**Share → the new owner → Transfer ownership**), then re-publish it to the web
from that account and update `SHEET_CSV_URL` on the Worker.

Publishing produces a *new* URL when the owner changes, so the Worker will
return `roster_unavailable` until the value is updated. Do these two steps
together.

The roster URL is stored as a Cloudflare **secret**, not a plain variable,
because anyone holding that link can read the whole roster. Secrets do **not**
carry across to a different Cloudflare account, so after redeploying there,
set it again:

```bash
cd worker && npx wrangler secret put SHEET_CSV_URL
```

`npx wrangler secret list` shows the name without the value. It deliberately
appears nowhere in this repository or its git history.

## 2. The Google OAuth client

The client ID lives in a Google Cloud project. Two options:

- **Move the project.** Add the RSVP account as Owner on the Cloud project
  (IAM → Grant access), then remove the personal account. The client ID stays
  the same, so nothing else needs to change. This is the less disruptive path.
- **Create a fresh client** in an RSVP-owned project. Then update
  `GOOGLE_CLIENT_ID` in both `web/config.js` and the Worker, and re-add the
  authorized JavaScript origins. Every signed-in member is signed out when the
  client ID changes.

### The app is set to "Internal" — do not lose this by accident

The OAuth consent screen is currently **Internal**, which is the best setting
for this portal: any Rutgers Google account can sign in, there is no list of
test users to maintain, there is no user cap, and Google itself blocks
non-Rutgers accounts before a request ever reaches our code.

**Internal is only available because the Cloud project lives inside Rutgers'
Google Workspace.** If the project is moved to an ordinary Gmail account — an
`rsvp.eboard@gmail.com`, for instance — Internal stops being an option. The
app falls back to **External**, which starts in "Testing" mode with a hard cap
of **100 users for the lifetime of the app**, and only accounts added to a
test-user list can sign in at all.

So when choosing who owns the Cloud project, prefer a **Rutgers** account held
by an E-Board officer over a club Gmail. If a club Gmail is unavoidable, plan
for the External path: complete the Branding page, then **Publish app**, which
removes the cap. No Google verification review is needed, because this app
only requests `openid`, `email` and `profile`.

## The URLs are expected to change — that is fine

The current addresses contain `pc937`, which is the *Cloudflare account's*
subdomain, not part of the project. They look like this today:

```
https://rsvp-points-portal.pc937.workers.dev    the portal
https://rsvp-points-worker.pc937.workers.dev    the API
```

Redeploying under an RSVP-owned account changes both. Only two files in this
repo carry those URLs, and a script rewrites both:

```bash
./scripts/set-urls.sh <new-subdomain>
```

It prints the deploy commands and the exact origin string to add in the
Google Cloud console. That console step is the one it cannot do for you, and
skipping it makes sign-in fail **silently** — the button appears to do
nothing. The script ends with two curl commands that prove whether it worked.

If RSVP would rather the address never change again, register a domain and
attach it to the Worker as a custom domain. The URL then survives any future
account move, because the domain is the stable thing rather than the host.

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

It currently lives at **github.com/pulkitc804/rsvp-points-portal** and is
**public**, so anyone can read it without being added. Transfer it to an
RSVP-owned account or organisation (Settings → General → Transfer ownership),
or fork it there.

Nothing in the repo is secret, and that was verified across the full commit
history rather than just the current files: the Google client ID and the
Worker URLs are public by design, the roster URL is a Cloudflare secret that
was never committed, and `.gitignore` excludes `.dev.vars` and `.wrangler/`.
There are no API keys or client secrets anywhere in the project — the portal
never needs one.

## Verifying after the move

Work through these in order; each one catches a different missed step.

1. `curl https://<new-worker-url>/api/health` returns `ok: true` and the
   expected thresholds. A `server_misconfigured` here means a variable did not
   carry over — `npx wrangler tail` names it.
2. Sign in on the deployed URL with a Rutgers account that **is** in the
   Sheet. Correct name, points, and standing.
3. Sign in with a Rutgers account that is **not** in the Sheet. Expect
   "You're not on the list yet".
4. Sign in with a personal Gmail. While the app is **Internal**, Google
   blocks it with its own error before the portal is reached — that is the
   correct result. If the app is ever switched to External, the same attempt
   reaches the portal instead and shows "Use your Rutgers account". Both are
   correct; they just come from different places.
5. Edit a member's points in the Sheet, wait 30 seconds, reload. The new
   number appears.
6. Open devtools, Network tab, and confirm the request to `/api/me` carries
   only an `Authorization` header — no email anywhere in the request.

If sign-in silently does nothing, the cause is almost always the portal's new
origin missing from either the Worker's `ALLOWED_ORIGINS` or Google's
authorized JavaScript origins. Those two and `WORKER_URL` must all agree;
`./scripts/set-urls.sh` handles the first and third and tells you the exact
string for the second.

## Who to hand it to

Whoever maintains this next needs access to: the Cloudflare account, the
Google Cloud project, the Sheet, and the repository. Handing over fewer than
all four leaves the portal unmaintainable — the most common failure is
inheriting the repo without the Cloud project, which means no one can add the
next year's authorized origin.
