import { decodeJson, encodeJson, type Codec } from './codec';
import * as codecs from './documents';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { OperationReceipt, ProductWorkspace } from '../../shared/product';
import { settle } from '../workspace/operations';
import { transaction } from './database';
import type { WorkspacesRepository } from './workspaces';
import type { RecordedAction } from '../../shared/recorded-action';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function operationPayload(value: RecordedAction, where: string): string {
  const codec: Codec<RecordedAction> = {
    read(value, path) {
      return canonical(codecs.action.read(value, path)) as RecordedAction;
    },
  };
  return encodeJson(value, codec, where);
}

export class OperationsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaces: WorkspacesRepository,
  ) {
    for (const row of this.db.prepare('SELECT tenant,id FROM operation_receipts').all() as {
      tenant: string;
      id: string;
    }[])
      this.restarted.add(`${row.tenant}/${row.id}`);
  }
  private readonly restarted = new Set<string>();
  private decodeReceipt(text: string, tenant: string, id = ''): OperationReceipt {
    const value = decodeJson(text, codecs.receipt, `operation_receipts.receipt ${tenant}/${id}`);
    const key = `${tenant}/${value.operationId}`;
    if (this.restarted.has(key)) {
      if (value.status === 'accepted' || value.status === 'applying') {
        settle(value, { status: 'unknown' });
        value.error = { code: 'outcome_unknown', message: 'Control重启，执行结果待对账' };
      }
    }
    return value;
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
  operation(
    tenant: string,
    id: string,
  ):
    | {
        payload: string;
        receipt: OperationReceipt;
        action: import('../../shared/recorded-action').RecordedAction;
      }
    | undefined {
    const row = this.db
      .prepare('SELECT payload,receipt FROM operation_receipts WHERE tenant=? AND id=?')
      .get(tenant, id) as { payload: string; receipt: string } | undefined;
    return (
      row && {
        payload: row.payload,
        receipt: this.decodeReceipt(row.receipt, tenant, id),
        action: decodeJson(row.payload, codecs.action, `operation_receipts.payload ${tenant}/${id}`),
      }
    );
  }
  recentOperations(tenant: string): OperationReceipt[] {
    return (
      this.db
        .prepare('SELECT id,receipt FROM operation_receipts WHERE tenant=? ORDER BY rowid DESC LIMIT 64')
        .all(tenant) as { id: string; receipt: string }[]
    ).map((row) => this.decodeReceipt(row.receipt, tenant, row.id));
  }
  pendingOperations(tenant: string): { action: any; receipt: OperationReceipt }[] {
    return (
      this.db.prepare('SELECT id,payload,receipt FROM operation_receipts WHERE tenant=?').all(tenant) as {
        id: string;
        payload: string;
        receipt: string;
      }[]
    )
      .map((row) => ({
        action: decodeJson(row.payload, codecs.action, `operation_receipts.payload ${tenant}/${row.id}`),
        receipt: this.decodeReceipt(row.receipt, tenant, row.id),
      }))
      .filter((item) => ['accepted', 'applying', 'unknown'].includes(item.receipt.status));
  }
  reserveOperation(tenant: string, action: RecordedAction, receipt: OperationReceipt): boolean {
    const payload = operationPayload(action, `operation_receipts.payload ${tenant}/${receipt.operationId}`);
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM operation_receipts WHERE tenant=?')
      .get(tenant) as { count: bigint };
    if (count.count >= 4096n) {
      const unresolved = (
        this.db.prepare('SELECT id,receipt FROM operation_receipts WHERE tenant=?').all(tenant) as {
          id: string;
          receipt: string;
        }[]
      ).some((row) => {
        const receipt = this.decodeReceipt(row.receipt, tenant, row.id);
        return (
          ['accepted', 'applying'].includes(receipt.status) ||
          (receipt.status === 'unknown' && !receipt.resolved)
        );
      });
      if (unresolved) throw new RemoteKitError('conflict', '操作收据已满，请先核对未确认的操作');
      // Rotate only between operations. Old generations require a workspace refresh.
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
        .run(
          tenant,
          receipt.operationId,
          payload,
          encodeJson(receipt, codecs.receipt, `operation_receipts.receipt ${receipt.operationId}`),
        );
    });
    return true;
  }
  saveOperation(state: ProductWorkspace, receipt: OperationReceipt) {
    transaction(this.db, () => {
      this.workspaces.saveWorkspace(state);
      receipt.revision = state.revision;
      this.db
        .prepare('UPDATE operation_receipts SET receipt=? WHERE tenant=? AND id=?')
        .run(
          encodeJson(receipt, codecs.receipt, `operation_receipts.receipt ${receipt.operationId}`),
          state.tenantId,
          receipt.operationId,
        );
    });
    this.restarted.delete(`${state.tenantId}/${receipt.operationId}`);
  }
  deleteTenant(tenant: string) {
    this.db.prepare('DELETE FROM operation_sequences WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM operation_generations WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM operation_receipts WHERE tenant=?').run(tenant);
    this.db.prepare('DELETE FROM popup_receipts WHERE tenant=?').run(tenant);
  }
}
