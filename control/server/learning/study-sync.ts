import { createHash, randomUUID } from 'node:crypto';
import { errorHandling, retryDelay } from '../../shared/error-policy';
import {
  parseWireError,
  RemoteKitError,
  toRemoteKitError,
  wireError,
  type WireError,
} from '../../shared/errors';
import type { AttachmentSave, StudySync as SyncState } from '../../shared/learning';
import type { ObjectIndex } from '../cluster/objects';
import type { FileLibrary } from '../files/library';
import { reportError } from '../log';
import type { ControlDatabase } from '../persistence/database';
import type { LearningAccounts } from './accounts';
import { isDocument } from './document-type';
import type { DownloadItem, StudyService } from './study-service';

class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
interface DownloadRow {
  key: string;
  published_at: bigint;
  saved_at: bigint;
  entry_id: string | null;
  object_id: string | null;
  state: string;
  document: bigint;
  failure: string | null;
  retry_at: bigint | null;
  failed_usage: bigint | null;
}
type Objects = Pick<ObjectIndex, 'put' | 'render' | 'derived'>;
const DAY = 86400_000;
export class StudySync {
  private readonly slots = new Slots(4);
  private readonly tenants = new Map<
    string,
    {
      slots: Slots;
      downloads: Map<string, Promise<{ entryId: string }>>;
      progress: Map<string, AttachmentSave>;
      abort: AbortController;
      syncing?: Promise<void>;
      error?: WireError;
      due: number;
      diagnostic?: { startedAt: number; durationMs?: number; errorCode?: string };
    }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private readonly store: ControlDatabase,
    private readonly accounts: LearningAccounts,
    private readonly library: FileLibrary,
    private readonly objects: Objects,
    private readonly study: (tenant: string) => StudyService,
    private readonly changed: (tenant: string) => void,
    private readonly now = Date.now,
    private readonly random = Math.random,
  ) {}
  private runtime(tenant: string) {
    let runtime = this.tenants.get(tenant);
    if (!runtime) {
      runtime = {
        slots: new Slots(2),
        downloads: new Map(),
        progress: new Map(),
        abort: new AbortController(),
        due: this.now() + this.random() * 30_000,
      };
      this.tenants.set(tenant, runtime);
    }
    return runtime;
  }
  state(tenant: string): SyncState {
    const row = this.store.db.prepare('SELECT * FROM learning_settings WHERE tenant=?').get(tenant) as
      { retention_days: bigint; last_sync_at: bigint | null } | undefined;
    const runtime = this.tenants.get(tenant);
    return {
      attachmentFailures: (
        this.store.db
          .prepare(
            "SELECT key,failure FROM learning_downloads WHERE tenant=? AND state='failed' AND failure IS NOT NULL",
          )
          .all(tenant) as { key: string; failure: string }[]
      ).map((item) => ({ key: item.key, error: wireError(parseWireError(JSON.parse(item.failure))!) })),
      retentionDays: Number(row?.retention_days ?? 7),
      syncing: !!runtime?.syncing,
      ...(row?.last_sync_at ? { lastSyncAt: Number(row.last_sync_at) } : {}),
      ...(runtime?.error ? { error: runtime.error } : {}),
    };
  }
  private row(tenant: string, key: string) {
    return this.store.db
      .prepare('SELECT * FROM learning_downloads WHERE tenant=? AND key=?')
      .get(tenant, key) as DownloadRow | undefined;
  }
  saved(tenant: string, key: string): AttachmentSave {
    const progress = this.tenants.get(tenant)?.progress.get(key);
    if (progress) return progress;
    const row = this.row(tenant, key);
    if ((row?.state === 'saved' || row?.state === 'retained') && row.entry_id) {
      if (this.library.entryExists(tenant, row.entry_id)) return { state: 'saved', entryId: row.entry_id };
      if (row.state === 'saved') this.dismiss(tenant, [row.entry_id]);
    }
    return row?.state === 'failed'
      ? { state: 'failed', error: wireError(parseWireError(JSON.parse(row.failure!))!) }
      : { state: 'not_saved' };
  }
  dismiss(tenant: string, ids: string[]) {
    const update = this.store.db.prepare(
      "UPDATE learning_downloads SET state='dismissed' WHERE tenant=? AND entry_id=?",
    );
    for (const id of ids) update.run(tenant, id);
  }
  async retention(tenant: string) {
    const cutoff = this.now() - this.state(tenant).retentionDays * DAY;
    const rows = this.store.db
      .prepare(
        "SELECT * FROM learning_downloads WHERE tenant=? AND state='saved' AND max(published_at,saved_at)<?",
      )
      .all(tenant, cutoff) as DownloadRow[];
    for (const row of rows) {
      if (row.entry_id && !this.library.entryExists(tenant, row.entry_id)) {
        this.dismiss(tenant, [row.entry_id]);
        continue;
      }
      if (row.entry_id)
        await this.library.expireStudyEntry(
          tenant,
          row.entry_id,
          createHash('sha256')
            .update(JSON.stringify(['study-retention', row.key, row.saved_at.toString()]))
            .digest('hex'),
        );
      this.store.db
        .prepare("UPDATE learning_downloads SET state='retained' WHERE tenant=? AND key=? AND state='saved'")
        .run(tenant, row.key);
    }
  }
  async settings(tenant: string, days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 60)
      throw new RemoteKitError('invalid_request', '保留天数必须为 1–60');
    this.store.db
      .prepare(
        'INSERT INTO learning_settings(tenant,retention_days) VALUES (?,?) ON CONFLICT(tenant) DO UPDATE SET retention_days=excluded.retention_days',
      )
      .run(tenant, days);
    await this.retention(tenant);
    this.changed(tenant);
    return this.state(tenant);
  }
  save(tenant: string, key: string, automatic = false): Promise<{ entryId: string }> {
    if (this.closed) return Promise.reject(new RemoteKitError('unavailable', '服务正在关闭'));
    this.accounts.session(tenant, 'changyan');
    const runtime = this.runtime(tenant);
    const existing = runtime.downloads.get(key);
    if (existing) return existing;
    const task = runtime.slots.run(async () => {
      const status = this.saved(tenant, key);
      if (status.state === 'saved') {
        const row = this.row(tenant, key)!;
        if (row.document && row.object_id) this.render(row.object_id);
        return { entryId: status.entryId };
      }
      if (automatic && this.row(tenant, key)?.state === 'dismissed')
        throw new RemoteKitError('not_found', '文件已删除');
      const previous = this.row(tenant, key);
      if (automatic && previous?.state === 'failed' && !this.retryDue(tenant, previous))
        throw parseWireError(JSON.parse(previous.failure!))!;
      if (previous?.failure && parseWireError(JSON.parse(previous.failure))?.code === 'outcome_unknown') {
        const entry = previous.entry_id && this.library.entryExists(tenant, previous.entry_id);
        if (entry) {
          this.store.db
            .prepare(
              "UPDATE learning_downloads SET state='saved',failure=NULL,retry_at=NULL WHERE tenant=? AND key=?",
            )
            .run(tenant, key);
          return { entryId: previous.entry_id! };
        }
        if (
          !previous.object_id ||
          !this.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(previous.object_id)
        )
          throw new RemoteKitError('outcome_unknown', '附件导入结果待对账');
      }
      const item = await this.study(tenant).resolve(key);
      return this.download(tenant, item, runtime);
    });
    runtime.downloads.set(key, task);
    void task.finally(() => runtime.downloads.delete(key)).catch(() => {});
    return task;
  }
  private usage(tenant: string) {
    const row = this.store.db
      .prepare('SELECT coalesce(sum(size),0) AS bytes FROM library_entries WHERE tenant=?')
      .get(tenant) as { bytes: bigint };
    return Number(row?.bytes ?? 0);
  }
  private retryDue(tenant: string, row: DownloadRow) {
    if (!(row.failure ? (parseWireError(JSON.parse(row.failure))?.code ?? 'internal') : 'internal'))
      return false;
    if (
      (row.failure ? (parseWireError(JSON.parse(row.failure))?.code ?? 'internal') : 'internal') ===
      'limit_exceeded'
    )
      return row.failed_usage !== null && this.usage(tenant) < Number(row.failed_usage);
    if (
      errorHandling(
        row.failure ? (parseWireError(JSON.parse(row.failure))?.code ?? 'internal') : 'internal',
      ) === 'reconcile'
    )
      return true;
    return (
      retryDelay(
        { code: row.failure ? (parseWireError(JSON.parse(row.failure))?.code ?? 'internal') : 'internal' },
        0,
      ) !== undefined && Number(row.retry_at ?? 0) <= this.now()
    );
  }
  private async download(tenant: string, item: DownloadItem, runtime: ReturnType<StudySync['runtime']>) {
    const generation = this.accounts.generation(tenant, 'changyan');
    const authorize = () => {
      if (runtime.abort.signal.aborted || this.accounts.generation(tenant, 'changyan') !== generation)
        throw new RemoteKitError('forbidden', '学习账号已退出');
      this.accounts.session(tenant, 'changyan');
    };
    try {
      authorize();
      const previous = this.row(tenant, item.key);
      const recovered =
        previous?.failure &&
        parseWireError(JSON.parse(previous.failure))?.code === 'outcome_unknown' &&
        previous.object_id
          ? (this.store.db.prepare('SELECT id,size FROM objects WHERE id=?').get(previous.object_id) as
              { id: string; size: bigint } | undefined)
          : undefined;
      const download = recovered ? undefined : await this.study(tenant).download(item);
      runtime.progress.set(item.key, {
        state: 'downloading',
        received: 0,
        total: download?.size ?? item.sizeBytes,
      });
      this.changed(tenant);
      let received = 0;
      let prefix = Buffer.alloc(0);
      let pushedAt = this.now();
      const stream = async function* (changed: () => void, now: () => number) {
        for await (const chunk of download!.stream) {
          authorize();
          if (prefix.length < 4096)
            prefix = Buffer.concat([prefix, Buffer.from(chunk.subarray(0, 4096 - prefix.length))]);
          received += chunk.byteLength;
          runtime.progress.set(item.key, {
            state: 'downloading',
            received,
            total: download?.size ?? item.sizeBytes,
          });
          if (now() - pushedAt >= 250) {
            pushedAt = now();
            changed();
          }
          yield chunk;
        }
        authorize();
      };
      const entryId =
        previous?.state === 'failed' || previous?.state === 'pending'
          ? (previous.entry_id ?? randomUUID())
          : randomUUID();
      const rememberObject = (id: string) => {
        this.store.db
          .prepare(
            `INSERT INTO learning_downloads(tenant,key,published_at,saved_at,entry_id,object_id,state,failure) VALUES (?,?,?,0,?,?,'failed','{"code":"outcome_unknown","message":"附件导入结果待对账"}') ON CONFLICT(tenant,key) DO UPDATE SET entry_id=excluded.entry_id,object_id=excluded.object_id,state=excluded.state,failure=excluded.failure`,
          )
          .run(tenant, item.key, item.publishedAt, entryId, id);
      };
      const object = recovered
        ? { id: recovered.id, size: Number(recovered.size) }
        : await this.objects.put(
            tenant,
            stream(() => this.changed(tenant), this.now),
            { maxBytes: 256 * 1024 * 1024, signal: runtime.abort.signal, onIdentity: rememberObject },
          );
      authorize();
      const filename = attachmentName(item.name, item.extension);
      const document = isDocument(filename, prefix);
      this.store.db
        .prepare(
          `INSERT INTO learning_downloads(tenant,key,published_at,saved_at,entry_id,object_id,state,document) VALUES (?,?,?,0,?,?,'pending',?)
        ON CONFLICT(tenant,key) DO UPDATE SET entry_id=excluded.entry_id,object_id=excluded.object_id,document=excluded.document`,
        )
        .run(tenant, item.key, item.publishedAt, entryId, object.id, Number(document));
      // A put claim holds the object until the catalog transaction acquires its reference.
      await this.library.importFromControl(
        tenant,
        {
          operationId: createHash('sha256')
            .update(JSON.stringify(['study-import', tenant, item.key, entryId]))
            .digest('hex'),
          entryId,
          assetId: object.id,
          name: filename,
          type: mimeType(filename),
          size: object.size,
          source: { app: 'study', channel: item.subject },
          detail: item.detail.slice(0, 512),
        },
        authorize,
        () => {
          this.store.db
            .prepare(
              `INSERT INTO learning_downloads (tenant,key,published_at,saved_at,entry_id,object_id,state,document) VALUES (?,?,?,?,?,?,'saved',?)
          ON CONFLICT(tenant,key) DO UPDATE SET published_at=excluded.published_at,saved_at=excluded.saved_at,
          entry_id=excluded.entry_id,object_id=excluded.object_id,state='saved',document=excluded.document,failure=NULL,retry_at=NULL,failed_usage=NULL`,
            )
            .run(tenant, item.key, item.publishedAt, this.now(), entryId, object.id, Number(document));
        },
      );
      if (document) this.render(object.id);
      runtime.progress.delete(item.key);
      this.changed(tenant);
      return { entryId };
    } catch (error) {
      const failure = toRemoteKitError(error);
      if (!runtime.abort.signal.aborted && this.accounts.generation(tenant, 'changyan') === generation) {
        this.store.db
          .prepare(
            `INSERT INTO learning_downloads (tenant,key,published_at,saved_at,entry_id,object_id,state) VALUES (?,?,?,0,NULL,NULL,'failed')
          ON CONFLICT(tenant,key) DO UPDATE SET state='failed' WHERE state!='dismissed'`,
          )
          .run(tenant, item.key, item.publishedAt);
        const delay = retryDelay(failure, 0);
        this.store.db
          .prepare(
            'UPDATE learning_downloads SET failure=?,retry_at=?,failed_usage=? WHERE tenant=? AND key=?',
          )
          .run(
            JSON.stringify(
              wireError(reportError(failure, 'learning.attachment_failed', { tenant, key: item.key })),
            ),
            delay === undefined ? null : this.now() + Math.min(delay, 60_000),
            failure.code === 'limit_exceeded' ? this.usage(tenant) : null,
            tenant,
            item.key,
          );
        runtime.progress.set(item.key, { state: 'failed', error: wireError(failure) });
        this.changed(tenant);
      }
      throw error;
    }
  }
  private render(id: string) {
    if (!this.objects.derived(id, 'document')) this.objects.render(id);
  }
  sync(tenant: string) {
    this.accounts.session(tenant, 'changyan');
    const runtime = this.runtime(tenant);
    if (this.closed || runtime.syncing) return this.state(tenant);
    runtime.syncing = this.slots.run(async () => {
      const started = this.now();
      runtime.diagnostic = { startedAt: started };
      try {
        if (runtime.abort.signal.aborted) return;
        await this.retention(tenant);
        const items = await this.study(tenant).collect(this.now() - this.state(tenant).retentionDays * DAY);
        let errorCode: string | undefined;
        for (let index = 0; index < items.length; index += 2) {
          if (runtime.abort.signal.aborted) return;
          const selected = items.slice(index, index + 2).filter((item) => {
            const row = this.row(tenant, item.key);
            return row?.state !== 'dismissed' && (row?.state !== 'failed' || this.retryDue(tenant, row));
          });
          const results = await Promise.allSettled(selected.map((item) => this.save(tenant, item.key, true)));
          for (const result of results)
            if (result.status === 'rejected') errorCode = toRemoteKitError(result.reason).code;
        }
        if (runtime.abort.signal.aborted) return;
        this.store.db
          .prepare(
            'INSERT INTO learning_settings(tenant,last_sync_at) VALUES (?,?) ON CONFLICT(tenant) DO UPDATE SET last_sync_at=excluded.last_sync_at',
          )
          .run(tenant, this.now());
        runtime.error = undefined;
        runtime.diagnostic.errorCode = errorCode;
      } catch (error) {
        runtime.error = wireError(reportError(toRemoteKitError(error), 'learning.sync_failed', { tenant }));
        runtime.diagnostic.errorCode = toRemoteKitError(error).code;
      } finally {
        runtime.diagnostic.durationMs = this.now() - started;
        runtime.due =
          this.now() +
          (runtime.error &&
          ['busy', 'rate_limited', 'unavailable', 'outcome_unknown'].includes(runtime.error.code)
            ? 60_000
            : this.state(tenant).attachmentFailures?.some((item) =>
                  ['busy', 'rate_limited', 'unavailable', 'outcome_unknown'].includes(item.error.code),
                )
              ? 60_000
              : 30 * 60_000 + (this.random() - 0.5) * 180_000);
        delete runtime.syncing;
        if (!runtime.abort.signal.aborted) this.changed(tenant);
      }
    });
    this.changed(tenant);
    return this.state(tenant);
  }
  async idle(tenant: string) {
    const runtime = this.tenants.get(tenant);
    await runtime?.syncing;
    await Promise.allSettled([...(runtime?.downloads.values() ?? [])]);
  }
  start() {
    this.timer = setInterval(() => {
      for (const tenant of this.accounts.signedInTenants())
        if (this.runtime(tenant).due <= this.now()) this.sync(tenant);
    }, 15_000);
    this.timer.unref();
  }
  async stopTenant(tenant: string) {
    const runtime = this.tenants.get(tenant);
    runtime?.abort.abort();
    await this.idle(tenant);
    this.tenants.delete(tenant);
  }
  diagnostics(tenant: string) {
    return this.tenants.get(tenant)?.diagnostic;
  }
  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...this.tenants.keys()].map((tenant) => this.stopTenant(tenant)));
  }
}

function attachmentName(name: string, extension?: string) {
  let result =
    name
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
      .trim()
      .replace(/[ .]+$/, '') || '附件';
  const ext = extension?.replace(/^\./, '').toLowerCase();
  if (ext && /^[a-z0-9]{1,12}$/.test(ext) && !result.toLowerCase().endsWith('.' + ext)) result += '.' + ext;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(result)) result = '_' + result;
  if (result.length > 255) {
    const dot = result.lastIndexOf('.');
    const suffix = dot >= 0 && result.length - dot < 14 ? result.slice(dot) : '';
    result = result.slice(0, 255 - suffix.length) + suffix;
  }
  return result;
}
function mimeType(name: string) {
  const types: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    wps: 'application/vnd.ms-works',
    dps: 'application/vnd.ms-powerpoint',
    et: 'application/vnd.ms-excel',
    odt: 'application/vnd.oasis.opendocument.text',
    odp: 'application/vnd.oasis.opendocument.presentation',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    rtf: 'application/rtf',
    csv: 'text/csv',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    wav: 'audio/wav',
    zip: 'application/zip',
  };
  return types[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
}
