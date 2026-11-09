import type Database from 'better-sqlite3';
import { isDocument } from '../learning/document-type';

export function createObjectRenderTables(db: Database.Database) {
  db.exec(`CREATE TABLE object_render_failures (
    source_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state='failed'),
    reason TEXT NOT NULL, message TEXT NOT NULL, failed_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL, retry_at INTEGER, node_id TEXT);
    CREATE INDEX learning_downloads_object ON learning_downloads(object_id);
    ALTER TABLE learning_downloads ADD COLUMN document INTEGER NOT NULL DEFAULT 0;`);
  const update = db.prepare('UPDATE learning_downloads SET document=? WHERE tenant=? AND key=?');
  const entries = db
    .prepare(
      `SELECT d.tenant,d.key,json_extract(e.value,'$.name') AS name
    FROM learning_downloads d JOIN file_library l ON l.tenant=d.tenant,
    json_each(l.snapshot,'$.entries') e WHERE json_extract(e.value,'$.id')=d.entry_id`,
    )
    .all() as {
    tenant: string;
    key: string;
    name: string;
  }[];
  for (const entry of entries)
    update.run(Number(isDocument(entry.name, Buffer.alloc(0))), entry.tenant, entry.key);
}
