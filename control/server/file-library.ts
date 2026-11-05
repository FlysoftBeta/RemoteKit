import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Asset,
  LibraryEntry,
  LibraryMethods,
  LibrarySnapshot,
  PhotoMetadata,
  SelectionState,
} from '../shared/file-library';
import type { Endpoint } from './endpoint';
import {
  FileUploadError,
  type FileBinding,
  type InternalFileRequest,
  type UploadLimits,
} from './file-uploads';

type LibraryMethod = keyof LibraryMethods;
type Params<K extends LibraryMethod> = LibraryMethods[K]['params'];
type TerminalState = Extract<SelectionState, 'selected' | 'cancelled'>;
interface Selection {
  selectionId: string;
  requestId: string;
  binding: FileBinding;
  entryIds: string[];
  groupId: string | null;
  files: Pick<LibraryEntry, 'assetId' | 'name' | 'type'>[];
  prepared: boolean;
}
const MAX_BASKET = 64;
const MAX_CATALOG = 4096;
const MAX_GROUPS = 256;
const RECONCILE_BATCH = 8;
const operationHash = (...fields: unknown[]) =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const invalid = (message: string) => new FileUploadError(400, message);

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid('无效的文件库标识');
  return value;
}
function ids(value: unknown, max: number, min = 0): string[] {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > max ||
    new Set(value).size !== value.length
  )
    throw invalid('无效的文件数量或重复文件');
  return value.map(id);
}
function photoMetadata(value: unknown): PhotoMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw invalid('无效的照片信息');
  const { mode, pending, warning, candidateAssetIds } = value as Partial<PhotoMetadata>;
  if (mode !== 'photo' && mode !== 'scan') throw invalid('无效的拍摄模式');
  if (pending !== undefined && pending !== 'choice' && pending !== 'scan-error')
    throw invalid('无效的照片状态');
  if (warning !== undefined && (typeof warning !== 'string' || warning.length > 256))
    throw invalid('无效的照片警告');
  return {
    mode,
    ...(candidateAssetIds !== undefined ? { candidateAssetIds: ids(candidateAssetIds, 2) } : {}),
    ...(pending !== undefined ? { pending } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}
function assetIds({
  assetId,
  originalAssetId,
  photo,
}: Pick<LibraryEntry, 'assetId' | 'originalAssetId' | 'photo'>): string[] {
  return [
    ...new Set([assetId, ...(originalAssetId ? [originalAssetId] : []), ...(photo?.candidateAssetIds ?? [])]),
  ];
}
function fileName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 255 ||
    /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) ||
    /[ .]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
  )
    throw invalid('无效的文件名');
  return value;
}
function groupName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value))
    throw invalid('无效的分组名');
  return value.trim();
}
function group(snapshot: LibrarySnapshot, value: unknown): string | null {
  if (value === null) return null;
  const groupId = id(value);
  if (!snapshot.groups.some((item) => item.id === groupId)) throw new FileUploadError(404, '分组不存在');
  return groupId;
}
function entries(snapshot: LibrarySnapshot, entryIds: string[]) {
  const catalog = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  return entryIds.map((entryId) => {
    const entry = catalog.get(entryId);
    if (!entry) throw new FileUploadError(404, '文件不存在');
    return entry;
  });
}

/** Catalog and native selection bookkeeping. Files themselves stay on the Endpoint. */
export class FileLibrary {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private db: Database.Database,
    private endpoint: Endpoint,
    private limits: UploadLimits,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS file_library (tenant TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_library_operations (
        tenant TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, selection_id TEXT, PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS file_library_selections (
        tenant TEXT NOT NULL, id TEXT NOT NULL, manifest TEXT NOT NULL, terminal TEXT, checked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant,id));
      CREATE INDEX IF NOT EXISTS file_library_open ON file_library_selections(tenant,terminal,checked);`);
  }
  private snapshot(tenant: string): LibrarySnapshot {
    const row = this.db.prepare('SELECT snapshot FROM file_library WHERE tenant=?').get(tenant) as
      { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) : { revision: 0, entries: [], basket: [], groups: [] };
  }
  private save(tenant: string, snapshot: LibrarySnapshot) {
    snapshot.revision++;
    this.db.prepare('INSERT OR REPLACE INTO file_library VALUES (?,?)').run(tenant, JSON.stringify(snapshot));
  }
  private operation(tenant: string, operationId: string, payload: string) {
    const row = this.db
      .prepare('SELECT payload,selection_id FROM file_library_operations WHERE tenant=? AND id=?')
      .get(tenant, operationId) as { payload: string; selection_id: string | null } | undefined;
    if (row && row.payload !== payload) throw new FileUploadError(409, '同一操作ID不能用于不同内容');
    return row;
  }
  private remember(tenant: string, operationId: string, payload: string, selectionId: string | null = null) {
    this.db
      .prepare('INSERT INTO file_library_operations VALUES (?,?,?,?)')
      .run(tenant, operationId, payload, selectionId);
  }
  private change(
    tenant: string,
    operationId: string,
    payload: string,
    apply: (snapshot: LibrarySnapshot) => void,
  ) {
    return this.db.transaction(() => {
      const snapshot = this.snapshot(tenant);
      if (this.operation(tenant, operationId, payload)) return snapshot;
      apply(snapshot);
      this.save(tenant, snapshot);
      this.remember(tenant, operationId, payload);
      return snapshot;
    })();
  }
  private async describe(tenant: string, assetId: string): Promise<Asset> {
    const value: Asset = await this.endpoint.request('session.library.describe', tenant, { assetId });
    if (
      !value ||
      value.assetId !== assetId ||
      !/^[0-9a-f]{64}$/.test(value.hash) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      value.size > this.limits.maxFileBytes ||
      typeof value.type !== 'string' ||
      Buffer.byteLength(value.type) > 255 ||
      /[\x00-\x1f\x7f]/.test(value.type)
    )
      throw new FileUploadError(502, 'Endpoint未返回有效文件信息');
    return value;
  }
  private async retainAssets(
    tenant: string,
    fields: Pick<LibraryEntry, 'assetId' | 'originalAssetId' | 'photo'>,
    authorize: () => void,
  ): Promise<Asset> {
    const references = assetIds(fields);
    const asset = await this.describe(tenant, fields.assetId);
    for (const reference of references.slice(1)) await this.describe(tenant, reference);
    authorize();
    const retained = await this.endpoint.request('session.library.retain', tenant, { assetIds: references });
    authorize();
    if (retained?.accepted !== true) throw new FileUploadError(502, 'Endpoint未确认保留文件');
    return asset;
  }
  private async import(tenant: string, params: Params<'library.import'>, authorize: () => void) {
    const operationId = id(params.operationId),
      assetId = id(params.assetId),
      name = fileName(params.name);
    const { destination } = params;
    if (destination !== 'basket' && destination !== 'library') throw invalid('无效的文件保存位置');
    const originalAssetId = params.originalAssetId === undefined ? undefined : id(params.originalAssetId);
    const photo = photoMetadata(params.photo);
    const afterId = params.afterId === undefined ? undefined : id(params.afterId);
    if (afterId !== undefined && destination !== 'basket') throw invalid('仅篮内文件支持指定插入位置');
    const requestedGroup = params.groupId === null ? null : id(params.groupId);
    // Keep the original receipt hash for imports from before photo metadata.
    const fields = ['import', assetId, name, destination, requestedGroup, originalAssetId, afterId];
    const payload = operationHash(...fields, ...(photo ? [photo] : []));
    if (this.operation(tenant, operationId, payload)) return this.snapshot(tenant);
    const validate = (snapshot: LibrarySnapshot) => {
      const groupId = group(snapshot, requestedGroup);
      if (snapshot.entries.length >= MAX_CATALOG) throw new FileUploadError(409, '文件库已达上限');
      if (destination === 'basket' && snapshot.basket.length >= MAX_BASKET)
        throw new FileUploadError(409, '文件篮已满');
      if (afterId !== undefined && !snapshot.basket.includes(afterId))
        throw new FileUploadError(409, '插入位置已改变');
      return groupId;
    };
    validate(this.snapshot(tenant));
    const asset = await this.retainAssets(tenant, { assetId, originalAssetId, photo }, authorize);
    return this.change(tenant, operationId, payload, (snapshot) => {
      const groupId = validate(snapshot),
        entryId = randomUUID();
      snapshot.entries.unshift({
        id: entryId,
        assetId,
        name,
        type: asset.type,
        size: asset.size,
        createdAt: Date.now(),
        groupId,
        archived: destination === 'library',
        ...(originalAssetId ? { originalAssetId } : {}),
        ...(photo ? { photo } : {}),
      });
      if (destination === 'basket') {
        const index = afterId === undefined ? snapshot.basket.length : snapshot.basket.indexOf(afterId) + 1;
        snapshot.basket.splice(index, 0, entryId);
      }
    });
  }
  private async replace(tenant: string, params: Params<'library.replace'>, authorize: () => void) {
    const operationId = id(params.operationId),
      entryId = id(params.entryId),
      assetId = id(params.assetId);
    const { expectedRevision } = params;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw invalid('无效的文件库版本');
    const originalAssetId = params.originalAssetId === undefined ? undefined : id(params.originalAssetId);
    const photo = photoMetadata(params.photo);
    const payload = operationHash('replace', entryId, expectedRevision, assetId, originalAssetId, photo);
    if (this.operation(tenant, operationId, payload)) return this.snapshot(tenant);
    const validate = (snapshot: LibrarySnapshot) => {
      if (snapshot.revision !== expectedRevision)
        throw new FileUploadError(409, '文件篮已更新，请刷新后重试');
      const [entry] = entries(snapshot, [entryId]);
      if (this.pendingEntries(tenant).has(entryId))
        throw new FileUploadError(409, '文件选择尚未确认，暂不能替换');
      return entry;
    };
    validate(this.snapshot(tenant));
    const asset = await this.retainAssets(tenant, { assetId, originalAssetId, photo }, authorize);
    const snapshot = this.change(tenant, operationId, payload, (snapshot) => {
      const entry = validate(snapshot);
      entry.assetId = assetId;
      entry.type = asset.type;
      entry.size = asset.size;
      if (originalAssetId) entry.originalAssetId = originalAssetId;
      else delete entry.originalAssetId;
      if (photo) entry.photo = photo;
      else delete entry.photo;
    });
    await this.reconcileReferences(tenant, snapshot);
    authorize();
    return snapshot;
  }
  private pendingEntries(tenant: string) {
    const ids = new Set<string>();
    const pending = this.db
      .prepare('SELECT manifest FROM file_library_selections WHERE tenant=? AND terminal IS NULL')
      .all(tenant) as { manifest: string }[];
    for (const row of pending) {
      const manifest: Selection = JSON.parse(row.manifest);
      for (const entryId of manifest.entryIds) ids.add(entryId);
    }
    return ids;
  }
  private prune(tenant: string, snapshot: LibrarySnapshot) {
    const inUse = this.pendingEntries(tenant);
    for (const entryId of snapshot.basket) inUse.add(entryId);
    const before = snapshot.entries.length;
    snapshot.entries = snapshot.entries.filter((entry) => entry.archived || inUse.has(entry.id));
    return snapshot.entries.length !== before;
  }
  private async reconcileReferences(tenant: string, snapshot: LibrarySnapshot) {
    const assets = new Set<string>();
    for (const entry of snapshot.entries) for (const assetId of assetIds(entry)) assets.add(assetId);
    // SQLite stays authoritative if Endpoint is offline. The next library.get
    // replays the complete retained set, including references from pending selections.
    await this.endpoint
      .request('session.library.references', tenant, {
        revision: snapshot.revision,
        assetIds: [...assets].sort(),
      })
      .catch(() => {});
  }
  private selection(tenant: string, selectionId: string) {
    const row = this.db
      .prepare('SELECT manifest,terminal FROM file_library_selections WHERE tenant=? AND id=?')
      .get(tenant, selectionId) as { manifest: string; terminal: TerminalState | null } | undefined;
    if (!row) throw new FileUploadError(404, '文件选择不存在');
    return { manifest: JSON.parse(row.manifest) as Selection, terminal: row.terminal };
  }
  private async prepare(
    tenant: string,
    params: Params<'library.prepare'>,
    authorize: () => void,
    resolve: (requestId: string) => InternalFileRequest | undefined,
  ) {
    const operationId = id(params.operationId),
      requestId = id(params.requestId);
    const entryIds = ids(params.entryIds, MAX_BASKET, 1);
    const requestedGroup = params.groupId === null ? null : id(params.groupId);
    const payload = operationHash('prepare', requestId, entryIds, requestedGroup);
    const previous = this.operation(tenant, operationId, payload);
    let manifest: Selection;
    if (previous?.selection_id) {
      const row = this.selection(tenant, previous.selection_id);
      if (row.terminal || row.manifest.prepared) return { selectionId: previous.selection_id };
      manifest = row.manifest;
    } else {
      const request = resolve(requestId);
      if (!request || request.state !== 'pending') throw new FileUploadError(409, '文件选择请求已失效');
      if ((!request.multiple && entryIds.length !== 1) || entryIds.length > request.limits.maxFiles)
        throw invalid('文件数量超出页面限制');
      const snapshot = this.snapshot(tenant),
        selected = entries(snapshot, entryIds);
      if (selected.some((entry) => entry.photo?.pending)) throw new FileUploadError(409, '照片尚未确认');
      if (
        selected.some((entry) => entry.size > request.limits.maxFileBytes) ||
        selected.reduce((sum, entry) => sum + entry.size, 0) > request.limits.maxBatchBytes
      )
        throw new FileUploadError(413, '文件大小超过限制');
      const groupId = group(snapshot, requestedGroup);
      manifest = {
        selectionId: randomUUID().replace(/-/g, ''),
        requestId,
        binding: request.binding,
        entryIds,
        groupId,
        files: selected.map(({ assetId, name, type }) => ({ assetId, name, type })),
        prepared: false,
      };
      this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO file_library_selections (tenant,id,manifest) VALUES (?,?,?)')
          .run(tenant, manifest.selectionId, JSON.stringify(manifest));
        this.remember(tenant, operationId, payload, manifest.selectionId);
      })();
    }
    const { selectionId, binding, files } = manifest;
    const accepted = await this.endpoint.request('session.library.prepare', tenant, {
      selectionId,
      binding,
      files,
      requestId,
    });
    authorize();
    if (accepted?.accepted !== true) throw new FileUploadError(502, 'Endpoint未确认文件选择');
    manifest.prepared = true;
    this.db
      .prepare('UPDATE file_library_selections SET manifest=? WHERE tenant=? AND id=?')
      .run(JSON.stringify(manifest), tenant, selectionId);
    return { selectionId };
  }
  private async status(tenant: string, selectionId: string): Promise<SelectionState> {
    try {
      const result = await this.endpoint.request('session.library.selectionStatus', tenant, { selectionId });
      const state = result?.state;
      if (state === 'pending' || state === 'validating' || state === 'selected' || state === 'cancelled')
        return state;
    } catch {}
    return 'unknown';
  }
  private settle(tenant: string, manifest: Selection, state: SelectionState) {
    this.db.transaction(() => {
      const { selectionId } = manifest;
      if (state === 'selected' || state === 'cancelled') {
        const update = this.db
          .prepare(
            'UPDATE file_library_selections SET terminal=? WHERE tenant=? AND id=? AND terminal IS NULL',
          )
          .run(state, tenant, selectionId);
        if (Number(update.changes)) {
          const snapshot = this.snapshot(tenant),
            selected = new Set(manifest.entryIds);
          if (state === 'selected')
            for (const entry of snapshot.entries)
              if (selected.has(entry.id)) {
                entry.archived = true;
                entry.groupId = manifest.groupId;
              }
          if (state === 'selected')
            snapshot.basket = snapshot.basket.filter((entryId) => !selected.has(entryId));
          const pruned = this.prune(tenant, snapshot);
          if (state === 'selected' || pruned) this.save(tenant, snapshot);
        }
      } else {
        this.db
          .prepare('UPDATE file_library_selections SET checked=? WHERE tenant=? AND id=?')
          .run(Date.now(), tenant, selectionId);
      }
    })();
  }
  private async finish(tenant: string, selectionId: string, authorize: () => void) {
    const { manifest, terminal } = this.selection(tenant, selectionId);
    const state = terminal ?? (await this.status(tenant, selectionId));
    authorize();
    if (!terminal) this.settle(tenant, manifest, state);
    const snapshot = this.snapshot(tenant);
    if (state === 'cancelled' || state === 'selected') await this.reconcileReferences(tenant, snapshot);
    authorize();
    return { state, snapshot };
  }
  private async get(tenant: string, authorize: () => void) {
    const pending = this.db
      .prepare(
        'SELECT manifest FROM file_library_selections WHERE tenant=? AND terminal IS NULL ORDER BY checked,id LIMIT ?',
      )
      .all(tenant, RECONCILE_BATCH) as { manifest: string }[];
    const results = await Promise.all(
      pending.map(async (row) => {
        const manifest = JSON.parse(row.manifest) as Selection;
        return { manifest, state: await this.status(tenant, manifest.selectionId) };
      }),
    );
    authorize();
    for (const { manifest, state } of results) this.settle(tenant, manifest, state);
    const snapshot = this.snapshot(tenant);
    await this.reconcileReferences(tenant, snapshot);
    authorize();
    return snapshot;
  }
  request(
    tenant: string,
    method: string,
    params: unknown,
    authorize: () => void,
    resolve: (requestId: string) => InternalFileRequest | undefined,
  ) {
    const previous = this.queues.get(tenant);
    const run = () => this.apply(tenant, method, params, authorize, resolve);
    const next = previous ? previous.then(run, run) : run();
    this.queues.set(tenant, next);
    const release = () => {
      if (this.queues.get(tenant) === next) this.queues.delete(tenant);
    };
    void next.then(release, release);
    return next;
  }
  private async apply(
    tenant: string,
    method: string,
    params: any,
    authorize: () => void,
    resolve: (requestId: string) => InternalFileRequest | undefined,
  ) {
    authorize();
    switch (method) {
      case 'library.get':
        return this.get(tenant, authorize);
      case 'library.import':
        return this.import(tenant, params, authorize);
      case 'library.replace':
        return this.replace(tenant, params, authorize);
      case 'library.prepare':
        return this.prepare(tenant, params, authorize, resolve);
      case 'library.finish':
        return this.finish(tenant, id(params.selectionId), authorize);
      case 'library.basket': {
        const basket = ids(params.ids, MAX_BASKET),
          { expectedRevision } = params;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
          throw invalid('无效的文件库版本');
        const snapshot = this.change(
          tenant,
          id(params.operationId),
          operationHash('basket', expectedRevision, basket),
          (snapshot) => {
            if (snapshot.revision !== expectedRevision)
              throw new FileUploadError(409, '文件篮已更新，请刷新后重试');
            entries(snapshot, basket);
            snapshot.basket = basket;
            this.prune(tenant, snapshot);
          },
        );
        await this.reconcileReferences(tenant, snapshot);
        authorize();
        return snapshot;
      }
      case 'library.group': {
        const groupId = params.id === undefined ? undefined : id(params.id),
          name = groupName(params.name);
        return this.change(
          tenant,
          id(params.operationId),
          operationHash('group', groupId, name),
          (snapshot) => {
            if (groupId === undefined) {
              if (snapshot.groups.length >= MAX_GROUPS) throw new FileUploadError(409, '分组已达上限');
              snapshot.groups.push({ id: randomUUID(), name });
            } else {
              const item = snapshot.groups.find((entry) => entry.id === groupId);
              if (!item) throw new FileUploadError(404, '分组不存在');
              item.name = name;
            }
          },
        );
      }
      case 'library.move': {
        const entryIds = ids(params.ids, MAX_CATALOG, 1);
        const requestedGroup = params.groupId === null ? null : id(params.groupId);
        return this.change(
          tenant,
          id(params.operationId),
          operationHash('move', entryIds, requestedGroup),
          (snapshot) => {
            const groupId = group(snapshot, requestedGroup);
            for (const entry of entries(snapshot, entryIds)) entry.groupId = groupId;
          },
        );
      }
      case 'library.delete': {
        const entryIds = ids(params.ids, MAX_BASKET, 1);
        const snapshot = this.change(
          tenant,
          id(params.operationId),
          operationHash('delete', entryIds),
          (snapshot) => {
            entries(snapshot, entryIds);
            const pending = this.pendingEntries(tenant);
            if (entryIds.some((entryId) => pending.has(entryId)))
              throw new FileUploadError(409, '文件选择尚未确认，暂不能删除');
            const removed = new Set(entryIds);
            snapshot.entries = snapshot.entries.filter((entry) => !removed.has(entry.id));
            snapshot.basket = snapshot.basket.filter((entryId) => !removed.has(entryId));
          },
        );
        await this.reconcileReferences(tenant, snapshot);
        authorize();
        return snapshot;
      }
      default:
        throw invalid('未知文件库操作');
    }
  }
}
