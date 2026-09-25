import { DatabaseSync } from "node:sqlite";

// Thin wrapper: node:sqlite is still experimental on Node 22, so all DB access
// goes through this module and can be swapped (e.g. for better-sqlite3) later.

export const SCHEMA_V1 = `
CREATE TABLE dish (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(title)) > 0),
  url TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE plan (
  id INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
) STRICT;

CREATE TABLE plan_entry (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  dish_id INTEGER NOT NULL REFERENCES dish(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  UNIQUE (plan_id, dish_id)
) STRICT;

CREATE INDEX plan_entry_plan ON plan_entry(plan_id, position);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

// One entry per schema version; PRAGMA user_version says how many are applied. Only ever append.
const MIGRATIONS = [
  SCHEMA_V1,
  // v2: preview image of a dish (file name in the image store, see images.ts)
  "ALTER TABLE dish ADD COLUMN image TEXT",
  // v3: free-form tags per dish (no tag table: the list of tags is simply the distinct values in use)
  `CREATE TABLE dish_tag (
    dish_id INTEGER NOT NULL REFERENCES dish(id) ON DELETE CASCADE,
    tag TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) > 0),
    PRIMARY KEY (dish_id, tag)
  ) STRICT;
  CREATE INDEX dish_tag_tag ON dish_tag(tag);`,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
