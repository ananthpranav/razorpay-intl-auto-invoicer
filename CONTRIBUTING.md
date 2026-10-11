# Contributing

Thanks for helping out. Bug reports, ideas and pull requests are all welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md).

## Bugs and ideas

Open an issue using one of the templates. Never paste API keys, client details or bank details. Report security problems privately instead: see [SECURITY.md](SECURITY.md).

## Making a change

1. Fork the repository and create a branch from `main`.
2. Install with `npm ci` (Node 22.18 or newer).
3. Make your change, with tests, and run:

   ```sh
   npm run typecheck
   npm test
   docker build -t invoicer:dev .   # if you touched the Dockerfile or dependencies
   ```

4. Open a pull request into `main` and say what changed and why. CI has to pass before it can be merged.

Pull requests are squash-merged, so the title becomes the commit message. Keep it short and clear, like "Fix reminder dates near midnight" or "Add EUR to the sample bank details". Small, focused pull requests are easier to review than big ones.

## Releases

Maintainers release from `main`, using [semantic versioning](https://semver.org).

1. Check that `main` is green.
2. Create the release: on GitHub, **Releases → Draft a new release**, type a new tag like `v1.3.0`, click **Generate release notes** and publish. Or from a terminal:

   ```sh
   gh release create v1.3.0 --target main --generate-notes
   ```

3. Publishing runs the Release workflow. It builds the Docker image for amd64 and arm64 and pushes it to `ghcr.io/ananthpranav/razorpay-intl-auto-invoicer` with the tags `1.3.0`, `1.3`, `1` and `latest`. Pre-releases like `v1.3.0-rc.1` only get their exact tag.

Labels on pull requests sort the release notes: `enhancement`, `bug`, `documentation`, `dependencies` and `breaking-change`. Use `skip-changelog` to leave one out.

To rebuild an existing release (for example after a fix in the Node base image), run **Actions → Release** with that tag.
