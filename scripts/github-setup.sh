#!/usr/bin/env bash
# One-time GitHub setup for the open-source repository. Needs `gh auth login` as an admin. Safe to run again.
# Branch rules and the security features need a public repository (or GitHub Pro); they're skipped otherwise.
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

echo "Repository settings"
gh api -X PATCH "repos/$REPO" \
  -f default_branch=main \
  -f description="Monthly Razorpay invoices for overseas clients who pay into a MoneySaver Export Account. Runs in Docker." \
  -F has_wiki=false -F has_projects=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true -F allow_auto_merge=true >/dev/null
gh api -X PUT "repos/$REPO/topics" \
  -f "names[]=razorpay" -f "names[]=invoicing" -f "names[]=invoice-generator" -f "names[]=freelancing" \
  -f "names[]=export" -f "names[]=india" -f "names[]=docker" -f "names[]=typescript" -f "names[]=nodejs" >/dev/null
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null

echo "Labels for the release notes"
gh label create breaking-change --repo "$REPO" --color b60205 --description "Users need to change something" --force >/dev/null
gh label create dependencies --repo "$REPO" --color 0366d6 --description "Dependency updates" --force >/dev/null
gh label create skip-changelog --repo "$REPO" --color ededed --description "Leave out of the release notes" --force >/dev/null

echo "Security features"
enable() { # description, then the gh api arguments
  local what=$1; shift
  if gh api "$@" >/dev/null 2>&1; then echo "  $what: on"; else echo "  $what: skipped (needs a public repository)"; fi
}
enable "Dependabot alerts" -X PUT "repos/$REPO/vulnerability-alerts"
enable "Dependabot security updates" -X PUT "repos/$REPO/automated-security-fixes"
enable "Private vulnerability reporting" -X PUT "repos/$REPO/private-vulnerability-reporting"
enable "Secret scanning and push protection" -X PATCH "repos/$REPO" --input - <<'JSON'
{ "security_and_analysis": { "secret_scanning": { "status": "enabled" }, "secret_scanning_push_protection": { "status": "enabled" } } }
JSON

echo "Branch rules"
body=$(cat <<'JSON'
{
  "name": "Protect main", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "Test (Node 22)" }, { "context": "Test (Node 24)" }, { "context": "Docker image" }] } }
  ]
}
JSON
)
if id=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name == "Protect main") | .id' 2>/dev/null); then
  if [[ -n "$id" ]]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input - <<< "$body" >/dev/null
  else
    gh api -X POST "repos/$REPO/rulesets" --input - <<< "$body" >/dev/null
  fi
  echo "  main now only changes through squash-merged pull requests that pass CI."
else
  echo "  skipped: branch rules need a public repository (or GitHub Pro)."
fi

echo "Done."
