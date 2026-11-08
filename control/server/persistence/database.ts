import Sqlite from 'better-sqlite3';
import { AtRestKey } from '../auth/crypto';
import { systemClock, type Clock } from '../util/clock';
import { AccountsRepository } from './accounts';
import { AnnouncementsRepository } from './announcements';
import { LibraryRepository } from './library';
import { OperationsRepository } from './operations';
import { createSchema } from './schema';
import { SecurityRepository } from './security';
import { WorkspacesRepository } from './workspaces';
import { SessionImportsRepository } from './session-imports';
export class ControlDatabase {
  readonly db: Sqlite.Database;
  readonly atRestKey: AtRestKey;
  readonly accounts: AccountsRepository;
  readonly security: SecurityRepository;
  readonly workspaces: WorkspacesRepository;
  readonly operations: OperationsRepository;
  readonly library: LibraryRepository;
  readonly sessionImports: SessionImportsRepository;
  readonly announcements: AnnouncementsRepository;
  constructor(path: string, clock: Clock = systemClock) {
    this.db = new Sqlite(path);
    this.db.defaultSafeIntegers(true);
    this.db.pragma('journal_mode = WAL');
    try {
      createSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.workspaces = new WorkspacesRepository(this.db);
    this.atRestKey = new AtRestKey(path && path !== ':memory:' ? path + '.key' : null);
    this.security = new SecurityRepository(this.db, this.atRestKey, clock);
    this.accounts = new AccountsRepository(this.db);
    this.operations = new OperationsRepository(this.db, this.workspaces);
    this.library = new LibraryRepository(this.db);
    this.sessionImports = new SessionImportsRepository(this.db, this.atRestKey);
    this.announcements = new AnnouncementsRepository(this.db);
  }
  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }
}
export function open(path: string, clock: Clock = systemClock): ControlDatabase {
  return new ControlDatabase(path, clock);
}

export function transaction<T>(db: Sqlite.Database, fn: () => T): T {
  return db.transaction(fn)();
}
