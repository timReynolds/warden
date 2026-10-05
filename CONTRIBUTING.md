# Contributing to Warden

Use issues for bugs and proposals, and pull requests for changes. Include steps
to reproduce a bug, expected and actual behavior, and relevant logs with secrets
and private repository data removed.

## Development setup

Install Bun **1.4.2**, matching `.bun-version`, and Docker with Compose v2:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

Unit tests do not need GitHub credentials or a database. The local demo and
integration tests use the GitHub fixture in `demo/github.ts`.

## Integration tests

Integration tests require a dedicated PostgreSQL database named `warden_test`.
They clear Warden tables between cases; never point them at deployment data.
The local Compose stack initializes this test database on fresh storage:

```sh
docker compose up -d --build
docker compose --profile tools run --rm --build test
```

If you already have local PostgreSQL, create the dedicated database and supply
its connection URL when running the tests. For example:

```sh
WARDEN_TEST_DATABASE_URL=postgres://warden:warden@127.0.0.1:5432/warden_test bun run test:integration
```

Existing Compose volumes created before the test-database initializer was added
need that database created manually. Do not delete a volume to initialize it.

`bun run check` runs lint, type checking, unit tests, integration tests, and the
build. Set `WARDEN_TEST_DATABASE_URL` before running it. PostgreSQL-backed checks
are mandatory in CI. For the container demo, run `bun run demo`; it verifies
webhook processing and recovery after a worker restart in an isolated project.

## Preparing a change

- Keep behavior changes focused and update the relevant public documentation.
- Add regression coverage for changes to evaluation, delivery handling,
  reconciliation, or publication. Use the fixture instead of live GitHub writes.
- Run `bun run format` when changing source and run the relevant checks above.
- Add a new numbered SQL migration for schema changes. Never edit a migration
  that may already have been applied; the runner checks its checksum.
- When updating dependencies, commit `bun.lock`, run `bun run audit`, regenerate
  notices with `bun run notices`, and verify them with `bun run notices:check`.
  Preserve reviewed license texts in `licenses/` when upstream packages omit them.
- Keep credentials, database dumps, local logs, and private planning notes out of
  commits and release artifacts.

CI additionally checks dependency audit results, license notices, PostgreSQL
upgrade safeguards, Docker builds, and the isolated demo. The upgrade test is
`sh scripts/test-postgres-upgrade.sh`; see the
[upgrade guide](docs/postgresql-upgrade.md) for what it verifies.

For a suspected security vulnerability, use GitHub's private **Report a
vulnerability** option in the repository's Security tab when available. If it is
unavailable, request a private reporting channel from the maintainer without
posting vulnerability details in a public issue.
