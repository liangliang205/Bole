export const EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_queue (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 root_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 node_path TEXT NOT NULL, label TEXT NOT NULL, resources_json TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 1 CHECK(priority BETWEEN 0 AND 2),
 state TEXT NOT NULL, reason TEXT, owner TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(run_id,node_path,label)
);
CREATE INDEX IF NOT EXISTS idx_execution_ready ON execution_queue(state,priority,created_at);
`;
