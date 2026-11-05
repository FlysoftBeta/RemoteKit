import { transaction } from './database';
import type Database from 'better-sqlite3';
import { RemoteKitError } from '../../shared/errors';
import { randomUUID } from 'node:crypto';
import type { ProductWorkspace, OperationReceipt } from '../../shared/product';
import type { WorkspacesRepository } from './workspaces';

export class OperationsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaces: WorkspacesRepository,
  ) {
    // A process restart cannot prove whether an in-flight native side effect ran.
    for (const row of this.db.prepare('SELECT tenant,id,receipt FROM operation_receipts').all() as {
      tenant: string;
      id: string;
      receipt: string;
    }[]) {
      const receipt = JSON.parse(row.receipt);
      if (['accepted', 'applying'].includes(receipt.status)) {
        receipt.status = 'unknown';
        receipt.error = 'Control重启，执行结果待对账';
        this.db
          .prepare('UPDATE operation_receipts SET receipt=? WHERE tenant=? AND id=?')
          .run(JSON.stringify(receipt), row.tenant, row.id);
      }
    }
  }
  popupTabId(tenant: string, provisionalId: string): string | undefined {
    return (
      this.db
        .prepare('SELECT tab_id FROM popup_receipts WHERE tenant=? AND provisional_id=?')
        .get(tenant, provisionalId) as { tab_id: string } | undefined
    )?.tab_id;
  }
  savePopupWorkspace(state: ProductWorkspace, provisionalId: string, tabId: string) {
    transaction(this.db, () => {
      this.workspaces.saveWorkspace(state);
      this.db
        .prepare('INSERT INTO popup_receipts VALUES (?,?,?,?)')
        .run(state.tenantId, provisionalId, tabId, Date.now());
    });
  }
  prunePopupReceipts(tenant: string) {
    this.db
      .prepare(
        'DELETE FROM popup_receipts WHERE tenant=? AND created_at<? AND tab_id NOT IN (SELECT id FROM workspace_tabs WHERE tenant=?)',
      )
      .run(tenant, Date.now() - 120000, tenant);
  }
  operationGeneration(tenant: string): string {
    let row = this.db.prepare('SELECT generation FROM operation_generations WHERE tenant=?').get(tenant) as
      { generation: string } | undefined;
    if (!row) {
      row = { generation: randomUUID() };
      this.db.prepare('INSERT INTO operation_generations VALUES (?,?)').run(tenant, row.generation);
    }
    return row.generation;
  }
  operation(tenant: string, id: string): { payload: string; receipt: OperationReceipt } | undefined {
    const row = this.db
      .prepare('SELECT payload,receipt FROM operation_receipts WHERE tenant=? AND id=?')
      .get(tenant, id) as { payload: string; receipt: string } | undefined;
    return row && { payload: row.payload, receipt: JSON.parse(row.receipt) };
  }
  recentOperations(tenant: string): OperationReceipt[] {
    return (
      this.db
        .prepare('SELECT receipt FROM operation_receipts WHERE tenant=? ORDER BY rowid DESC LIMIT 64')
        .all(tenant) as { receipt: string }[]
    ).map((row) => JSON.parse(row.receipt));
  }
  pendingOperations(tenant: string): { action: any; receipt: OperationReceipt }[] {
    return (
      this.db
        .prepare(
          "SELECT payload,receipt FROM operation_receipts WHERE tenant=? AND json_extract(receipt,'$.status') IN ('accepted','applying','unknown')",
        )
        .all(tenant) as { payload: string; receipt: string }[]
    )
      .map((row) => ({ action: JSON.parse(row.payload), receipt: JSON.parse(row.receipt) }))
      .filter((item) => ['accepted', 'applying', 'unknown'].includes(item.receipt.status));
  }
  reserveOperation(tenant: string, payload: string, receipt: OperationReceipt): boolean {
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM operation_receipts WHERE tenant=?')
      .get(tenant) as { count: bigint };
    if (count.count >= 4096n) {
      const unresolved = (
        this.db.prepare('SELECT receipt FROM operation_receipts WHERE tenant=?').all(tenant) as {
          receipt: string;
        }[]
      ).some((row) => {
        const receipt = JSON.parse(row.receipt);
        return (
          ['accepted', 'applying'].includes(receipt.status) ||
          (receipt.status === 'unknown' && !receipt.resolved)
        );
      });
      if (unresolved) throw new RemoteKitError('limit_exceeded', '操作收据已满，请先核对未确认的操作');
      // Rotate only between operations. Old generations always receive expired.
      transaction(this.db, () => {
        this.db.prepare('DELETE FROM operation_receipts WHERE tenant=?').run(tenant);
        this.db
          .prepare('UPDATE operation_generations SET generation=? WHERE tenant=?')
          .run(randomUUID(), tenant);
      });
      return false;
    }
    transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT sequence FROM operation_sequences WHERE tenant=?')
        .get(tenant) as { sequence: string } | undefined;
      const sequence = BigInt(previous?.sequence ?? '0') + 1n;
      if (sequence > 18446744073709551615n) throw new RemoteKitError('limit_exceeded', '操作序号已耗尽');
      receipt.operationSequence = sequence.toString();
      this.db
        .prepare('INSERT OR REPLACE INTO operation_sequences VALUES (?,?)')
        .run(tenant, receipt.operationSequence);
      this.db
        .prepare('INSERT INTO operation_receipts VALUES (?,?,?,?)')
        .run(tenant, receipt.operationId, payload, JSON.stringify(receipt));
    });
    return true;
  }
  saveOperation(state: ProductWorkspace, receipt: OperationReceipt) {
    transaction(this.db, () => {
      this.workspaces.saveWorkspace(state);
      receipt.revision = state.revision;
      this.db
        .prepare('UPDATE operation_receipts SET receipt=? WHERE tenant=? AND id=?')
        .run(JSON.stringify(receipt), state.tenantId, receipt.operationId);
    });
  }
}
