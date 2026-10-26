# Security policy

ContextVault is pre-release, not production-ready, and offers no security guarantees. See the [threat model](docs/threat-model.md) for what is implemented and what is not.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a suspected vulnerability, and do not include real credentials or customer data in a report.

Reports are handled on a best-effort basis; there is no response-time commitment.

## Scope

In scope: the code, configuration, and CI workflows in this repository. Out of scope: the development-only placeholder credentials in `.env.example`, which are public by design and used only by the local Docker Compose stack.
