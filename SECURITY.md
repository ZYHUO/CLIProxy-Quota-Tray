# Security Policy

## Reporting

Please report vulnerabilities privately rather than in a public issue.

## Important

This app talks to a **local** CLIProxyAPI Management API. Treat the CPA token
like a password:

- Don't commit it, share it in a screenshot, or post it in an issue.
- The app stores usage-queue records locally in the Electron userData directory.
- If you run CPA on a non-loopback address, make sure that's intentional and
  the port is firewalled — the Management API is powerful.
