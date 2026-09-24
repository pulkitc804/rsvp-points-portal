#!/usr/bin/env bash
#
# Re-point the portal at a new Cloudflare account's workers.dev subdomain.
#
# Run this when migrating to RSVP-controlled accounts. It edits the only two
# files that carry the URLs, then tells you the one thing it cannot do for
# you: adding the new origin in the Google Cloud console.
#
#   ./scripts/set-urls.sh rsvp
#
# turns the URLs into
#   https://rsvp-points-portal.rsvp.workers.dev   (the portal)
#   https://rsvp-points-worker.rsvp.workers.dev   (the API)
#
set -euo pipefail

SUB="${1:-}"
if [ -z "$SUB" ]; then
  echo "usage: $0 <workers.dev-subdomain>" >&2
  echo "  find it with: npx wrangler whoami, or in the Cloudflare dashboard" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORTAL="https://rsvp-points-portal.${SUB}.workers.dev"
API="https://rsvp-points-worker.${SUB}.workers.dev"

# 1. The frontend needs to know where the API is.
perl -pi -e "s{WORKER_URL: \"[^\"]*\"}{WORKER_URL: \"${API}\"}" "$ROOT/web/config.js"

# 2. The API must accept calls from the portal's origin, and nowhere else.
#    localhost is kept so local development keeps working.
perl -pi -e "s{^ALLOWED_ORIGINS = \"[^\"]*\"}{ALLOWED_ORIGINS = \"${PORTAL},http://localhost:8790\"}m" \
  "$ROOT/worker/wrangler.toml"

echo "Updated:"
grep -n "WORKER_URL" "$ROOT/web/config.js"
grep -n "^ALLOWED_ORIGINS" "$ROOT/worker/wrangler.toml"
cat <<MSG

Next, in order:

  1. cd worker && npx wrangler deploy
  2. npx wrangler deploy -c site.wrangler.jsonc     (from the repo root)
  3. cd worker && npx wrangler secret put SHEET_ID  (secrets do not migrate)
     npx wrangler secret put GOOGLE_SA_EMAIL
     npx wrangler secret put GOOGLE_SA_PRIVATE_KEY

  4. In the Google Cloud console, under your OAuth client's
     "Authorized JavaScript origins" — NOT "Authorized redirect URIs" — add:

         ${PORTAL}

Sign-in fails silently if step 4 is skipped. Verify with:

  curl -s ${API}/api/health
  curl -s -D- -o /dev/null -H "Origin: ${PORTAL}" ${API}/api/health | grep -i access-control-allow-origin

The first must return ok:true. The second must echo the portal origin back;
if it prints nothing, step 1 did not take effect.
MSG
