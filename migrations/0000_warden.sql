CREATE TABLE IF NOT EXISTS warden_deliveries (
 id text PRIMARY KEY, event text NOT NULL, payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS warden_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK (kind IN ('delivery','reconcile')), payload jsonb NOT NULL,
 generation integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 lease_token uuid, completed boolean NOT NULL DEFAULT false,
 dead boolean NOT NULL DEFAULT false, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warden_jobs_ready ON warden_jobs(available_at) WHERE NOT completed AND NOT dead;
CREATE TABLE IF NOT EXISTS warden_prs (
 key text PRIMARY KEY, owner text NOT NULL, repo text NOT NULL, number integer NOT NULL,
 installation_id bigint NOT NULL, sha text NOT NULL, base_sha text NOT NULL,
 state text NOT NULL DEFAULT 'open', check_id bigint, comment_id bigint,
 published_hash text, fingerprint text, stable_since timestamptz,
 window_start timestamptz NOT NULL DEFAULT now(), bypass_actor text, bypass_sha text,
 last_decision jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warden_prs_head ON warden_prs(owner,repo,sha) WHERE state='open';
CREATE TABLE IF NOT EXISTS warden_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pr_key text NOT NULL REFERENCES warden_prs(key),
 sha text NOT NULL, source text NOT NULL, snapshot jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warden_observations_pr ON warden_observations(pr_key,id DESC);
CREATE TABLE IF NOT EXISTS warden_decisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pr_key text NOT NULL REFERENCES warden_prs(key),
 sha text NOT NULL, decision jsonb NOT NULL, decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warden_decisions_pr ON warden_decisions(pr_key,id DESC);
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS repository_id bigint NOT NULL;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS merge_sha text;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS empty_scans integer NOT NULL DEFAULT 0;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS empty_next_at timestamptz;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS scan_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS comment_hash text;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS comment_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS warden_config_revisions (
 installation_id bigint NOT NULL, repository_id bigint NOT NULL, revision text NOT NULL,
 hash text NOT NULL, content text, effective jsonb, error text,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(installation_id,repository_id,revision)
);
CREATE TABLE IF NOT EXISTS warden_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pr_key text, kind text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warden_audit_pr ON warden_audit(pr_key,id DESC);
CREATE TABLE IF NOT EXISTS warden_outputs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pr_key text NOT NULL,
 sha text NOT NULL, generation integer NOT NULL, hash text NOT NULL, desired jsonb NOT NULL,
 published boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(pr_key,generation,hash)
);
CREATE TABLE IF NOT EXISTS warden_effects (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pr_key text NOT NULL,
 kind text NOT NULL, desired jsonb NOT NULL, result jsonb, error text,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS warden_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pr_key text NOT NULL,
 sha text NOT NULL, kind text NOT NULL, identity text NOT NULL, outcome text NOT NULL,
 data jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warden_attempts_pr ON warden_attempts(pr_key,sha,identity,id DESC);
CREATE TABLE IF NOT EXISTS warden_metrics (name text PRIMARY KEY, value bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS warden_installations (id bigint PRIMARY KEY,state text NOT NULL);
CREATE TABLE IF NOT EXISTS warden_repositories (installation_id bigint NOT NULL,id bigint NOT NULL,owner text NOT NULL,name text NOT NULL,state text NOT NULL,PRIMARY KEY(installation_id,id));
CREATE TABLE IF NOT EXISTS warden_signals (
 pr_key text NOT NULL,sha text NOT NULL,kind text NOT NULL,identity text NOT NULL,
 data jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(pr_key,sha,kind,identity)
);
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS labels_hash text;
ALTER TABLE warden_observations ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;
ALTER TABLE warden_decisions ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;
ALTER TABLE warden_observations ADD COLUMN IF NOT EXISTS base_sha text;
ALTER TABLE warden_observations ADD COLUMN IF NOT EXISTS merge_sha text;
ALTER TABLE warden_prs ADD COLUMN IF NOT EXISTS base_ref text;
