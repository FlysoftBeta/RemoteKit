import type Database from 'better-sqlite3';
import type { Announcement } from '../../shared/product';

export interface StoredAnnouncement {
  id: string;
  title: string;
  body: string;
  publishedAt: number;
  updatedAt: number;
  reads: number;
}
interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  published_at: bigint;
  updated_at: bigint;
}

export function createAnnouncementTables(db: Database.Database) {
  db.exec(`CREATE TABLE announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE announcement_reads (
      announcement_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(announcement_id,user_id));
    CREATE INDEX announcement_reads_user ON announcement_reads(user_id);`);
}

// A read covers one publication: republishing clears the reads so everyone sees it again.
export class AnnouncementsRepository {
  constructor(private readonly db: Database.Database) {}
  list(): StoredAnnouncement[] {
    const rows = this.db
      .prepare(
        `SELECT a.id,a.title,a.body,a.published_at,a.updated_at,
           (SELECT COUNT(*) FROM announcement_reads r JOIN users u ON u.id=r.user_id
             WHERE r.announcement_id=a.id AND u.disabled_at IS NULL) AS reads
         FROM announcements a ORDER BY a.published_at DESC, a.id`,
      )
      .all() as (AnnouncementRow & { reads: bigint })[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      publishedAt: Number(row.published_at),
      updatedAt: Number(row.updated_at),
      reads: Number(row.reads),
    }));
  }
  forUser(userId: string): Announcement[] {
    const rows = this.db
      .prepare(
        `SELECT a.id,a.title,a.body,a.published_at,r.user_id IS NOT NULL AS read
         FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=?
         ORDER BY a.published_at DESC, a.id`,
      )
      .all(userId) as (Omit<AnnouncementRow, 'updated_at'> & { read: bigint })[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      publishedAt: Number(row.published_at),
      read: !!row.read,
    }));
  }
  exists(id: string) {
    return !!this.db.prepare('SELECT 1 FROM announcements WHERE id=?').get(id);
  }
  insert(id: string, title: string, body: string, at: number) {
    this.db.prepare('INSERT INTO announcements VALUES (?,?,?,?,?)').run(id, title, body, at, at);
  }
  update(id: string, title: string, body: string, at: number, republish: boolean) {
    if (republish) {
      this.db
        .prepare('UPDATE announcements SET title=?,body=?,published_at=?,updated_at=? WHERE id=?')
        .run(title, body, at, at, id);
      this.db.prepare('DELETE FROM announcement_reads WHERE announcement_id=?').run(id);
    } else
      this.db
        .prepare('UPDATE announcements SET title=?,body=?,updated_at=? WHERE id=?')
        .run(title, body, at, id);
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM announcement_reads WHERE announcement_id=?').run(id);
    this.db.prepare('DELETE FROM announcements WHERE id=?').run(id);
  }
  markRead(id: string, userId: string) {
    return (
      this.db.prepare('INSERT OR IGNORE INTO announcement_reads VALUES (?,?)').run(id, userId).changes > 0
    );
  }
  deleteUser(userId: string) {
    this.db.prepare('DELETE FROM announcement_reads WHERE user_id=?').run(userId);
  }
}
