# Security

This document describes what FlowForge protects, what it does not, and why.

## Threat model

FlowForge assumes **workflow authors are trusted**. A workflow author can make
arbitrary HTTP requests and run JavaScript — by design; that is what the platform
is for.

The boundaries it _does_ enforce:

- Callers of a deployed endpoint cannot read secrets or other workflows.
- Someone with read access to the database cannot recover credential plaintext.
- Anyone reading a trace, a log, or an API response cannot recover a secret.

If you need untrusted users to author workflows, read [Untrusted
authors](#untrusted-authors) before deploying.

## Secret handling

Secrets never enter a workflow document. Config holds a reference:

```json
{ "headers": { "Authorization": { "$secret": "ACME_API_KEY" } } }
```

At execution time:

1. The vault resolves the reference. Resolution order is the encrypted store, then
   `process.env` — so a container can inject secrets without touching the UI.
2. Every resolved value is recorded in a per-run set.
3. Before any value is written to a trace, streamed over SSE, or persisted, it
   passes through `redact()`, which strips values by **key name** (`/secret|token|
password|api[-_]?key|authorization|credential|bearer/i`) _and_ by exact match
   against that run's resolved values.

The second check is what catches a secret that leaked into a URL, an error
message, or a model's echoed output.

### Encryption at rest

AES-256-GCM. The key is derived from `FLOWFORGE_SECRET_KEY` with scrypt. Each
value gets a fresh 12-byte IV; the stored payload is `iv.authTag.ciphertext`, all
base64. GCM means tampering is detected, not just undetected-but-wrong.

`GET /api/credentials` returns metadata only. There is no endpoint that returns
plaintext.

> Without `FLOWFORGE_SECRET_KEY`, the key falls back to a constant published in
> this repository. It exists so `pnpm dev` works with no setup and provides
> **zero** protection. Always set a real key:
>
> ```bash
> openssl rand -base64 32
> ```

## Deployment authentication

Tokens are generated with `randomBytes(24)`, shown exactly once, and stored only
as a SHA-256 hash. Verification uses `timingSafeEqual` after a length check, so a
comparison leaks neither length nor prefix.

Rate limiting is applied per deployment and per client on every execution route.

## Input validation

Every request body is parsed with Zod at the route boundary; failures return 400
with per-field detail. Node configuration is validated twice: structurally on
every canvas edit, and against the real schema after expression resolution
immediately before execution.

Expressions are resolved by a **path walker**, not an evaluator. There is no
`eval` and no `Function` constructor in the expression engine, so a malicious
template cannot execute code.

## Error handling

Unexpected errors return an opaque `{"error": "Internal server error"}` with a 500. The real message and stack are logged server-side only. Workflow errors can
easily contain prompt fragments or a URL with a token in the query string, so
they are never echoed to a client verbatim.

Trace payloads are size-capped per value (32 KB by default), which bounds both
memory during a run and the size of a stored record.

## Known limitations

### Code execution is isolated, not sandboxed

The **Function** node runs user JavaScript in a fresh `node:vm` context with no
`require`, no `process`, no filesystem, and a hard timeout.

`node:vm` shares a V8 heap with the host process and is escapable by a determined
attacker — this is a documented property of the API, not a bug in FlowForge. It is
safe for code _you_ author. It is **not** a security boundary.

The **Python** node ships with no bundled runner for exactly this reason. It
requires an explicit `PYTHON_RUNNER_URL` pointing at an isolated service.

### Server-side request forgery

The **REST API**, **Webhook**, and **MCP Server** nodes fetch whatever URL a
workflow specifies, including `169.254.169.254` and other internal addresses.
There is no egress allow-list.

### No authentication layer

This release has no user accounts, sessions, or multi-tenancy. Every workflow
belongs to one local owner, and every console route is unauthenticated. Only
`/api/v1/:slug` is designed to be publicly reachable.

**Do not expose an instance to the internet without an authenticating reverse
proxy.**

### Rate limiting is per-process

The limiter is an in-memory token bucket. N instances allow N× the configured
limit.

### The vector store is process-local

`MemoryVectorStore` is not shared between instances and does not survive a
restart.

## Untrusted authors

If people you do not trust can create workflows, you need all of the following
before deploying:

1. **Move code execution out of process.** Replace the Function node with one that
   dispatches to a Firecracker microVM, a gVisor container, or a Deno process with
   explicit permissions.
2. **Restrict egress.** Put the app behind a proxy that blocks link-local
   (`169.254.0.0/16`), private ranges, and localhost.
3. **Add authentication and per-tenant isolation.** Give each tenant its own
   `NodeRegistry` and `Store` scope — the registry is an instance, not module
   state, specifically to make this possible.
4. **Cap resources.** Lower `FLOWFORGE_MAX_DEPTH`, per-node timeouts, and
   workflow concurrency.
5. **Review the node allow-list.** Consider not registering the Function, Python,
   REST, and MCP nodes at all for untrusted tenants.

## Reporting

See [SECURITY.md](../SECURITY.md). Use GitHub's private vulnerability reporting;
do not open a public issue.
