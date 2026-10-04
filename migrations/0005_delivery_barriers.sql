ALTER TABLE warden_prs ADD COLUMN delivery_error_jobs uuid[] NOT NULL DEFAULT '{}';
UPDATE warden_prs SET delivery_error_jobs=ARRAY[delivery_error_job] WHERE delivery_error_job IS NOT NULL;
ALTER TABLE warden_prs DROP COLUMN delivery_error_job;
