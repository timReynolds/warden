-- Preserve existing migration checksums; new observation windows use wall time,
-- not the beginning of a transaction which may spend time waiting for locks.
ALTER TABLE warden_prs ALTER COLUMN window_start SET DEFAULT clock_timestamp();
ALTER TABLE warden_observations ALTER COLUMN observed_at SET DEFAULT clock_timestamp();
ALTER TABLE warden_decisions ALTER COLUMN decided_at SET DEFAULT clock_timestamp();
CREATE UNIQUE INDEX warden_unversioned_receipt ON warden_audit(pr_key,kind,(data->>'delivery'))
 WHERE kind='unversioned_pending';
CREATE INDEX warden_prs_tenant_head ON warden_prs(installation_id,repository_id,sha) WHERE state='open';
CREATE INDEX warden_prs_tenant_merge ON warden_prs(installation_id,repository_id,merge_sha) WHERE state='open' AND merge_sha IS NOT NULL;
