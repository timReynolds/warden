# Deployment and operations

Warden runs on Bun 1.4.2 with PostgreSQL. The included Compose deployments use
PostgreSQL 18.6. A combined process serves webhooks and runs queued work; you can
also deploy the API and worker separately against the same database.

## Register a GitHub App

Create an App in your GitHub account or organization settings. Use
[`github-app-manifest.json`](../github-app-manifest.json) as the configuration
reference, replacing `https://YOUR-WARDEN-HOST.example` with your deployment URL.
The manifest is a template; Warden does not serve a manifest-registration UI.

Set the webhook URL to `https://<your-host>/webhooks/github`, enable webhook
delivery, and choose a random, high-entropy webhook secret of at least 16
characters. Configure these repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Checks | Read and write | Read checks and publish the aggregate gate |
| Commit statuses | Read | Observe commit statuses |
| Pull requests | Read and write | Read PRs and maintain the status comment |
| Contents | Read | Read trusted-base policy and repository revisions |
| Actions | Read | Read workflow runs and current jobs |
| Metadata | Read | Resolve repository identity and permissions |

Subscribe to `pull_request`, `check_run`, `check_suite`, `status`, `workflow_run`,
`push`, and `repository` events. GitHub also delivers installation lifecycle
events to Apps. Record the **App ID** (not the client ID), generate a private
key, and install the App on the repositories you want to monitor. The template
uses a private App; source-code licensing and GitHub App visibility are separate
settings.

## Deploy with Docker Compose

Run these commands from the repository root. Docker Compose v2 is required.

```sh
cp .env.example .env
```

Edit `.env` before starting services:

- Set `WARDEN_APP_ID` and `WARDEN_WEBHOOK_SECRET` to your App's values.
- Store the generated private key securely and set
  `WARDEN_PRIVATE_KEY_HOST_PATH` to its path on the host. Compose mounts it as
  `/run/secrets/warden_private_key`. Ensure the container's `bun` user can read
  the mounted file.
- Replace `WARDEN_POSTGRES_PASSWORD` and use the same password in `DATABASE_URL`
  for the bundled database. URL-encode reserved characters in the connection URL.
- Keep `.env`, the private key, and database backups out of version control.

```sh
docker compose -f compose.production.yml up -d --build app
curl --fail http://127.0.0.1:3000/ready
docker compose -f compose.production.yml logs --tail=100 app
```

Compose starts PostgreSQL, applies migrations, then starts the app. The API is
bound to host loopback on port 3000 by default. Put an HTTPS reverse proxy in
front of it and route GitHub's webhook requests to `/webhooks/github`. Use
`WARDEN_PORT` to change the published host port; the container still uses 3000.

The API also serves health and metrics endpoints without authentication. Expose
the webhook route publicly and restrict operational endpoints to your monitoring
or administration network. Webhook bodies are limited to 2 MiB and require a
valid `X-Hub-Signature-256` signature. A `202` response means the delivery was
stored for processing; it does not mean the worker has finished.

After installation, confirm a signed delivery in the App's recent deliveries
view and check a PR for Warden's output. Installation events enqueue existing
open PRs. To seed or refresh an installation manually, replace `12345678` with
the installation ID shown in the App installation URL:

```sh
docker compose -f compose.production.yml run --rm app bun dist/cli.js 12345678
```

Once the check is visible, require **Warden / All checks passed** in GitHub branch
protection or a repository ruleset. Select your App as its expected source where
available. Warden does not change branch-protection settings for you.

### Separate API and worker processes

Stop the combined app before switching to the split deployment; the API uses
the same host port:

```sh
docker compose -f compose.production.yml stop app
docker compose -f compose.production.yml --profile split up -d --build api worker
```

Start `api worker` explicitly. Starting the whole profile without service names
also selects the combined app. All processes must use the same database, App
credentials, and webhook secret. The worker serves its health endpoints on
container port 3001, which is not published by the production Compose file.

### Run directly with Bun

With a reachable PostgreSQL database and the runtime environment configured:

```sh
bun install --frozen-lockfile
bun run migrate
bun run start
```

For separate processes, use `bun run api` and `bun run worker`. To enqueue an
installation, use `bun run onboard 12345678`. You can build first with
`bun run build` and run `bun dist/app.js`, `bun dist/app.js api`, or
`bun dist/app.js worker`. Run from the repository root so the migration command
can find `migrations/`.

## Environment reference

Bun reads the repository's `.env` for native commands. Docker Compose reads it
for substitution and passes the variables listed in the Compose file.

| Variable | Default / requirement |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL |
| `WARDEN_APP_ID` | Required positive GitHub App ID |
| `WARDEN_WEBHOOK_SECRET` | Required; at least 16 characters |
| `WARDEN_PRIVATE_KEY_FILE` | Path to PEM key; required unless an inline key is supplied |
| `WARDEN_PRIVATE_KEY` | Alternative inline PEM; escaped `\n` is supported; file takes precedence |
| `WARDEN_GITHUB_API_URL` | `https://api.github.com`; set your enterprise API URL if needed |
| `PORT` | `3000` for native API / combined process |
| `WARDEN_WORKER_HEALTH_PORT` | `3001` for the native worker health server |
| `WARDEN_JOB_LEASE_SECONDS` | `60`; range 5–600 seconds |
| `WARDEN_WORKER_POLL_MS` | `1000`; minimum 50 milliseconds |
| `WARDEN_MIGRATIONS_DIR` | `migrations/` beneath the current directory |

The production Compose file additionally uses:

| Variable | Default / requirement |
| --- | --- |
| `WARDEN_POSTGRES_PASSWORD` | Required password for bundled PostgreSQL |
| `WARDEN_PRIVATE_KEY_HOST_PATH` | Required host path mounted as a Compose secret |
| `WARDEN_PORT` | `3000`, published on `127.0.0.1` |
| `WARDEN_POSTGRES_VOLUME` | `<compose-project-name>_warden-data` |

The bundled database is the supported Compose path. Native processes can point
at an external PostgreSQL database. The production Compose file still starts its
bundled PostgreSQL service when `DATABASE_URL` points elsewhere, so adapt the
deployment dependencies if you want an external-only database.

## Operations and troubleshooting

| Endpoint | Meaning |
| --- | --- |
| `GET /live` | Process is responding |
| `GET /ready` | Database query succeeds; returns 503 otherwise |
| `GET /health` | Compatibility health check with a database query |
| `GET /metrics` | JSON counters and pending/dead job counts and queue lag |

Readiness checks database connectivity, so also monitor worker logs and queue
lag to confirm work is being processed. API and worker logs include delivery or
job identifiers for diagnosis. Both processes shut down on `SIGTERM` or `SIGINT`.

- **Webhook returns 401:** confirm the configured secret matches the App's
  webhook secret and that the proxy preserves the body and signature header.
- **No check appears:** confirm installation access, App permissions, webhook
  deliveries, and running workers. Use onboarding to enqueue existing PRs.
- **Configuration error:** fix `.github/warden.yml` in the PR's target branch.
  See the [configuration reference](configuration.md).
- **Observation error or timeout:** inspect GitHub API access, rate limits, and
  worker logs. Resolve the cause, then use **Reconcile now** on the check.
- **Gate remains pending:** inspect the comment and check summary for running
  signals, startup failures, empty-check policy, or a PR sharing the head SHA.

Back up PostgreSQL and protect the backup as repository data. Warden retains
delivery payloads and operational history; account for database growth and your
retention requirements. Do not remove its volume during routine upgrades.
Application migrations are ordered, checksummed SQL files and must run before
starting an upgraded app.
