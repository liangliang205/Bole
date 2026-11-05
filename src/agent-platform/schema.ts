export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_drafts (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_versions (
 version_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version TEXT NOT NULL,
 definition_json TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'registered',
 registered_at TEXT NOT NULL, UNIQUE(agent_id,version)
);
CREATE TRIGGER IF NOT EXISTS agent_version_immutable BEFORE UPDATE ON agent_versions
 WHEN OLD.version_key IS NOT NEW.version_key OR OLD.agent_id IS NOT NEW.agent_id OR OLD.version IS NOT NEW.version
 OR OLD.definition_json IS NOT NEW.definition_json OR OLD.content_hash IS NOT NEW.content_hash OR OLD.registered_at IS NOT NEW.registered_at
 BEGIN SELECT RAISE(ABORT,'Agent version content is immutable'); END;
CREATE TABLE IF NOT EXISTS agent_active_versions (
 agent_id TEXT PRIMARY KEY, version_key TEXT, revision INTEGER NOT NULL DEFAULT 0
);
-- Migrate the removed legacy status; preserve definitions and audit history.
UPDATE agent_active_versions SET version_key=NULL,revision=revision+1
 WHERE version_key IN (SELECT version_key FROM agent_versions WHERE status='revoked');
UPDATE agent_versions SET status='retired' WHERE status='revoked';
CREATE TABLE IF NOT EXISTS agent_teams (
 team_key TEXT PRIMARY KEY, definition_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_team_immutable BEFORE UPDATE ON agent_teams
 BEGIN SELECT RAISE(ABORT,'Agent team versions are immutable'); END;
CREATE TABLE IF NOT EXISTS job_agent_manifests (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id), manifest_json TEXT NOT NULL, content_hash TEXT NOT NULL, bound_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_manifest_immutable BEFORE UPDATE ON job_agent_manifests
 BEGIN SELECT RAISE(ABORT,'Agent manifest is immutable'); END;
CREATE TABLE IF NOT EXISTS agent_invocations (
 id TEXT PRIMARY KEY, job_id TEXT, slot TEXT NOT NULL, version_key TEXT NOT NULL,
 state TEXT NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL, finished_at TEXT,
 input_hash TEXT NOT NULL, result_hash TEXT, error TEXT, meta_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_load ON agent_invocations(version_key,state,expires_at);
CREATE TABLE IF NOT EXISTS specialist_results (
 job_id TEXT NOT NULL, resume_id TEXT NOT NULL, version_key TEXT NOT NULL, result_json TEXT NOT NULL,
 document_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(job_id,resume_id,version_key)
);
`;
