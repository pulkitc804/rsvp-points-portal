# Handing the portal over to RSVP

V1 runs entirely on Pulkit's personal accounts, as the E-Board asked. Nothing
has been migrated yet. Four things have to move: the Google Sheet, the Google
Cloud project, the Cloudflare account, and this repository. None of it needs a
code change — every value the portal depends on is an environment variable, a
Cloudflare secret, or a URL in two files.

**The goal is a permanent portal: every account owned by the club, nothing
owned by any individual student, and a handover routine that survives officers
graduating.** That means more than copying things across once. Three sections
matter as much as the migration steps themselves:

- "Everything that still points at Pulkit" — the hidden dependencies that
  survive a half-done migration and only fail months later.
- "Costs and limits" — why this stays free, and what a custom domain buys.
- "Credential custody and the yearly turnover routine" — the part that makes it
  permanent rather than merely moved.

Read section 0 before anyone creates an account. Choosing the wrong destination
Google account is the one decision here that is expensive to reverse.

## What exists today

| Asset | Where it lives now | Notes |
|---|---|---|
| Cloudflare account | `pc937@scarletmail.rutgers.edu` | `workers.dev` subdomain `pc937` |
| API Worker | `rsvp-points-worker` → https://rsvp-points-worker.pc937.workers.dev | config: `worker/wrangler.toml` |
| Frontend Worker | `rsvp-points-portal` → https://rsvp-points-portal.pc937.workers.dev | static assets from `web/`, config: `site.wrangler.jsonc` |
| Google Cloud project | `rsvp-points-portal`, on Pulkit's Google account | holds the OAuth client and the service account |
| OAuth client ID | `32532424958-umer4n322a63nphfbnl0gkcqtrq92ms8.apps.googleusercontent.com` | public by design; in `web/config.js` and `wrangler.toml` |
| Service account | `rsvp-portal-reader@rsvp-points-portal.iam.gserviceaccount.com` | read-only; shared on the Sheet as Viewer |
| Google Sheet | private, owned by Pulkit's Google account | **not** published to the web |
| Repository | https://github.com/pulkitc804/rsvp-points-portal | public |

**How the roster is read today:** the Sheet is private and the Worker reads it
through the Google Sheets API, authenticating as the service account above with
the `spreadsheets.readonly` scope. The Sheet is *not* published to the web and
there is no public CSV link. The old `SHEET_CSV_URL` secret has been deleted
from the Worker. Any instruction to "publish the Sheet to the web" is obsolete
and must not be followed: publishing would make every member's name, email and
point total readable by anyone holding the link.

## 0. Which Google account owns the destination — decide this first

**The club should own the destination Google account.** Create something like
`rsvp.eboard@gmail.com` (or a club account on a domain RSVP controls), give at
least two officers the password, and make *that* account the owner of the Cloud
project and the Sheet.

The trap, stated plainly:

- A Rutgers student account **disappears after graduation.** Anything owned by
  it — the Cloud project, the OAuth client, the Sheet — goes with it, and the
  portal breaks with no one able to fix it.
- A Google Cloud project sitting inside the Rutgers Workspace is **hard to move
  out of it.** Transferring a project to an account outside the organisation is
  not a simple ownership handoff; in practice the fix is to recreate the OAuth
  client in a club-owned project, which signs every member out and requires the
  origins to be re-added.
- Handing the Rutgers-owned project to the *next* Rutgers officer only repeats
  the problem every year, and depends on an outgoing officer being reachable.

What the club gives up by choosing a club Gmail, and how to handle it:

The OAuth consent screen can only be set to **Internal** while the Cloud project
lives inside the Rutgers Workspace. Internal is convenient — Google itself
blocks non-Rutgers accounts before a request reaches our code, with no user cap
and no test-user list. On an ordinary Gmail account the app must be **External**,
which starts in "Testing" mode with a hard cap of 100 users for the lifetime of
the app and a test-user list.

That is fixable and not a reason to stay on a Rutgers account: fill in the
Branding page and click **Publish app**, which removes the cap and the test-user
list. No Google verification review is needed, because this app requests only
`openid`, `email` and `profile`. Rutgers-only access is still enforced by the
Worker's `ALLOWED_DOMAINS`, and members must still be in the Sheet.

> Unverified from the repository: the consent screen on the live project is
> believed to be **Internal**. Confirm this in the Google Cloud console before
> migrating, because it determines whether step 5 below needs the Publish-app
> step.

### Does Rutgers-only sign-in still work from a club-owned Cloud project?

Yes. This was checked against the code rather than assumed, because the whole
migration depends on it.

Members sign in with a `scarletmail.rutgers.edu` account, and that keeps working
from any Cloud project, Rutgers-owned or not. Google will issue an ID token for
a Rutgers Workspace account to an External app just as it does to an Internal
one. What enforces "Rutgers only" is our own code, in two independent places:

1. `worker/src/google-auth.js` verifies the token's signature against Google's
   public keys (`https://www.googleapis.com/oauth2/v3/certs`), checks the issuer
   is `accounts.google.com`, checks `aud` equals our `GOOGLE_CLIENT_ID`, checks
   expiry, and requires `email_verified`. None of those checks reference the
   project owner.
2. `worker/src/config.js` `domainAllowed()` then rejects any verified email
   whose domain is not in `ALLOWED_DOMAINS`, **before** the Sheet is read.
   `worker/test/security.test.mjs` proves a Gmail address is refused even when
   it has been typed into the Sheet, using locally signed tokens — which is
   exactly the case of a token from a project we do not control.

The optional `REQUIRE_HOSTED_DOMAIN` setting also still works: the `hd` claim is
present in the ID token for any Google Workspace account, independent of who
owns the OAuth client. Note that `web/app.js` passes only `client_id` to Google
Identity Services and no `hosted_domain` hint, so the Worker, not Google, has
always been the thing enforcing the domain rule.

**What does change.** Under Internal, Google refuses a personal Gmail before the
request reaches us. Under External, that same attempt reaches the portal and
gets our "Please sign in with your Rutgers account" error instead. Same outcome,
different place, and the portal already has copy for it.

**The one thing to test rather than trust:** Rutgers' Workspace admins can
restrict which third-party apps their users may use (Admin console → Security →
API controls). This app requests only `openid`, `email` and `profile`, which is
the category Google's own defaults exempt, and today's Internal setup sidesteps
the question entirely. After migrating, sign in once with a real scarletmail
account before announcing the new URL. If Rutgers blocks it, the club's options
are to ask Rutgers OIT to allow the app by its client ID, or to keep the Cloud
project on a Rutgers account and accept the graduation risk. Verification step 4
covers this.

## Everything that must be recreated

Cloudflare **secrets do not transfer** between accounts, and they cannot be read
back — `npx wrangler secret list` shows names only. All three below must be set
again by hand on the new account, from the service account's JSON key file.

| Secret (set with `npx wrangler secret put`) | Value | Source |
|---|---|---|
| `SHEET_ID` | the id in the Sheet URL between `/d/` and `/edit` | the Sheet |
| `GOOGLE_SA_EMAIL` | `...iam.gserviceaccount.com` | `client_email` in the JSON key |
| `GOOGLE_SA_PRIVATE_KEY` | the whole `private_key`, BEGIN and END lines included | `private_key` in the JSON key |

Setting only some of the three is a **startup error**, not a silent fallback —
by design, so a half-finished migration cannot quietly downgrade privacy.

Plain variables live in `worker/wrangler.toml` and are re-applied by every
deploy, so they carry over with the repo. Check each after the move:

| Variable | Current value | Must change when migrating? |
|---|---|---|
| `THRESHOLD_GOOD` | `12` | no (E-Board may still want real numbers) |
| `THRESHOLD_OKAY` | `6` | no |
| `ALLOWED_DOMAINS` | `scarletmail.rutgers.edu,rutgers.edu` | no |
| `REQUIRE_HOSTED_DOMAIN` | `false` | no |
| `ALLOWED_ORIGINS` | the `pc937` portal URL + localhost | **yes** — new portal origin |
| `GOOGLE_CLIENT_ID` | the id above | only if a new OAuth client is created |
| `SHEET_CACHE_SECONDS` | `30` | no |
| `SHEET_RANGE` | unset (defaults to `A:D`) | only if the roster moves tab or range |

Not a Worker variable, but must match: `WORKER_URL` and `GOOGLE_CLIENT_ID` in
`web/config.js`, and the **Authorized JavaScript origins** on the OAuth client
in the Google Cloud console.

`SHEET_CSV_URL` is **deleted and must not be recreated.** It is still accepted
by the code as a legacy fallback, which is exactly why setting it would be a
silent privacy regression.

## Everything that still points at Pulkit

A half-done migration looks fine until the day his accounts close. This is the
full list, from grepping the repository rather than from memory. Every item has
to end up owned by the club.

**Hardcoded in the repo** (all say `pc937`, his Cloudflare subdomain):

| File | What | Fixed by |
|---|---|---|
| `web/config.js` | `WORKER_URL` | `./scripts/set-urls.sh <sub>` |
| `worker/wrangler.toml` | `ALLOWED_ORIGINS` | `./scripts/set-urls.sh <sub>` |
| `web/config.js` and `worker/wrangler.toml` | `GOOGLE_CLIENT_ID` | **by hand**, if a new client is created |
| `README.md` lines 19–22 | the live URLs and "the Cloudflare account for pc937@scarletmail.rutgers.edu" | **by hand** |
| `web/_headers` | CSP `connect-src https://*.workers.dev` | nothing, unless a custom domain is used — see below |

The wildcard in `web/_headers` means a new `workers.dev` subdomain needs no CSP
edit. A **custom domain does**: add that origin to `connect-src` or sign-in
fails with a CSP error and no obvious cause. `set-urls.sh` does not touch that
file. The `pages.dev` origins in `worker/test/` are fixtures, not real URLs.

**Owned by his Google account, and must be re-created rather than moved:**

- The **OAuth consent screen and client** live in his Cloud project. If the club
  keeps using the existing client ID, sign-in dies the day that project or
  account does — and nobody will be able to add next year's origin before then.
  A new client ID signs every member out once (they just sign in again) and must
  be pasted into both `web/config.js` and `worker/wrangler.toml`.
- The **service account** `rsvp-portal-reader@rsvp-points-portal...` belongs to
  that same project. A new one is needed in the club project, and the Sheet must
  be re-shared with its address as Viewer.
- The **service account private key** exists in exactly one place we can read:
  the JSON file downloaded at creation. Cloudflare will not show the secret
  back. If the file is lost, no one is locked out permanently — create a new key
  on the service account and re-set `GOOGLE_SA_PRIVATE_KEY` — but that requires
  access to the Cloud project, which is the thing being migrated.
- The **Sheet** is owned by his account. Transfer ownership; do not copy it,
  because `SHEET_ID` points at one specific file.

**Owned by his Cloudflare account:** both Workers, the `pc937` subdomain (which
is per-account and cannot be transferred), and all three secrets.

**Not a dependency, despite appearances:** the Google client ID and the Worker
URLs in the repo are public by design, and nothing secret was ever committed.

## The migration, in order

Do these in sequence. Each step assumes the one before it succeeded.

1. **Create the club-owned Google account** and record who holds the
   credentials (two officers minimum). See section 0.
2. **Transfer the Sheet.** Open the Sheet → Share → the club account → Transfer
   ownership. Do **not** publish it to the web. Confirm that
   `rsvp-portal-reader@...` (or its replacement from step 4) is still listed as
   a **Viewer** after the transfer.
3. **Create a club-owned Google Cloud project**, e.g. `rsvp-points-portal`, on
   the club account, and enable the **Google Sheets API**
   (APIs & Services → Library → Google Sheets API → Enable).
4. **Create a new service account** in that project (IAM & Admin → Service
   Accounts), named e.g. `rsvp-portal-reader`. No IAM roles are needed; its
   access comes only from the Sheet being shared with it. Then **Keys → Add key
   → Create new key → JSON**, and keep that file somewhere safe — Google will
   not show the private key again. Share the Sheet with the new
   `client_email` as **Viewer**.
5. **Create the OAuth client** in the new project: APIs & Services → OAuth
   consent screen (External for a club Gmail; then **Publish app** to remove the
   100-user cap), then Credentials → Create credentials → OAuth client ID → Web
   application. Leave the authorized origins empty for now; the portal URL does
   not exist until step 8. The client *secret* is never used by this project.
6. **Create the club-owned Cloudflare account**, sign in locally, and register a
   `workers.dev` subdomain (dash.cloudflare.com → Workers & Pages → Overview).
   A brand-new account has none, and the first deploy fails with
   "You need to register a workers.dev subdomain before publishing".

   ```bash
   npx wrangler logout && npx wrangler login    # as the club account
   npx wrangler whoami                          # confirms the account and subdomain
   ```

7. **Re-point the URLs in the repo** to the new subdomain:

   ```bash
   ./scripts/set-urls.sh <new-subdomain>
   ```

   This rewrites `WORKER_URL` in `web/config.js` and `ALLOWED_ORIGINS` in
   `worker/wrangler.toml`. Also paste the new client ID from step 5 into
   `GOOGLE_CLIENT_ID` in **both** `web/config.js` and `worker/wrangler.toml`.
8. **Deploy both Workers.** They are two projects with two config files, and
   the working directory matters:

   ```bash
   cd worker && npx wrangler deploy              # the API Worker
   ```

   ```bash
   npx wrangler deploy -c site.wrangler.jsonc    # the frontend, from the repo root
   ```

   Wrangler walks *up* from the working directory for config and prefers
   `.jsonc` over `.toml`, so running the frontend deploy from inside `worker/`
   deploys the wrong project while reporting success. Read the "Deployed ..."
   line each time.

9. **Set the three secrets** on the new API Worker, then redeploy:

   ```bash
   cd worker
   npx wrangler secret put SHEET_ID
   npx wrangler secret put GOOGLE_SA_EMAIL
   npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
   npx wrangler deploy
   ```

   Until all three are set, `/api/health` returns `server_misconfigured`. Do
   **not** set `SHEET_CSV_URL`.

10. **Add the new portal origin** to the OAuth client's **Authorized JavaScript
    origins** (not "Authorized redirect URIs") in the Google Cloud console:
    `https://rsvp-points-portal.<new-subdomain>.workers.dev`. Google matches
    these exactly, so `http` vs `https` and a trailing slash both matter. This
    is the step no script can do, and skipping it makes sign-in fail
    **silently** — the button appears to do nothing.

11. **Transfer the repository** to a club-owned GitHub account or organisation
    (Settings → General → Transfer ownership), and commit the URL and client-ID
    changes from step 7. Nothing in the repo is secret: the client ID and Worker
    URLs are public by design, no roster URL or key was ever committed, and
    `.gitignore` excludes `.dev.vars` and `.wrangler/`.

12. **Tear down the old deployment** only after step 13 passes: delete both
    Workers on Pulkit's Cloudflare account, remove the old service account from
    the Sheet's sharing list, and delete the old Cloud project. Tell members the
    new URL — the old one stops working.

## 13. Verification — prove the new deployment reads the Sheet privately

Run all six. Each catches a different missed step. The first three are the ones
that prove the private-Sheet path specifically.

1. **The Worker is healthy and has its variables.**

   ```bash
   curl -s https://rsvp-points-worker.<new-subdomain>.workers.dev/api/health
   ```

   Must return `{"ok": true, "thresholds": {"good": 12, "okay": 6}}`.
   `server_misconfigured` means a variable or secret did not carry over;
   `npx wrangler tail` names it.

2. **The Worker is reading the Sheet through the API, not a public link.**

   ```bash
   cd worker && npx wrangler secret list
   ```

   Must list exactly `SHEET_ID`, `GOOGLE_SA_EMAIL` and `GOOGLE_SA_PRIVATE_KEY`,
   and must **not** list `SHEET_CSV_URL`. If it does, delete it
   (`npx wrangler secret delete SHEET_CSV_URL`) and redeploy.

3. **The Sheet is genuinely private.** Open the Sheet → Share → **Publish to
   web**: it must read "Not published" (if it offers "Stop publishing", the
   Sheet is still public — stop it). Then open the Sheet's normal URL in a
   private browsing window while signed out: it must show a "Request access"
   page, not the roster. Finally, remove the service account from the Sheet's
   sharing list for a moment, reload the portal, and confirm members see the
   "could not read the member list" error — that proves the service account is
   the only thing granting access. Re-share it as Viewer immediately after.

4. **A real member sees real data, on a real scarletmail account.** Sign in on
   the new portal URL with a `scarletmail.rutgers.edu` account that **is** in
   the Sheet. Correct name, points and standing. This is also the test that a
   Rutgers account can consent to an app owned by a club Gmail project; if
   Google shows a Rutgers admin block instead of the portal, see the end of
   section 0.

5. **A non-member is refused.** Sign in with a Rutgers account that is **not**
   in the Sheet. Expect "You're not on the list yet". Then sign in with a
   personal Gmail: under External it reaches the portal and shows "Use your
   Rutgers account"; under Internal, Google blocks it first. Both are correct.

6. **Edits flow through, and no member data leaks.** Change a member's points in
   the Sheet, wait 30 seconds (`SHEET_CACHE_SECONDS`), reload — the new number
   appears. With devtools open, confirm the request to `/api/me` carries only an
   `Authorization` header and no email anywhere.

If sign-in silently does nothing, the cause is almost always the new portal
origin missing from either the Worker's `ALLOWED_ORIGINS` or Google's authorized
JavaScript origins. Those two and `WORKER_URL` must all agree.

## Costs and limits — why this stays free

Nothing here needs a credit card, and none of the free tiers can generate a
surprise bill. Cloudflare's free plan has no overage billing: past the limit
requests are rejected, not charged.

- **Cloudflare Workers, free plan:** 100,000 Worker requests per day for the
  whole account and 10 ms of CPU per request. Requests served as static assets
  by the frontend Worker do not count against that. This portal does a few
  milliseconds of work per request, and a club of a few hundred members reading
  their points is three orders of magnitude below the daily limit. Keep the
  account on Free and do not add a payment method; then no configuration
  mistake can cost money.
- **Google Sheets API:** free, with no billing account required on the Cloud
  project. Quotas are per-project per-minute (hundreds of reads), and the Worker
  caches the roster for `SHEET_CACHE_SECONDS` (30), so the ceiling is roughly
  two reads a minute per Cloudflare location no matter how many members reload.
- **Google Cloud project, OAuth, service account, Google Sheet, GitHub:** free
  at this usage. Do not enable billing on the Cloud project; nothing here needs
  it, and an enabled billing account is the only way this could ever cost
  anything.

### Custom domain, or stay on workers.dev?

`workers.dev` is free, needs no maintenance, and is perfectly respectable for a
club portal. Its one drawback is that the subdomain belongs to the Cloudflare
*account*, so the URL changes on every account move — which is exactly the
disruption this migration is going through now.

A custom domain (say `points.rsvp-rutgers.org`) costs roughly $10–15 a year at
Cloudflare Registrar, which sells at cost, and makes the address permanent: any
future account move becomes invisible to members. The trade-offs are real
though: it is a recurring payment that must not lapse, it becomes a fifth asset
to hand over each year, and it needs one code change the migration script does
not make — adding the domain to `connect-src` in `web/_headers`.

Recommendation: migrate to `workers.dev` first and confirm everything works,
then add a custom domain later only if the club already owns a domain or is
willing to own the renewal. Adding one later is a small, safe change.

## Where the repository should live

Today: `github.com/pulkitc804/rsvp-points-portal`, public, on a personal
account.

**Recommended: transfer it to a club-owned GitHub organisation** (a free org
owned by the club Google account, with at least two officers as owners).
Settings → General → Transfer ownership. GitHub keeps redirects from the old
URL, so nothing breaks at the moment of transfer. An organisation is the only
option here where ownership is a *role* that can be reassigned, rather than
something attached to one person's login.

If it stays on his personal account: the code is public so it can never be
lost — anyone can fork it — but the club cannot merge changes, cannot manage
access, and loses the issue history and the canonical URL whenever he deletes or
renames the account. Forking to a club org instead of transferring works too,
but leaves the original as the address people find first.

Either way, the repository alone is worthless without the Cloudflare account and
the Cloud project. Do not treat "we have the code" as having inherited the
portal.

## Credential custody and the yearly turnover routine

Permanence is a custody problem, not a technical one. The portal only needs five
credentials, and they should be held the same way the club holds its other
accounts.

| Credential | Who should hold it | Notes |
|---|---|---|
| Club Google account (owns Cloud project + Sheet) | President and one technical officer | The root of everything else |
| Cloudflare account (same club email) | Same two people | Use the club Google account to sign in |
| GitHub organisation | Same two people as org Owners | Add other officers as members |
| Service account JSON key file | Stored in the club's password manager or the club Drive | The only readable copy of the private key |
| Sheet edit access | All E-Board officers | Members need no access at all |

Rules that make this survive:

1. **Two people, always.** One is a single point of failure; everyone is a
   security problem. Two officers, one of whom is not graduating this year.
2. **The club Google account signs in to everything else.** Cloudflare and
   GitHub should both use that address, so rotating one password recovers
   everything.
3. **Turn on two-factor authentication** on the club Google account, with
   recovery codes stored where the club stores its other credentials — not on
   one officer's phone alone.
4. **Nothing personal, ever.** No officer's Rutgers or personal address should
   own an asset. If one does, that asset is on a countdown to their graduation.

**Every spring, before officers graduate,** the outgoing technical officer runs
this with the incoming one, in one sitting:

1. Change the club Google account password; confirm the new officer can sign in
   and that 2FA recovery codes are updated in the club's store.
2. Confirm the incoming officer can sign in to Cloudflare and see both Workers,
   and to GitHub as an org Owner.
3. Run the six checks in section 13 together. They double as the training.
4. Confirm the service account is still a Viewer on the Sheet and the JSON key
   file is still where the custody table says it is.
5. Remove graduating officers from the GitHub org and from Sheet edit access,
   and delete any personal account that still has access to anything.

Whoever maintains this next needs all four assets: the Cloudflare account, the
Google Cloud project, the Sheet, and the repository. Fewer than four leaves the
portal unmaintainable — the most common failure is inheriting the repo without
the Cloud project, which means no one can add next year's authorized origin or
re-issue the service account key.
