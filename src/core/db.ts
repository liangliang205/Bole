import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  requirements TEXT NOT NULL,
  jd_json TEXT,
  scorecard_json TEXT,
  fairness_json TEXT,
  status TEXT NOT NULL,
  seed TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  label TEXT NOT NULL,
  sha256 TEXT,
  dedup_key TEXT,
  source_msg_id TEXT,
  source_path TEXT,
  raw_path TEXT,
  norm_path TEXT,
  format TEXT,
  status TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  batch_id INTEGER,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resumes_job ON resumes(job_id, status);
CREATE INDEX IF NOT EXISTS idx_resumes_dedup ON resumes(job_id, dedup_key);

CREATE TABLE IF NOT EXISTS parse_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stop_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  result_path TEXT,
  error_json TEXT,
  fields_json TEXT,
  spans_json TEXT,
  anomalies_json TEXT,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  committed_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_parse_tasks_job ON parse_tasks(job_id, status);

CREATE TABLE IF NOT EXISTS eval_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stop_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  result_path TEXT,
  error_json TEXT,
  scores_json TEXT,
  total_score REAL,
  conclusion TEXT,
  evidence_refs_json TEXT,
  rationale_json TEXT,
  revision_of TEXT,
  feedback_json TEXT,
  tier TEXT,
  phase TEXT,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  committed_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_tasks_job ON eval_tasks(job_id, status);

CREATE TABLE IF NOT EXISTS review_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  eval_task_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stop_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  result_path TEXT,
  error_json TEXT,
  verdict TEXT,
  checks_json TEXT,
  compliance_json TEXT,
  required_fixes_json TEXT,
  escalation_reason TEXT,
  loop_count INTEGER NOT NULL DEFAULT 0,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  committed_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_tasks_job ON review_tasks(job_id, status);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  parse_task_id TEXT,
  field TEXT NOT NULL,
  quote TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  note TEXT,
  created_ts TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_unique ON evidence(resume_id, field, char_start, char_end);
CREATE INDEX IF NOT EXISTS idx_evidence_resume ON evidence(resume_id);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  job_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, seq);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  node TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  actor TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_job ON decisions(job_id);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_job ON usage(job_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 轻量向前迁移：老台账缺列时自动补齐，避免升级后必须清库。 */
function migrate(db: DatabaseSync): void {
  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
  const jobExisting = new Set(jobColumns.map((column) => column.name));
  if (!jobExisting.has('archived')) db.exec('ALTER TABLE jobs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!jobExisting.has('pinned')) db.exec('ALTER TABLE jobs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');

  const columns = db.prepare('PRAGMA table_info(eval_tasks)').all() as { name: string }[];
  const existing = new Set(columns.map((column) => column.name));
  if (!existing.has('tier')) db.exec('ALTER TABLE eval_tasks ADD COLUMN tier TEXT');
  if (!existing.has('phase')) db.exec('ALTER TABLE eval_tasks ADD COLUMN phase TEXT');
}
