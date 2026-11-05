export const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_definitions (
 workflow_key TEXT PRIMARY KEY, content_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS workflow_definition_immutable BEFORE UPDATE ON workflow_definitions
 BEGIN SELECT RAISE(ABORT,'Workflow definitions are immutable'); END;
CREATE TABLE IF NOT EXISTS workflow_runs (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), workflow_key TEXT NOT NULL REFERENCES workflow_definitions(workflow_key),
 root_run_id TEXT NOT NULL, parent_run_id TEXT, parent_node_path TEXT,
 definition_hash TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
 status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 lease_owner TEXT, lease_until INTEGER,
 UNIQUE(parent_run_id,parent_node_path)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_job_root ON workflow_runs(job_id) WHERE parent_run_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_root ON workflow_runs(root_run_id);
CREATE TRIGGER IF NOT EXISTS workflow_run_binding_immutable BEFORE UPDATE ON workflow_runs
 WHEN OLD.id IS NOT NEW.id OR OLD.job_id IS NOT NEW.job_id OR OLD.workflow_key IS NOT NEW.workflow_key
 OR OLD.root_run_id IS NOT NEW.root_run_id OR OLD.parent_run_id IS NOT NEW.parent_run_id
 OR OLD.parent_node_path IS NOT NEW.parent_node_path OR OLD.definition_hash IS NOT NEW.definition_hash
 OR OLD.input_json IS NOT NEW.input_json
 BEGIN SELECT RAISE(ABORT,'Workflow run bindings are immutable'); END;
CREATE TABLE IF NOT EXISTS workflow_nodes (
 run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, path TEXT NOT NULL,
 node_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 input_json TEXT NOT NULL, output_json TEXT, control_json TEXT,
 attempt INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(run_id,path)
);
CREATE TRIGGER IF NOT EXISTS workflow_node_input_immutable BEFORE UPDATE ON workflow_nodes
 WHEN OLD.run_id IS NOT NEW.run_id OR OLD.path IS NOT NEW.path OR OLD.node_id IS NOT NEW.node_id
 OR OLD.kind IS NOT NEW.kind OR OLD.input_json IS NOT NEW.input_json
 BEGIN SELECT RAISE(ABORT,'Workflow node inputs are immutable'); END;
`;
