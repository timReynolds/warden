CREATE TABLE warden_gates (
  installation_id bigint NOT NULL,
  repository_id bigint NOT NULL,
  sha text NOT NULL,
  check_id bigint,
  published_hash text,
  PRIMARY KEY (installation_id, repository_id, sha)
);
