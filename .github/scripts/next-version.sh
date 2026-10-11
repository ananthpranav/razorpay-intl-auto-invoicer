#!/usr/bin/env bash
# Works out the next release version from the latest vX.Y.Z tag.
# Env: BUMP (major|minor|patch, default minor) or EXACT (x.y.z). Writes version= and previous= to $GITHUB_OUTPUT.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
latest=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)
current="${latest#v}"
current="${current:-0.0.0}"

if [[ -n "${EXACT:-}" ]]; then
  next="${EXACT#v}"
else
  IFS=. read -r major minor patch <<< "$current"
  case "${BUMP:-minor}" in
    major) next="$((major + 1)).0.0" ;;
    minor) next="$major.$((minor + 1)).0" ;;
    patch) next="$major.$minor.$((patch + 1))" ;;
    *) echo "::error::Unknown bump '${BUMP}'."; exit 1 ;;
  esac
fi

if [[ ! "$next" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Version must look like 1.2.3, not '$next'."
  exit 1
fi
if [[ "$next" == "$current" || "$(printf '%s\n%s\n' "$current" "$next" | sort -V | tail -n1)" != "$next" ]]; then
  echo "::error::Version $next must be higher than the latest release (${latest:-none})."
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
  echo "::error::Tag v$next already exists."
  exit 1
fi

echo "Next release: $next (previous: ${latest:-none})"
{ echo "version=$next"; echo "previous=$latest"; } >> "$out"
