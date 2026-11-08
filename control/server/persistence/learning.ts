import type Database from 'better-sqlite3';

export function createLearningTables(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS learning_accounts (
    tenant TEXT NOT NULL, provider TEXT NOT NULL, sealed TEXT NOT NULL,
    display_name TEXT NOT NULL, username TEXT NOT NULL, status TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,provider));
    CREATE TABLE IF NOT EXISTS learning_settings (
    tenant TEXT PRIMARY KEY, retention_days INTEGER NOT NULL DEFAULT 7,
    last_sync_at INTEGER);
    CREATE TABLE IF NOT EXISTS learning_downloads (
    tenant TEXT NOT NULL, key TEXT NOT NULL, published_at INTEGER NOT NULL,
    saved_at INTEGER NOT NULL, entry_id TEXT, object_id TEXT, state TEXT NOT NULL,
    PRIMARY KEY(tenant,key));
    CREATE TABLE IF NOT EXISTS document_progress (
    tenant TEXT NOT NULL, asset_id TEXT NOT NULL, page INTEGER NOT NULL,
    offset REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,asset_id));
    CREATE INDEX IF NOT EXISTS document_progress_recent ON document_progress(tenant,updated_at);`);
}
