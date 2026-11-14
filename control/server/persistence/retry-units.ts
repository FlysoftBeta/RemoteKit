import { RetryUnit, type RetryUnitRecord } from '../../shared/retry-unit';
import type { ControlDatabase } from './database';
import { log, identifyError } from '../log';
import { decodeJson, corruptRecord } from './codec';
import { retryUnitRecord } from './documents';

/** Storage and logging for durable units; RetryUnit alone decides their transitions. */
export class RetryLedger {
  private readonly units = new Map<string, RetryUnit>();
  private readonly committed = new Map<string, RetryUnitRecord>();
  constructor(
    private readonly store: Pick<ControlDatabase, 'db'>,
    private readonly owner: string,
    private readonly now = () => Date.now(),
  ) {}

  unit(key: string) {
    let unit = this.units.get(key);
    if (unit) return unit;
    unit = new RetryUnit({
      now: this.now,
      failed: (error) => {
        identifyError(error);
        log.warn(`${this.owner}_failed`, { unit: key, code: error.code, errorId: error.errorId, err: error });
      },
      recovered: () => log.info(`${this.owner}_recovered`, { unit: key }),
    });
    const row = this.store.db
      .prepare('SELECT record FROM retry_units WHERE owner=? AND unit=?')
      .get(this.owner, key) as { record: string } | undefined;
    if (row) {
      const record = decodeJson(row.record, retryUnitRecord, `retry_units ${this.owner}/${key}`);
      if (
        (record.state.phase !== 'idle' && !record.error) ||
        (record.state.phase === 'waiting' && record.state.attempt !== record.attempts) ||
        (record.state.phase === 'faulted' &&
          (record.state.input !== record.input || record.state.code !== record.error?.code))
      )
        throw corruptRecord(`retry_units ${this.owner}/${key}`, new Error('Invalid retry state combination'));
      unit.restore(record);
    }

    this.units.set(key, unit);
    this.committed.set(key, unit.record());
    return unit;
  }

  failures() {
    return (
      this.store.db.prepare('SELECT unit,record FROM retry_units WHERE owner=?').all(this.owner) as {
        unit: string;
        record: string;
      }[]
    ).flatMap((row) => {
      const record = decodeJson(row.record, retryUnitRecord, `retry_units ${this.owner}/${row.unit}`);
      return record.error ? [{ key: row.unit, error: record.error }] : [];
    });
  }

  save(key: string, persist: () => void = () => undefined) {
    const unit = this.unit(key);
    const record = unit.record();
    try {
      this.store.db.transaction(() => {
        persist();
        this.store.db
          .prepare(
            'INSERT INTO retry_units VALUES (?,?,?) ON CONFLICT(owner,unit) DO UPDATE SET record=excluded.record',
          )
          .run(this.owner, key, JSON.stringify(record));
      })();
      this.committed.set(key, record);
    } catch (cause) {
      unit.restore(this.committed.get(key)!);
      throw cause;
    }
  }

  remove(key: string, persist: () => void = () => undefined) {
    this.store.db.transaction(() => {
      persist();
      this.store.db.prepare('DELETE FROM retry_units WHERE owner=? AND unit=?').run(this.owner, key);
    })();
    this.units.get(key)?.cancel();
    this.units.delete(key);
    this.committed.delete(key);
  }

  close() {
    for (const unit of this.units.values()) unit.close();
  }
}
