#!/usr/bin/env bash
# Publishes the built index (public/index.json + public/details/) as the asset of the
# `index-data` release, then asks Vercel to redeploy. Used by both workflows.
# Env: GH_TOKEN (required), VERCEL_DEPLOY_HOOK (optional).
set -euo pipefail

tar -czf index-bundle.tgz -C public index.json details
ls -la index-bundle.tgz

gh release view index-data >/dev/null 2>&1 || gh release create index-data \
  --title "Search index (rebuilt automatically)" \
  --notes "Built by the GitHub Actions workflows and downloaded by the Vercel build. Not meant to be used by hand."
gh release upload index-data index-bundle.tgz --clobber

if [ -z "${VERCEL_DEPLOY_HOOK:-}" ]; then
  echo "::warning::No VERCEL_DEPLOY_HOOK secret, so Vercel won't pick up the new index until its next deploy."
else
  curl -fsS -X POST "$VERCEL_DEPLOY_HOOK" && echo
fi
