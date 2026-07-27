# Security Policy

## Supported versions

FlowForge is pre-1.0. Security fixes land on `main` and in the latest release.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. If that is unavailable, open a minimal issue asking for a private
contact channel, with no technical detail.

Please include:

- the affected component and version or commit,
- reproduction steps or a proof of concept,
- the impact you believe it has.

You can expect an acknowledgement within 72 hours and an assessment within seven
days. We will keep you updated through to a fix and credit you in the release
notes unless you prefer otherwise. Please give us 90 days before public
disclosure.

## Known limitations — read before deploying

These are design trade-offs, documented rather than hidden.

### Code execution nodes are isolated, not sandboxed

The **Function** node runs user JavaScript in a fresh `node:vm` context with no
`require`, no `process`, and a hard timeout. `node:vm` shares a heap with the host
process and is escapable by a determined attacker. It is safe for code _you_
author. It is **not** a security boundary for untrusted input.

If you run FlowForge multi-tenant, move code execution to a separate process or a
Firecracker/Deno-style sandbox before you accept untrusted workflows.

The **Python** node ships with no bundled runner for the same reason — it requires
an explicit `PYTHON_RUNNER_URL` pointing at an isolated service.

### Server-side request forgery

The **REST API**, **Webhook**, and **MCP Server** nodes will fetch any URL a
workflow author configures, including internal addresses. There is no egress
allow-list. If untrusted users can author workflows, put FlowForge behind an
egress proxy that blocks link-local and private ranges.

### No authentication layer

This release has no user authentication or multi-tenancy. Every workflow belongs
to a single local owner. **Do not expose an instance to the public internet
without putting an authenticating reverse proxy in front of it.** Deployment
endpoints under `/api/v1/:slug` are separately protected by bearer tokens and are
the only routes designed to be publicly reachable.

### Rate limiting is per-process

The built-in limiter is in-memory. It protects a single instance. A multi-instance
deployment needs a shared limiter in front of it.

### Development encryption key

Without `FLOWFORGE_SECRET_KEY`, credential encryption falls back to a constant
that is published in this repository. It exists so `pnpm dev` works out of the
box and provides **no** protection. Always set a real key in production:

```bash
openssl rand -base64 32
```

## What we do protect

- Secrets are referenced, never embedded in workflow documents.
- Stored credentials are encrypted with AES-256-GCM, key derived via scrypt.
- Resolved secret values are tracked per run and stripped from every trace,
  log, and API response.
- Deployment tokens are stored only as SHA-256 hashes and compared in constant
  time.
- API errors are opaque; internal messages and stack traces never reach a client.
- Trace payloads are size-capped to bound memory and storage.
