import Sqlite from 'better-sqlite3';
import { systemClock, type Clock } from '../util/clock';
import { AccountsRepository } from './accounts';
import { LibraryRepository } from './library';
import { OperationsRepository } from './operations';
import { createSchema } from './schema';
import { SecurityRepository } from './security';
import { WorkspacesRepository } from './workspaces';
export class ControlDatabase {
  readonly db: Sqlite.Database;
  readonly accounts: AccountsRepository;
  readonly security: SecurityRepository;
  readonly workspaces: WorkspacesRepository;
  readonly operations: OperationsRepository;
  readonly library: LibraryRepository;
  constructor(path: string, clock: Clock = systemClock) {
    this.db = new Sqlite(path);
    this.db.defaultSafeIntegers(true);
    this.db.pragma('journal_mode = WAL');
    createSchema(this.db);
    this.workspaces = new WorkspacesRepository(this.db);
    this.security = new SecurityRepository(this.db, path, clock);
    this.accounts = new AccountsRepository(this.db);
    this.operations = new OperationsRepository(this.db, this.workspaces);
    this.library = new LibraryRepository(this.db);
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
