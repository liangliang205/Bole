/** 与主台账同库，审批和版本发布在一个事务内完成。 */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS job_families (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scorecard_versions (
 id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES job_families(id), version INTEGER NOT NULL,
 parent_id TEXT, profile_json TEXT NOT NULL, content_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('approved','retired','needs_review')),
 valid_from TEXT NOT NULL, valid_to TEXT, created_at TEXT NOT NULL, approved_by TEXT NOT NULL,
 approval_id TEXT NOT NULL UNIQUE, UNIQUE(family_id,version)
);
CREATE TRIGGER IF NOT EXISTS policy_immutable BEFORE UPDATE ON scorecard_versions
 WHEN OLD.id IS NOT NEW.id OR OLD.family_id IS NOT NEW.family_id OR OLD.version IS NOT NEW.version
 OR OLD.parent_id IS NOT NEW.parent_id OR OLD.profile_json IS NOT NEW.profile_json
 OR OLD.content_hash IS NOT NEW.content_hash OR OLD.valid_from IS NOT NEW.valid_from
 OR OLD.valid_to IS NOT NEW.valid_to OR OLD.created_at IS NOT NEW.created_at
 OR OLD.approved_by IS NOT NEW.approved_by OR OLD.approval_id IS NOT NEW.approval_id
 BEGIN SELECT RAISE(ABORT,'policy versions are immutable'); END;
CREATE TABLE IF NOT EXISTS job_policy_selections (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id), version_id TEXT NOT NULL REFERENCES scorecard_versions(id)
);
CREATE TABLE IF NOT EXISTS job_policy_bindings (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id), version_id TEXT REFERENCES scorecard_versions(id),
 snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, bound_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS binding_immutable BEFORE UPDATE ON job_policy_bindings
 BEGIN SELECT RAISE(ABORT,'job policy binding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bound_profile_immutable BEFORE UPDATE OF jd_json,scorecard_json ON jobs
 WHEN EXISTS(SELECT 1 FROM job_policy_bindings WHERE job_id=OLD.id)
 AND (OLD.jd_json IS NOT NEW.jd_json OR OLD.scorecard_json IS NOT NEW.scorecard_json)
 BEGIN SELECT RAISE(ABORT,'bound job profile is immutable'); END;
CREATE TABLE IF NOT EXISTS memory_proposals (
 id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES job_families(id), source_job_id TEXT,
 base_version_id TEXT, rule TEXT NOT NULL, why TEXT NOT NULL, how_to_apply TEXT NOT NULL,
 profile_json TEXT NOT NULL, content_hash TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','withdrawn')),
 approval_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, published_version_id TEXT
);
CREATE TRIGGER IF NOT EXISTS proposal_immutable BEFORE UPDATE ON memory_proposals
 WHEN OLD.id IS NOT NEW.id OR OLD.family_id IS NOT NEW.family_id OR OLD.base_version_id IS NOT NEW.base_version_id
 OR OLD.rule IS NOT NEW.rule OR OLD.why IS NOT NEW.why OR OLD.how_to_apply IS NOT NEW.how_to_apply
 OR OLD.profile_json IS NOT NEW.profile_json OR OLD.content_hash IS NOT NEW.content_hash
 OR OLD.valid_from IS NOT NEW.valid_from OR OLD.valid_to IS NOT NEW.valid_to OR OLD.approval_id IS NOT NEW.approval_id
 BEGIN SELECT RAISE(ABORT,'proposal content is immutable; create a new proposal'); END;
CREATE TABLE IF NOT EXISTS chat_message_order (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS chat_assign_sequence AFTER INSERT ON chat_messages BEGIN
 INSERT INTO chat_message_order(message_id,job_id) VALUES(NEW.id,NEW.job_id); END;
INSERT OR IGNORE INTO chat_message_order(message_id,job_id)
 SELECT id,job_id FROM chat_messages ORDER BY created_ts,rowid;
CREATE TABLE IF NOT EXISTS memory_summaries (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL,
 source_hash TEXT NOT NULL, summary_json TEXT NOT NULL, references_json TEXT NOT NULL,
 model TEXT NOT NULL, prompt_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_summary_job ON memory_summaries(job_id,through_seq);
`;
