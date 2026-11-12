import type Database from 'better-sqlite3';

export function createLearningSettings(db: Database.Database, tenant: string): void {
  db.prepare('INSERT INTO learning_settings(tenant,retention_days) VALUES (?,7)').run(tenant);
}
