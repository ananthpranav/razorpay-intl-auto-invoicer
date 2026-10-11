# Contributing

## Branches

- `dev` is the default branch. All work lands there.
- Branch off `dev` as `feature/<name>` or `hotfix/<name>`, and open the pull request back into `dev`.
- `main` only takes `release-x.y.z` branches. CI blocks anything else.

## Before you open a pull request

```sh
npm ci
npm run typecheck
npm test
docker build -t invoicer:dev .
```

Don't commit `.env`, `clients.json`, `bank-details.json`, `output/` or `data/`. They're ignored, but check `git status` anyway.

## Releases

1. Run **Actions → Start release** (pick `minor`, `patch` or `major`). It cuts `release-x.y.z` from `dev` and opens the pull request into `main`.
2. Merge that pull request with a merge commit, not a squash.
3. The Release workflow publishes the Docker image to `ghcr.io/ananthpranav/razorpay-intl-auto-invoicer` with the tags `x.y.z`, `x.y`, `x` and `latest`, then creates the `vX.Y.Z` GitHub release.

To rebuild `latest` without a release (for example after a Node base image fix), run **Actions → Release** by hand.
