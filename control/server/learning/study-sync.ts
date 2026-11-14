import { corruptRecord, decodeJson, encodeJson } from '../persistence/codec';
import { wireError as wireErrorCodec } from '../persistence/documents';
import { createHash, randomUUID } from 'node:crypto';
import { RetryLedger } from '../persistence/retry-units';
import { BackgroundJob } from '../background';
import { RemoteKitError, toRemoteKitError, wireError, type WireError } from '../../shared/errors';
import type { AttachmentSave, StudySync as SyncState } from '../../shared/learning';
import type { ObjectIndex } from '../cluster/objects';
import type { FileLibrary } from '../files/library';
import { reportError } from '../log';
import type { ControlDatabase } from '../persistence/database';
import type { LearningAccounts } from './accounts';
import { isDocument } from './document-type';
import type { DownloadItem, StudyService } from './study-service';

function storedFailure(text: string | null, tenant: string, key: string): RemoteKitError {
  const value = decodeJson(text as string, wireErrorCodec, `learning_downloads.failure ${tenant}/${key}`);
  return new RemoteKitError(value.code, value.message, value);
}

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
  failures() {
    return [
      this.dispatchJob.retry.error,
      ...[...this.dispatchers.values()].map((job) => job.retry.error),
    ].filter((error) => error !== undefined);
  }
  private readonly dispatchJob = new BackgroundJob('learning.dispatch', {});
  private readonly dispatchers = new Map<string, BackgroundJob>();
  private readonly slots = new Slots(4);
  private readonly collections: RetryLedger;
  private readonly attachments: RetryLedger;
  private readonly retentions: RetryLedger;
  private readonly manualInputs = new Map<string, number>();
  private readonly collectionCutoffs = new Map<string, { input: string; cutoff: number }>();
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
  ) {
    this.collections = new RetryLedger(store, 'learning.collection', now);
    this.attachments = new RetryLedger(store, 'learning.attachment', now);
    this.retentions = new RetryLedger(store, 'learning.retention', now);
  }
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
    if (!row) throw corruptRecord(`learning_settings ${tenant}`, new Error('missing required record'));
    const runtime = this.tenants.get(tenant);
    return {
      attachmentFailures: [
        ...(
          this.store.db
            .prepare(
              "SELECT key,failure FROM learning_downloads WHERE tenant=? AND state IN ('failed','unknown') AND failure IS NOT NULL",
            )
            .all(tenant) as { key: string; failure: string }[]
        ).map((item) => ({ key: item.key, error: wireError(storedFailure(item.failure, tenant, item.key)) })),
        ...this.retentions.failures().flatMap((item) => {
          const [owner, key] = JSON.parse(item.key) as string[];
          return owner === tenant ? [{ key: key!, error: item.error }] : [];
        }),
      ],
      retentionDays: Number(row.retention_days),
      syncing: !!runtime?.syncing,
      ...(row?.last_sync_at ? { lastSyncAt: Number(row.last_sync_at) } : {}),
      ...((runtime?.error ?? this.collections.unit(tenant).record().error)
        ? { error: runtime?.error ?? this.collections.unit(tenant).record().error }
        : {}),
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
    return row && ['failed', 'unknown'].includes(row.state)
      ? {
          state: row.state === 'unknown' ? 'unknown' : 'failed',
          error: wireError(storedFailure(row.failure, tenant, row.key)),
        }
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
      const key = JSON.stringify([tenant, row.key, row.saved_at.toString()]);
      const unit = this.retentions.unit(key);
      if (!unit.ready(JSON.stringify([this.store.buildId, this.state(tenant).retentionDays]))) continue;
      try {
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
          .prepare(
            "UPDATE learning_downloads SET state='retained' WHERE tenant=? AND key=? AND state='saved'",
          )
          .run(tenant, row.key);
        unit.succeed();
        this.retentions.remove(key);
      } catch (cause) {
        unit.fail(cause);
        this.retentions.save(key);
      }
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
    const task = runtime.slots
      .run(async () => {
        const status = this.saved(tenant, key);
        if (status.state === 'saved') {
          const row = this.row(tenant, key)!;
          if (row.document && row.object_id) this.render(row.object_id);
          return { entryId: status.entryId };
        }
        if (automatic && this.row(tenant, key)?.state === 'dismissed')
          throw new RemoteKitError('not_found', '文件已删除');
        const previous = this.row(tenant, key);
        const unit = this.attachments.unit(JSON.stringify([tenant, key]));
        if (!automatic)
          this.manualInputs.set(
            JSON.stringify([tenant, key]),
            (this.manualInputs.get(JSON.stringify([tenant, key])) ?? 0) + 1,
          );
        if (!unit.ready(this.attachmentInput(tenant, key))) throw unit.error;
        if (
          previous?.failure &&
          storedFailure(previous.failure, tenant, previous.key).code === 'outcome_unknown'
        ) {
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
            previous.object_id &&
            !this.store.db.prepare('SELECT 1 FROM objects WHERE id=?').get(previous.object_id)
          )
            throw new RemoteKitError('outcome_unknown', '附件导入结果待对账');
        }
        const item = await this.study(tenant).resolve(key);
        const result = await this.download(tenant, item, runtime);
        unit.succeed();
        this.attachments.remove(JSON.stringify([tenant, key]));
        return result;
      })
      .catch((cause) => {
        if (
          !runtime.abort.signal.aborted &&
          this.attachments.unit(JSON.stringify([tenant, key])).error !== cause
        )
          this.failAttachment(tenant, key, cause, runtime);
        throw cause;
      });
    runtime.downloads.set(key, task);
    void task.then(
      () => runtime.downloads.delete(key),
      () => runtime.downloads.delete(key),
    );
    return task;
  }
  private usage(tenant: string) {
    const row = this.store.db
      .prepare('SELECT coalesce(sum(size),0) AS bytes FROM library_entries WHERE tenant=?')
      .get(tenant) as { bytes: bigint };
    return Number(row?.bytes ?? 0);
  }
  private attachmentInput(tenant: string, key: string) {
    return JSON.stringify([
      this.store.buildId,
      this.accounts.generation(tenant, 'changyan'),
      this.usage(tenant),
      this.manualInputs.get(JSON.stringify([tenant, key])) ?? 0,
    ]);
  }
  private retryDue(tenant: string, row: DownloadRow) {
    return this.attachments
      .unit(JSON.stringify([tenant, row.key]))
      .ready(this.attachmentInput(tenant, row.key));
  }
  private failAttachment(
    tenant: string,
    key: string,
    cause: unknown,
    runtime: ReturnType<StudySync['runtime']>,
  ) {
    const unitKey = JSON.stringify([tenant, key]);
    const unit = this.attachments.unit(unitKey);
    unit.ready(this.attachmentInput(tenant, key));
    const original = toRemoteKitError(cause);
    const existing = this.row(tenant, key);
    const unknown =
      original.code === 'outcome_unknown' || (original.code === 'internal' && !!existing?.object_id);
    const failure = unit.fail(original).error;
    const retryAt = unit.state.phase === 'waiting' ? unit.state.until : null;
    this.attachments.save(unitKey, () => {
      this.store.db
        .prepare(
          `INSERT INTO learning_downloads(tenant,key,published_at,saved_at,state) VALUES (?,?,0,0,?) ON CONFLICT(tenant,key) DO UPDATE SET state=excluded.state WHERE state!='dismissed'`,
        )
        .run(tenant, key, unknown ? 'unknown' : 'failed');
      this.store.db
        .prepare('UPDATE learning_downloads SET failure=?,retry_at=?,failed_usage=? WHERE tenant=? AND key=?')
        .run(
          encodeJson(wireError(failure), wireErrorCodec, `learning_downloads.failure ${tenant}/${key}`),
          retryAt,
          failure.code === 'limit_exceeded' ? this.usage(tenant) : null,
          tenant,
          key,
        );
    });
    runtime.progress.set(key, {
      state: unknown ? 'unknown' : 'failed',
      error: wireError(failure),
    });
    this.changed(tenant);
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
        storedFailure(previous.failure, tenant, previous.key).code === 'outcome_unknown' &&
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
        previous && ['failed', 'unknown', 'pending'].includes(previous.state)
          ? (previous.entry_id ?? randomUUID())
          : randomUUID();
      const rememberObject = (id: string) => {
        this.store.db
          .prepare(
            `INSERT INTO learning_downloads(tenant,key,published_at,saved_at,entry_id,object_id,state,failure) VALUES (?,?,?,0,?,?,'unknown','{"code":"outcome_unknown","message":"附件导入结果待对账"}') ON CONFLICT(tenant,key) DO UPDATE SET entry_id=excluded.entry_id,object_id=excluded.object_id,state=excluded.state,failure=excluded.failure`,
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
      throw error;
    }
  }

  private render(id: string) {
    if (!this.objects.derived(id, 'document')) this.objects.render(id);
  }
  sync(tenant: string, automatic = false) {
    this.accounts.session(tenant, 'changyan');
    const runtime = this.runtime(tenant);
    if (this.closed || runtime.syncing) return this.state(tenant);
    if (!automatic) this.manualInputs.set(tenant, (this.manualInputs.get(tenant) ?? 0) + 1);
    const unit = this.collections.unit(tenant);
    const input = this.collectionInput(tenant);
    if (!unit.ready(input)) return this.state(tenant);
    if (this.collectionCutoffs.get(tenant)?.input !== input || unit.error?.code === 'conflict')
      this.collectionCutoffs.set(tenant, {
        input,
        cutoff: this.now() - this.state(tenant).retentionDays * DAY,
      });
    const cutoff = this.collectionCutoffs.get(tenant)!.cutoff;
    runtime.syncing = this.slots.run(async () => {
      const started = this.now();
      runtime.diagnostic = { startedAt: started };
      try {
        if (runtime.abort.signal.aborted) return;
        await this.retention(tenant);
        const items = await this.study(tenant).collect(cutoff);
        let errorCode: string | undefined;
        for (let index = 0; index < items.length; index += 2) {
          if (runtime.abort.signal.aborted) return;
          const selected = items.slice(index, index + 2).filter((item) => {
            const row = this.row(tenant, item.key);
            return (
              row?.state !== 'dismissed' &&
              (!row || !['failed', 'unknown'].includes(row.state) || this.retryDue(tenant, row))
            );
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
        unit.succeed();
        this.collections.save(tenant);
        this.collectionCutoffs.delete(tenant);
        runtime.error = undefined;
        runtime.diagnostic.errorCode = errorCode;
      } catch (error) {
        runtime.error = wireError(unit.fail(toRemoteKitError(error)).error);
        this.collections.save(tenant);
        runtime.diagnostic.errorCode = toRemoteKitError(error).code;
      } finally {
        runtime.diagnostic.durationMs = this.now() - started;
        runtime.due =
          unit.state.phase === 'waiting'
            ? unit.state.until
            : unit.state.phase === 'idle'
              ? this.now() + 30 * 60_000 + (this.random() - 0.5) * 180_000
              : Infinity;
        const pending = this.store.db
          .prepare(
            'SELECT min(retry_at) AS due FROM learning_downloads WHERE tenant=? AND retry_at IS NOT NULL',
          )
          .get(tenant) as { due: bigint | null };
        if (pending.due !== null && unit.state.phase === 'idle')
          runtime.due = Math.min(runtime.due, Number(pending.due));
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
  private collectionInput(tenant: string) {
    return JSON.stringify([
      this.store.buildId,
      this.accounts.generation(tenant, 'changyan'),
      this.accounts.state(tenant, 'changyan'),
      this.state(tenant).retentionDays,
      this.usage(tenant),
      this.manualInputs.get(tenant) ?? 0,
    ]);
  }
  start() {
    this.timer = setInterval(() => {
      void this.dispatchJob.run(() => this.dispatch(), this.store.buildId);
    }, 15_000);
    this.timer.unref();
  }
  private async dispatch() {
    await Promise.all(
      this.accounts.signedInTenants().map(async (tenant) => {
        let job = this.dispatchers.get(tenant);
        if (!job) {
          job = new BackgroundJob('learning.tenant_dispatch', { tenant });
          this.dispatchers.set(tenant, job);
        }
        await job.run(
          async () => {
            if (this.closed) return;
            if (
              this.runtime(tenant).due <= this.now() ||
              this.collections.unit(tenant).record().input !== this.collectionInput(tenant)
            ) {
              this.sync(tenant, true);
              await this.runtime(tenant).syncing;
            }
          },
          JSON.stringify([this.store.buildId, this.accounts.generation(tenant, 'changyan')]),
        );
        if (job.retry.error) {
          this.runtime(tenant).error = wireError(job.retry.error);
          this.changed(tenant);
        }
      }),
    );
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
    await this.dispatchJob.close();
    await Promise.all([...this.dispatchers.values()].map((job) => job.close()));
    this.collections.close();
    this.attachments.close();
    this.retentions.close();
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
