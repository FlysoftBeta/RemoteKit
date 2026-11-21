import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import { VIEWER_GENERATION_MAX } from '../../shared/occlusion-revision';
import { corruptState } from './codec';

/** Per-tenant counter behind the high half of every occlusion revision; it never wraps. */
export class ViewerGenerations {
  constructor(private readonly db: Database.Database) {}
  next(tenant: string): number {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT generation FROM viewer_generations WHERE tenant=?').get(tenant) as
        { generation: bigint } | undefined;
      const current = row ? Number(row.generation) : 0;
      if (current > VIEWER_GENERATION_MAX)
        throw corruptState('viewer_generations', new Error(`generation ${current} out of range`));
      if (current === VIEWER_GENERATION_MAX)
        throw new RemoteKitError('limit_exceeded', 'Viewer 接入次数已达上限', {
          detail: 'viewer generation exhausted',
        });
      this.db
        .prepare(
          'INSERT INTO viewer_generations(tenant,generation) VALUES (?,?) ON CONFLICT(tenant) DO UPDATE SET generation=excluded.generation',
        )
        .run(tenant, current + 1);
      return current + 1;
    })();
  }
  deleteTenant(tenant: string) {
    this.db.prepare('DELETE FROM viewer_generations WHERE tenant=?').run(tenant);
  }
}
