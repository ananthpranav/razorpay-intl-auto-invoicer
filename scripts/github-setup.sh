#!/usr/bin/env bash
# One-time GitHub setup: deploy settings, repository settings and branch rules.
# Needs `gh auth login`. For AWS deploys also set STACK (CloudFormation stack) and AWS_PROFILE. Safe to run again.
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
STACK="${STACK:-}"

output() {
  aws cloudformation describe-stacks --profile "$AWS_PROFILE" --region ap-south-2 --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

if [[ -n "$STACK" ]]; then
  : "${AWS_PROFILE:?Set AWS_PROFILE for the stack account}"
  echo "Deploy settings"
  gh secret set AWS_DEPLOY_ROLE_ARN --repo "$REPO" --body "$(output DeployRoleArn)"
  gh variable set S3_BUCKET --repo "$REPO" --body "$(output BucketName)"
  gh variable set CLOUDFRONT_DISTRIBUTION_ID --repo "$REPO" --body "$(output DistributionId)"
else
  echo "Deploy settings skipped (set STACK and AWS_PROFILE for an AWS deploy)"
fi

echo "Repository settings"
gh api -X PATCH "repos/$REPO" -f default_branch=dev \
  -F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true >/dev/null
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true >/dev/null

echo "Branch rules"
ruleset() { # name, branch, allowed merge methods as a JSON array
  local body id
  body=$(cat <<JSON
{
  "name": "$1", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/$2"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false, "allowed_merge_methods": $3 } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "Branch policy" }, { "context": "Build" }] } }
  ]
}
JSON
)
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id" 2>/dev/null) || return 1
  if [[ -n "$id" ]]; then
    gh api -X PUT "repos/$REPO/rulesets/$id" --input - <<< "$body" >/dev/null
  else
    gh api -X POST "repos/$REPO/rulesets" --input - <<< "$body" >/dev/null
  fi
}
if ruleset "Protect main" main '["merge"]' && ruleset "Protect dev" dev '["squash", "merge"]'; then
  echo "  main and dev now only change through pull requests that pass CI."
else
  echo "  Couldn't add branch rules. Private repositories need GitHub Pro for them."
  echo "  The 'Branch policy' check still flags wrong branches, but can't block the merge button."
fi

echo "Done."
