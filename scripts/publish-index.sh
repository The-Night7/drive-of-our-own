#!/usr/bin/env bash
# Publishes the built index (public/index.json + public/details/) as the asset of the
# `index-data` release, then asks Vercel to redeploy. Used by both workflows.
# Env: GH_TOKEN (required), VERCEL_DEPLOY_HOOK (optional).
set -euo pipefail

# The asset name carries the index format, so a run with older code can never overwrite
# the index of newer code (see INDEX_FORMAT in scripts/lib/index-format.mjs).
BUNDLE=$(node scripts/bundle-name.mjs)
tar -czf "$BUNDLE" -C public index.json details
ls -la "$BUNDLE"

gh release view index-data >/dev/null 2>&1 || gh release create index-data \
  --title "Search index (rebuilt automatically)" \
  --notes "Built by the GitHub Actions workflows and downloaded by the Vercel build. Not meant to be used by hand."
gh release upload index-data "$BUNDLE" --clobber

if [ -z "${VERCEL_DEPLOY_HOOK:-}" ]; then
  echo "::warning::No VERCEL_DEPLOY_HOOK secret, so Vercel won't pick up the new index until its next deploy."
else
  curl -fsS -X POST "$VERCEL_DEPLOY_HOOK" && echo
fi
