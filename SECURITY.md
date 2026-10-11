# Security

## Reporting a problem

Please report security problems privately: open the repository's **Security** tab and click **Report a vulnerability**. Don't open a public issue for them.

## Keeping your setup safe

- `.env`, `clients.json`, `bank-details.json`, `output/` (PDFs and reports) and `data/` (payment state) hold your keys and your clients' details. They're in `.gitignore`, but check `git status` before you commit.
- If your Razorpay key leaks, make a new one in the Razorpay Dashboard (Account & Settings → API Keys), update `.env` and restart.
- If your email password leaks, revoke it with your email provider. Use an app password rather than your main password.
- Try new settings with `rzp_test_` keys and `invoice --dry-run` first.
- The logs don't contain keys or client details, but read them before you paste them into an issue.

## Checking the Docker image

Release images are built by GitHub Actions and carry a signed build provenance attestation. To check an image really came from this repository:

```sh
gh attestation verify oci://ghcr.io/ananthpranav/razorpay-intl-auto-invoicer:latest --owner ananthpranav
```
