# Warden

Warden is a self-hosted GitHub App that combines pull-request checks into one
required check: **Warden / All checks passed**. It watches GitHub webhooks,
reconciles state through the GitHub API, and keeps an updated PR comment showing
what passed, what is running, and what is blocking the gate.

Use it to avoid maintaining a branch-protection list of every individual CI job.
Warden reports check results; GitHub branch protection or repository rulesets
enforce the merge requirement.

## How it works

- Aggregates check runs, commit statuses, and workflow state for the PR head and
  its current merge candidate, when available.
- Tracks reruns and supports ignoring checks, statuses, or workflows.
- Stores deliveries, queued work, observations, and publication history in
  PostgreSQL so work can resume after a restart.
- Uses a discovery grace period and a quiet period before publishing success.
  Observation errors and timeouts keep the gate blocking.
- Reads `.github/warden.yml` from the PR's base commit. A change in the PR itself
  cannot weaken that PR's policy.
- Supports a permission-checked `skip warden` label for a specific PR head.
  A shared head cannot be bypassed independently.

The default policy treats `success`, `neutral`, and `skipped` check conclusions as
passing. It also permits a PR with no eligible checks to pass after three complete
scheduled empty scans. Set `empty_checks.policy: block` if your repositories must
have checks. See the [configuration reference](docs/configuration.md).

## Try it locally

Install [Bun](https://bun.sh/) **1.4.2** and Docker with Compose v2. Then, from the
repository root:

```sh
bun install --frozen-lockfile
bun run demo
```

The demo uses a local GitHub API fixture and a real PostgreSQL database; it needs
no GitHub credentials and makes no changes to GitHub repositories. It exercises
signed webhooks, check transitions, bypass handling, and worker restart recovery.
It uses port 3100 by default; set `WARDEN_PORT` to choose another port.

Each run creates a separate Compose project, stops its services on exit, and
retains its database history. The final output identifies that project and its
storage. To inspect it, use `docker compose -p <project-name> -f compose.yml logs`.
Remove its containers and volume only when you no longer need that demo history.

For an interactive fixture environment:

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3000/ready
```

This local Compose configuration always uses fixture authentication. Follow the
[deployment guide](docs/deployment.md) to connect Warden to GitHub.

## Install on GitHub

1. Register a GitHub App with the permissions and events in
   [github-app-manifest.json](github-app-manifest.json).
2. Deploy Warden with PostgreSQL and expose its signed webhook endpoint over
   HTTPS. See [deployment and operations](docs/deployment.md).
3. Install your App on the repositories to monitor and confirm that it publishes
   **Warden / All checks passed** on a PR.
4. Add that check to branch protection or a repository ruleset, selecting your
   GitHub App as the expected source where GitHub offers that option.

Warden aggregates checks it can observe; it does not define which workflows must
exist or run. Keep any separate required checks you need, especially while
validating your Warden policy. A label bypass affects only Warden's check.

## Documentation

- [Deployment and operations](docs/deployment.md): GitHub App setup, containers,
  environment variables, health checks, and troubleshooting.
- [Configuration](docs/configuration.md): repository policy, ignore patterns,
  discovery timing, and bypass rules.
- [PostgreSQL upgrades](docs/postgresql-upgrade.md): preserving data when moving
  an existing PostgreSQL 17 deployment to PostgreSQL 18.
- [Contributing](CONTRIBUTING.md): local checks, integration tests, and changes.

## License

Warden is released under the [MIT License](LICENSE). Bundled dependency licenses
are recorded in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt); preserve those
notices when distributing bundled builds.
