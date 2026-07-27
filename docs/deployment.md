# Deployment

## Running it

### Vercel

```bash
vercel
```

Set `FLOWFORGE_SECRET_KEY` in project settings before you store any credential.

**Important:** the default file store writes to the local filesystem, which is
ephemeral and per-instance on Vercel. Workflows will not survive a redeploy and
will not be shared between lambda instances. For anything beyond a demo, use a
Postgres store adapter or a long-running host.

### Docker

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
VOLUME /app/.flowforge
EXPOSE 3000
CMD ["pnpm", "start"]
```

```bash
docker run -p 3000:3000 \
  -e FLOWFORGE_SECRET_KEY="$(openssl rand -base64 32)" \
  -v flowforge-data:/app/.flowforge \
  flowforge
```

Mount the volume. Without it, every workflow disappears when the container
restarts.

### Any Node host

```bash
pnpm install --frozen-lockfile
pnpm build
FLOWFORGE_SECRET_KEY=… pnpm start
```

## Production checklist

- [ ] `FLOWFORGE_SECRET_KEY` set to a real 32-byte random value
- [ ] An authenticating reverse proxy in front of the app — **there is no built-in
      auth layer**, and only `/api/v1/:slug` is designed to be publicly reachable
- [ ] Persistent storage for `.flowforge/` (or a Postgres adapter)
- [ ] Egress restrictions if untrusted users can author workflows (the HTTP and
      MCP nodes will fetch any URL)
- [ ] Code-execution nodes moved to an isolated process if the instance is
      multi-tenant — see [security.md](security.md)
- [ ] A shared rate limiter if you run more than one instance

## Deployment kinds

A deployment exposes one **published version** at `/api/v1/:slug`. All kinds
share the same handler, auth path, and rate limiter; they differ in how the caller
is expected to shape the request.

| Kind       | Use                                                               |
| ---------- | ----------------------------------------------------------------- |
| `rest`     | Synchronous JSON request/response                                 |
| `webhook`  | Third-party delivery target (Stripe, GitHub, …)                   |
| `schedule` | Cron-triggered — needs an external scheduler to call the endpoint |
| `worker`   | Queue-drained background processing                               |
| `chat`     | Conversational client                                             |
| `cli`      | Terminal invocation                                               |
| `widget`   | Embedded via iframe                                               |

### Version pinning

A deployment records the version number it was created from and always serves
that graph. Publishing a new draft does **not** change a live endpoint. To ship an
update, publish and then create a new deployment (or update the existing one's
version).

This is deliberate: an editor saving a draft should never be able to change
production behaviour by accident.

### Tokens

```bash
curl -X POST localhost:3000/api/deployments -H 'Content-Type: application/json' \
  -d '{"workflowId":"wf_…","kind":"rest","requireToken":true}'
```

The plaintext token appears in that response and nowhere else — only a SHA-256
hash is stored, and comparison is constant-time. To rotate, create a new
deployment and delete the old one.

### Rate limiting

Per deployment and per client IP, default 60/minute, configurable at creation.
The limiter is in-process; a multi-instance deployment needs a shared one in front.

## Scheduled workflows

The `schedule` deployment kind records a cron expression but does **not** yet run
a scheduler — that is on the roadmap. Until then, drive it externally:

```yaml
# .github/workflows/nightly.yml
on:
  schedule:
    - cron: '0 9 * * *'
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST ${{ secrets.FLOWFORGE_URL }}/api/v1/nightly-digest \
            -H "Authorization: Bearer ${{ secrets.FLOWFORGE_TOKEN }}" \
            -H "Content-Type: application/json" -d '{}'
```

## Scaling notes

Two things are per-process and will surface first under load:

1. **The in-memory vector store** is not shared between instances. Move to
   pgvector before scaling horizontally.
2. **The rate limiter** is per-process, so N instances allow N× the configured
   limit.

Everything else — the executor, validation, tracing — is stateless per run.
