import { strictSqlite } from './sqlite';
import { CoordinationRepository } from './coordination';
import Sqlite from 'better-sqlite3';
import { ReclaimStatistics } from './reclaim-statistics';
import { AtRestKey } from '../auth/crypto';
import { systemClock, type Clock } from '../util/clock';
import { AccountsRepository } from './accounts';
import { AnnouncementsRepository } from './announcements';
import { ClipboardsRepository } from './clipboards';
import { LibraryRepository } from './library';
import { OperationsRepository } from './operations';
import { migrate } from './migrations';
import { dirname, join } from 'node:path';
import { checkIntegrity, type IntegrityResult } from './integrity';
import { SecurityRepository } from './security';
import { WorkspacesRepository } from './workspaces';
import { SessionImportsRepository } from './session-imports';
export interface DatabaseOptions {
  clock?: Clock;
  buildId: string;
}
export class ControlDatabase {
  readonly buildId: string;
  readonly coordination: CoordinationRepository;
  readonly reclaim: ReclaimStatistics;
  readonly integrity: IntegrityResult;
  readonly db: Sqlite.Database;
  readonly atRestKey: AtRestKey;
  readonly accounts: AccountsRepository;
  readonly security: SecurityRepository;
  readonly workspaces: WorkspacesRepository;
  readonly operations: OperationsRepository;
  readonly library: LibraryRepository;
  readonly sessionImports: SessionImportsRepository;
  readonly announcements: AnnouncementsRepository;
  readonly clipboards: ClipboardsRepository;
  constructor(path: string, options: DatabaseOptions) {
    this.buildId = options.buildId;
    const clock = options.clock ?? systemClock;
    this.db = new Sqlite(path);
    this.db.defaultSafeIntegers(true);
    strictSqlite(this.db);
    this.db.pragma('journal_mode = WAL');
    this.atRestKey = new AtRestKey(path && path !== ':memory:' ? path + '.key' : null);
    try {
      migrate(this.db, {
        backupDirectory: join(dirname(path), 'backups'),
        buildId: options.buildId,
        atRestKey: this.atRestKey,
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.coordination = new CoordinationRepository(this.db, this.atRestKey);
    this.reclaim = new ReclaimStatistics(this.db, clock);
    this.workspaces = new WorkspacesRepository(this.db);
    this.security = new SecurityRepository(this.db, this.atRestKey, clock);
    this.accounts = new AccountsRepository(this.db);
    this.operations = new OperationsRepository(this.db, this.workspaces);
    this.library = new LibraryRepository(this.db);
    this.sessionImports = new SessionImportsRepository(this.db, this.atRestKey, options.buildId);
    this.announcements = new AnnouncementsRepository(this.db);
    this.clipboards = new ClipboardsRepository(this.db, clock);
    try {
      this.integrity = checkIntegrity(this.db, this.atRestKey, clock.wallMs());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }
}
export function open(path: string, options: DatabaseOptions): ControlDatabase {
  return new ControlDatabase(path, options);
}

export function transaction<T>(db: Sqlite.Database, fn: () => T): T {
  return db.transaction(fn)();
}
