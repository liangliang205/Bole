export const SKILL_SCHEMA = `CREATE TABLE IF NOT EXISTS skill_plugins (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, definition_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);`;
