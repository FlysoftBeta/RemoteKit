import { createHash, randomUUID } from 'node:crypto';
import { RemoteKitError, parseWireError } from '../../shared/errors';
import type {
  Asset,
  AssetDescription,
  LibraryAssetFields,
  LibraryEntry,
  LibraryMethods,
  LibrarySnapshot,
  LibrarySource,
  PhotoMetadata,
  SelectionState,
  SnippetOrigin,
} from '../../shared/file-library';
import type { ObjectIndex } from '../cluster/objects';
import type { ServicePeers } from '../viewers/service-peers';
import type { EndpointGateway } from '../endpoint/gateway';
import type { DownloadEvent } from '../endpoint/types';
import { log } from '../log';
import { LibraryRepository, sameSource, sourceExcluded, type Selection } from '../persistence/library';
import { KeyedSerialQueue } from '../util/serial-queue';
import { type FileLimits, type InternalFileRequest } from '../workspace/page-requests';

type LibraryMethod = keyof LibraryMethods;
type Params<K extends LibraryMethod> = LibraryMethods[K]['params'];
const MAX_BASKET = 64;
const MAX_CATALOG = 4096;
const MAX_PARTITIONS = 256;
const RECONCILE_BATCH = 8;
const operationHash = (...fields: unknown[]) =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const invalid = (message: string) => new RemoteKitError('invalid_request', message);

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid('无效的文件库标识');
  return value;
}
function ids(value: unknown, max: number, min = 0): string[] {
  if (!Array.isArray(value) || value.length < min || new Set(value).size !== value.length)
    throw invalid('无效的文件数量或重复文件');
  if (value.length > max)
    throw new RemoteKitError('limit_exceeded', '文件数量超过限制', { capacity: 'selection' });
  return value.map(id);
}

function librarySource(value: unknown): LibrarySource {
  if (!value || typeof value !== 'object') throw invalid('文件来源无效');
  const { app, channel } = value as LibrarySource;
  if (typeof app !== 'string' || typeof channel !== 'string') throw invalid('文件来源无效');
  if (app === 'files' && (channel === 'upload' || channel === 'camera')) return { app, channel };
  if (/^web:[a-zA-Z0-9_-]{1,128}$/.test(app) && channel === '') return { app, channel };
  if (app === 'download' && channel === '') return { app, channel };
  if (app === 'clipboard' && channel === '') return { app, channel };
  if (app === 'study' && channel.length > 0 && channel.length <= 120 && !/[\x00-\x1f\x7f]/.test(channel))
    return { app, channel };
  if (
    (app === 'browser' || app === 'download') &&
    channel.length > 0 &&
    channel.length <= (app === 'download' ? 259 : 253)
  ) {
    try {
      const url = new URL('https://' + channel);
      if (
        app === 'download'
          ? url.host === channel || `${url.hostname}:443` === channel
          : url.hostname === channel
      )
        return { app, channel };
    } catch {}
  }
  throw invalid('文件来源无效');
}
function importOrigin(value: unknown): Params<'library.import'>['origin'] {
  if (!value || typeof value !== 'object') throw invalid('导入来源无效');
  const origin = value as Params<'library.import'>['origin'];
  if (origin.kind === 'request') return { kind: 'request', requestId: id(origin.requestId) };
  if (origin.kind === 'files' && (origin.channel === 'upload' || origin.channel === 'camera'))
    return {
      kind: 'files',
      channel: origin.channel,
      partitionId: origin.partitionId === null ? null : id(origin.partitionId),
    };
  throw invalid('导入来源无效');
}

function photoMetadata(value: unknown): PhotoMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw invalid('无效的照片信息');
  const { mode, pending, advisory, processingFailure, candidateAssetIds, quarterTurns } =
    value as Partial<PhotoMetadata>;
  if (mode !== 'photo' && mode !== 'scan') throw invalid('无效的拍摄模式');
  if (quarterTurns !== undefined && ![1, 2, 3].includes(quarterTurns)) throw invalid('无效的照片旋转角度');
  if (pending !== undefined && pending !== 'choice' && pending !== 'scan-error')
    throw invalid('无效的照片状态');
  if (advisory !== undefined && advisory !== 'low-quality') throw invalid('无效的照片提示');
  if (processingFailure !== undefined && !parseWireError(processingFailure))
    throw invalid('无效的照片处理状态');
  return {
    mode,
    ...(quarterTurns !== undefined ? { quarterTurns } : {}),
    ...(candidateAssetIds !== undefined ? { candidateAssetIds: ids(candidateAssetIds, 2) } : {}),
    ...(pending !== undefined ? { pending } : {}),
    ...(advisory !== undefined ? { advisory } : {}),
    ...(processingFailure !== undefined ? { processingFailure } : {}),
  };
}
function assetIds({ assetId, originalAssetId, photo }: LibraryAssetFields): string[] {
  return [
    ...new Set([assetId, ...(originalAssetId ? [originalAssetId] : []), ...(photo?.candidateAssetIds ?? [])]),
  ];
}
function fileName(value: unknown): string {
  if (typeof value === 'string' && value.length > 255)
    throw new RemoteKitError('limit_exceeded', '文件名超过 255 字符', { capacity: 'field' });
  if (
    typeof value !== 'string' ||
    !value ||
    /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) ||
    /[ .]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
  )
    throw invalid('无效的文件名');
  return value;
}
function partitionName(value: unknown): string {
  if (typeof value === 'string' && value.length > 120)
    throw new RemoteKitError('limit_exceeded', '分区名称超过 120 字符', { capacity: 'field' });
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value))
    throw invalid('无效的分区名');
  return value.trim();
}
function partition(snapshot: LibrarySnapshot, value: unknown): string | null {
  if (value === null) return null;
  const partitionId = id(value);
  if (!snapshot.partitions.some((item) => item.id === partitionId))
    throw new RemoteKitError('not_found', '分区不存在');
  return partitionId;
}
function entries(snapshot: LibrarySnapshot, entryIds: string[]) {
  const catalog = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  return entryIds.map((entryId) => {
    const entry = catalog.get(entryId);
    if (!entry) throw new RemoteKitError('not_found', '文件不存在');
    return entry;
  });
}

/** Catalog and native selection bookkeeping. Files themselves stay on the Endpoint. */
export class FileLibrary {
  private readonly queues = new KeyedSerialQueue();
  private readonly availability = new Map<string, string>();
  private project(tenant: string, snapshot: LibrarySnapshot) {
    return {
      ...snapshot,
      entries: snapshot.entries.map((entry) =>
        entry.kind === 'file'
          ? {
              ...entry,
              available: [entry.assetId, ...(entry.photo?.candidateAssetIds ?? [])].every((id) =>
                this.objects.available(id),
              ),
            }
          : entry,
      ),
    };
  }
  refreshAvailability(tenant: string) {
    let snapshot = this.project(tenant, this.repository.snapshot(tenant));
    const key = JSON.stringify(
      snapshot.entries.map((entry) => [entry.id, entry.kind === 'snippet' || entry.available]),
    );
    const previous = this.availability.get(tenant);
    this.availability.set(tenant, key);
    if (previous === key) return;
    if (previous !== undefined) {
      this.repository.availabilityChanged(tenant);
      snapshot = this.project(tenant, this.repository.snapshot(tenant));
    }
    this.onChanged?.(tenant, this.project(tenant, snapshot));
  }
  onDeleted?: (tenant: string, entryIds: string[]) => void;
  onChanged?: (tenant: string, snapshot: LibrarySnapshot) => void;

  constructor(
    private readonly repository: LibraryRepository,
    private readonly endpoint: Pick<EndpointGateway, 'prepareSelection' | 'selectionStatus'> &
      Pick<ServicePeers, 'describeAsset'>,
    private limits: FileLimits,
    private readonly objects: Pick<ObjectIndex, 'require' | 'checkQuota' | 'available'>,
    private readonly fileSourceForRequest: (tenant: string, requestId: string) => LibrarySource | null,
  ) {}
  recordSnippet(tenant: string, text: string, origin: SnippetOrigin, copiedAt: number) {
    return this.queues.run(tenant, async () => {
      const snapshot = this.repository.recordSnippet(tenant, text, origin, copiedAt);
      if (snapshot) this.onChanged?.(tenant, this.project(tenant, snapshot));
    });
  }
  importFromControl(
    tenant: string,
    input: {
      operationId: string;
      entryId: string;
      assetId: string;
      name: string;
      type: string;
      size: number;
      source: LibrarySource;
      detail: string;
    },
    authorize: () => void = () => {},
    committed: () => void = () => {},
  ) {
    return this.queues.run(tenant, async () => {
      authorize();
      const name = fileName(input.name);
      const source = librarySource(input.source);
      const entryId = id(input.entryId);
      const assetId = id(input.assetId);
      const operationId = id(input.operationId);
      if (
        !Number.isSafeInteger(input.size) ||
        input.size < 0 ||
        typeof input.type !== 'string' ||
        /[\x00-\x1f\x7f]/.test(input.type) ||
        typeof input.detail !== 'string'
      )
        throw invalid('无效的导入文件');
      if (input.size > 256 * 1024 * 1024 || input.type.length > 255 || input.detail.length > 512)
        throw new RemoteKitError('limit_exceeded', '导入文件大小或信息长度超过限制', { capacity: 'file' });
      const payload = operationHash('control-import', input);
      const snapshot = this.repository.change(tenant, operationId, payload, (snapshot) => {
        authorize();
        if (sourceExcluded(snapshot, source)) throw new RemoteKitError('forbidden', '已排除此文件来源');
        if (snapshot.entries.length >= MAX_CATALOG)
          throw new RemoteKitError('limit_exceeded', '文件库已满', { capacity: 'catalog' });
        if (snapshot.entries.some((entry) => entry.id === entryId))
          throw new RemoteKitError('conflict', '文件已存在');
        this.objects.require(tenant, assetId);
        this.objects.checkQuota(tenant);
        snapshot.entries.unshift({
          kind: 'file',
          available: true,
          id: entryId,
          assetId,
          name,
          type: input.type,
          size: input.size,
          source,
          detail: input.detail,
          createdAt: Date.now(),
          partitionId: null,
          collected: true,
        });
        committed();
      });
      this.onChanged?.(tenant, this.project(tenant, snapshot));
      return { entryId };
    });
  }
  expireStudyEntry(tenant: string, entryId: string, operationId: string) {
    return this.queues.run(tenant, async () => {
      const before = this.repository.snapshot(tenant);
      const entry = before.entries.find((entry) => entry.id === entryId);
      if (!entry || entry.source?.app !== 'study') return;
      this.rejectPending(tenant, [entry]);
      const snapshot = this.repository.change(
        tenant,
        operationId,
        operationHash('study-expire', entryId),
        (snapshot) => {
          const entry = snapshot.entries.find((entry) => entry.id === entryId);
          if (!entry || entry.source?.app !== 'study') return;
          if (entry.partitionId !== null) {
            entry.source = null;
            entry.collected = false;
          } else {
            snapshot.entries = snapshot.entries.filter((entry) => entry.id !== entryId);
            snapshot.basket = snapshot.basket.filter((id) => id !== entryId);
          }
        },
      );
      this.onChanged?.(tenant, this.project(tenant, snapshot));
    });
  }
  consumeDownload(tenant: string, event: DownloadEvent) {
    return this.queues.run(tenant, async () => {
      const operationId = operationHash('download', event.eventId);
      const payload = operationHash(
        event.type,
        event.eventId,
        event.name,
        event.origin,
        event.type === 'download.imported' ? [event.assetId, event.mimeType, event.size] : event.error,
      );
      if (this.repository.operation(tenant, operationId, payload)) return;
      if (event.type === 'download.failed') {
        log.warn('library.download_failed', {
          tenant,
          name: event.name,
          origin: event.origin,
          error: event.error,
        });
        this.repository.change(tenant, operationId, payload, () =>
          this.repository.recordDownloadFailure(tenant, event),
        );
        return;
      }
      const assetId = id(event.assetId),
        name = fileName(event.name);
      const size = Number(event.size);
      if (
        typeof event.size !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(event.size) ||
        !Number.isSafeInteger(size)
      )
        throw invalid('下载大小无效');
      if (size > this.limits.maxFileBytes)
        throw new RemoteKitError('limit_exceeded', '下载文件超过大小限制', { capacity: 'file' });
      if (typeof event.mimeType === 'string' && Buffer.byteLength(event.mimeType) > 255)
        throw new RemoteKitError('limit_exceeded', '下载类型超过长度限制', { capacity: 'file' });
      if (typeof event.mimeType !== 'string' || /[\x00-\x1f\x7f]/.test(event.mimeType))
        throw invalid('下载类型无效');
      let channel = '';
      if (event.origin && event.origin !== 'null') {
        try {
          channel = new URL(event.origin).host;
        } catch {
          throw invalid('下载来源无效');
        }
      }
      const source = { app: 'download', channel };
      this.repository.change(tenant, operationId, payload, (snapshot) => {
        if (sourceExcluded(snapshot, source)) return;
        if (snapshot.entries.length >= MAX_CATALOG) {
          throw new RemoteKitError('limit_exceeded', '文件库已满', { capacity: 'catalog' });
        }
        this.objects.require(tenant, assetId);
        this.objects.checkQuota(tenant);
        snapshot.entries.unshift({
          kind: 'file',
          available: true,
          id: randomUUID(),
          assetId,
          name,
          type: event.mimeType,
          size,
          createdAt: Date.now(),
          source,
          partitionId: null,
          collected: true,
        });
      });
    });
  }
  entryExists(tenant: string, entryId: string): boolean {
    return this.repository.snapshot(tenant).entries.some((entry) => entry.id === entryId);
  }
  hiddenEntryIds(tenant: string): Set<string> {
    const snapshot = this.repository.snapshot(tenant);
    return new Set(
      snapshot.entries
        .filter(
          (entry) =>
            entry.kind === 'snippet' || (entry.source !== null && sourceExcluded(snapshot, entry.source)),
        )
        .map((entry) => entry.id),
    );
  }
  organized(tenant: string, entryId: string): boolean {
    return this.repository
      .snapshot(tenant)
      .entries.some((entry) => entry.id === entryId && entry.partitionId !== null);
  }
  private rejectPending(tenant: string, selected: LibraryEntry[]) {
    const pending = this.repository.pendingEntries(tenant);
    if (selected.some((entry) => pending.has(entry.id)))
      throw new RemoteKitError('conflict', '文件正被待完成的选择占用', {
        detail: 'Files are held by a pending selection',
      });
  }
  private async describe(tenant: string, assetId: string): Promise<AssetDescription> {
    this.objects.require(tenant, assetId);
    const value = await this.endpoint.describeAsset(tenant, { assetId });
    if (
      !value ||
      value.assetId !== assetId ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      value.size > this.limits.maxFileBytes ||
      (value.type !== undefined &&
        (typeof value.type !== 'string' ||
          Buffer.byteLength(value.type) > 255 ||
          /[\x00-\x1f\x7f]/.test(value.type)))
    )
      throw new RemoteKitError('outcome_unknown', 'Endpoint未返回有效文件信息');
    return value;
  }
  private async describeAssets(
    tenant: string,
    fields: LibraryAssetFields,
    authorize: () => void,
  ): Promise<Asset> {
    const references = assetIds(fields);
    const asset = await this.describe(tenant, fields.assetId);
    if (asset.type === undefined)
      throw new RemoteKitError('outcome_unknown', 'Asset media type is required to create a library entry');
    for (const reference of references.slice(1)) await this.describe(tenant, reference);
    authorize();
    return { ...asset, type: asset.type };
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
    const origin = importOrigin(params.origin);
    const requestedPartition = origin.kind === 'files' ? origin.partitionId : null;
    const fields = ['import', assetId, name, destination, origin, originalAssetId, afterId];
    const payload = operationHash(...fields, ...(photo ? [photo] : []));
    if (this.repository.operation(tenant, operationId, payload)) return this.repository.snapshot(tenant);
    const source =
      origin.kind === 'files'
        ? { app: 'files', channel: origin.channel }
        : this.fileSourceForRequest(tenant, origin.requestId);
    if (!source)
      throw new RemoteKitError('conflict', '文件请求已失效', {
        detail: 'File request is no longer available',
      });
    const validate = (snapshot: LibrarySnapshot) => {
      if (destination === 'library' && origin.kind === 'request' && sourceExcluded(snapshot, source))
        throw new RemoteKitError('conflict', '该来源已被排除收集', {
          detail: 'Source is excluded from collection',
        });
      const partitionId = partition(snapshot, requestedPartition);
      if (snapshot.entries.length >= MAX_CATALOG)
        throw new RemoteKitError('limit_exceeded', '文件库已达上限', { capacity: 'catalog' });
      if (destination === 'basket' && snapshot.basket.length >= MAX_BASKET)
        throw new RemoteKitError('limit_exceeded', '文件篮已满', { capacity: 'basket' });
      if (afterId !== undefined && !snapshot.basket.includes(afterId))
        throw new RemoteKitError('conflict', '插入位置已改变');
      return partitionId;
    };
    validate(this.repository.snapshot(tenant));
    const asset = await this.describeAssets(tenant, { assetId, originalAssetId, photo }, authorize);
    return this.repository.change(tenant, operationId, payload, (snapshot) => {
      for (const reference of assetIds({ assetId, originalAssetId, photo }))
        this.objects.require(tenant, reference);
      this.objects.checkQuota(tenant);
      const partitionId = validate(snapshot),
        entryId = randomUUID();
      snapshot.entries.unshift({
        kind: 'file',
        available: true,
        id: entryId,
        assetId,
        name,
        type: asset.type,
        size: asset.size,
        createdAt: Date.now(),
        source: { ...source },
        partitionId,
        collected: destination === 'library',
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
    if (this.repository.operation(tenant, operationId, payload)) return this.repository.snapshot(tenant);
    const validate = (snapshot: LibrarySnapshot) => {
      if (snapshot.revision !== expectedRevision)
        throw new RemoteKitError('conflict', '文件篮已更新，请刷新后重试');
      const [entry] = entries(snapshot, [entryId]);
      if (entry.kind !== 'file') throw invalid('剪贴片段不能替换为文件');
      if (this.repository.pendingEntries(tenant).has(entryId))
        throw new RemoteKitError('conflict', '文件选择尚未确认，暂不能替换');
      return entry;
    };
    validate(this.repository.snapshot(tenant));
    const asset = await this.describeAssets(tenant, { assetId, originalAssetId, photo }, authorize);
    const snapshot = this.repository.change(tenant, operationId, payload, (snapshot) => {
      for (const reference of assetIds({ assetId, originalAssetId, photo }))
        this.objects.require(tenant, reference);
      this.objects.checkQuota(tenant);
      const entry = validate(snapshot);
      entry.assetId = assetId;
      entry.type = asset.type;
      if (photo && asset.type === 'image/webp') entry.name = entry.name.replace(/\.[^.]*$/, '') + '.webp';
      entry.size = asset.size;
      if (originalAssetId) entry.originalAssetId = originalAssetId;
      else delete entry.originalAssetId;
      if (photo) entry.photo = photo;
      else delete entry.photo;
    });
    authorize();
    return snapshot;
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
    const payload = operationHash('prepare', requestId, entryIds);
    const previous = this.repository.operation(tenant, operationId, payload);
    let manifest: Selection;
    if (previous?.selection_id) {
      const row = this.repository.selection(tenant, previous.selection_id);
      if (row.terminal || row.manifest.prepared) return { selectionId: previous.selection_id };
      manifest = row.manifest;
    } else {
      const request = resolve(requestId);
      if (!request || request.state !== 'pending') throw new RemoteKitError('conflict', '文件选择请求已失效');
      if ((!request.multiple && entryIds.length !== 1) || entryIds.length > request.limits.maxFiles)
        throw new RemoteKitError('limit_exceeded', '文件数量超出页面限制', { capacity: 'selection' });
      const snapshot = this.project(tenant, this.repository.snapshot(tenant)),
        selected = entries(snapshot, entryIds).map((entry) => {
          if (entry.kind !== 'file') throw invalid('剪贴片段不能用于文件选择');
          if (!entry.available) throw new RemoteKitError('unavailable', '文件暂不可用，恢复后自动继续');
          return entry;
        });
      if (selected.some((entry) => entry.photo?.pending))
        throw new RemoteKitError('conflict', '照片尚未确认');
      if (
        selected.some((entry) => entry.size > request.limits.maxFileBytes) ||
        selected.reduce((sum, entry) => sum + entry.size, 0) > request.limits.maxBatchBytes
      )
        throw new RemoteKitError('limit_exceeded', '文件大小超过限制', { capacity: 'selection' });
      manifest = {
        selectionId: randomUUID().replace(/-/g, ''),
        requestId,
        binding: request.binding,
        entryIds,
        files: selected.map(({ assetId, name, type }) => ({ assetId, name, type })),
        limits: request.limits,
        prepared: false,
      };
      this.repository.insertSelection(tenant, manifest, operationId, payload);
    }
    const { selectionId, binding, files, limits } = manifest;
    const accepted = await this.endpoint.prepareSelection(tenant, {
      selectionId,
      binding,
      files,
      limits,
      requestId,
    });
    authorize();
    if (accepted?.accepted !== true) throw new RemoteKitError('outcome_unknown', 'Endpoint未确认文件选择');
    manifest.prepared = true;
    this.repository.saveSelection(tenant, manifest);
    return { selectionId };
  }
  private async status(tenant: string, selectionId: string): Promise<SelectionState> {
    try {
      const result = await this.endpoint.selectionStatus(tenant, { selectionId });
      const state = result?.state;
      if (state === 'pending' || state === 'validating' || state === 'selected' || state === 'cancelled')
        return state;
    } catch {}
    return 'unknown';
  }
  private async finish(tenant: string, selectionId: string, authorize: () => void) {
    const { manifest, terminal } = this.repository.selection(tenant, selectionId);
    const state = terminal ?? (await this.status(tenant, selectionId));
    authorize();
    if (!terminal) this.repository.settle(tenant, manifest, state);
    const snapshot = this.repository.snapshot(tenant);
    authorize();
    return { state, snapshot };
  }
  private async get(tenant: string, authorize: () => void) {
    const pending = this.repository.pending(tenant, RECONCILE_BATCH);
    const results = await Promise.all(
      pending.map(async (row) => {
        const manifest = row;
        return { manifest, state: await this.status(tenant, manifest.selectionId) };
      }),
    );
    authorize();
    for (const { manifest, state } of results) this.repository.settle(tenant, manifest, state);
    const snapshot = this.repository.snapshot(tenant);
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
    return this.queues.run(tenant, async () => {
      const result = await this.apply(tenant, method, params, authorize, resolve);
      if (result && typeof result === 'object' && 'entries' in result)
        return this.project(tenant, result as LibrarySnapshot);
      if (result && typeof result === 'object' && 'snapshot' in result)
        return {
          ...result,
          snapshot: this.project(tenant, (result as { snapshot: LibrarySnapshot }).snapshot),
        };
      return result;
    });
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
      case 'library.snippet':
        return this.repository.snippet(tenant, id(params.id));
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
        const snapshot = this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('basket', expectedRevision, basket),
          (snapshot) => {
            if (snapshot.revision !== expectedRevision)
              throw new RemoteKitError('conflict', '文件篮已更新，请刷新后重试');
            const added = entries(
              this.project(tenant, snapshot),
              basket.filter((id) => !snapshot.basket.includes(id)),
            );
            if (added.some((entry) => entry.kind !== 'file')) throw invalid('剪贴片段不能加入文件篮');
            if (added.some((entry) => !entry.available))
              throw new RemoteKitError('unavailable', '文件暂不可用，恢复后自动继续');
            snapshot.basket = basket;
            this.repository.prune(tenant, snapshot);
          },
        );
        authorize();
        return snapshot;
      }
      case 'library.partition': {
        const partitionId = params.id === undefined ? undefined : id(params.id),
          name = partitionName(params.name);
        return this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('partition', partitionId, name),
          (snapshot) => {
            if (partitionId === undefined) {
              if (snapshot.partitions.length >= MAX_PARTITIONS)
                throw new RemoteKitError('limit_exceeded', '分区已达上限', { capacity: 'catalog' });
              snapshot.partitions.push({ id: randomUUID(), name });
            } else {
              const item = snapshot.partitions.find((entry) => entry.id === partitionId);
              if (!item) throw new RemoteKitError('not_found', '分区不存在');
              item.name = name;
            }
          },
        );
      }
      case 'library.partitionDelete': {
        const partitionId = id(params.id);
        return this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('partitionDelete', partitionId),
          (snapshot) => {
            partition(snapshot, partitionId);
            const selected = snapshot.entries.filter((entry) => entry.partitionId === partitionId);
            this.rejectPending(tenant, selected);
            for (const entry of selected) entry.partitionId = null;
            snapshot.partitions = snapshot.partitions.filter((item) => item.id !== partitionId);
            if (snapshot.basketPartitionId === partitionId) snapshot.basketPartitionId = null;
            this.repository.prune(tenant, snapshot);
          },
        );
      }
      case 'library.source': {
        const source = librarySource(params.source);
        if (typeof params.excluded !== 'boolean') throw invalid('来源排除设置无效');
        const excluded = params.excluded;
        return this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('source', source, excluded),
          (snapshot) => {
            snapshot.excludedSources = snapshot.excludedSources.filter((item) => !sameSource(item, source));
            if (excluded) snapshot.excludedSources.push(source);
          },
        );
      }
      case 'library.sourcePurge': {
        const source = librarySource(params.source);
        return this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('sourcePurge', source),
          (snapshot) => {
            const selected = snapshot.entries.filter((entry) => sameSource(entry.source, source));
            this.rejectPending(tenant, selected);
            this.onDeleted?.(
              tenant,
              selected.map((entry) => entry.id),
            );
            for (const entry of selected) {
              entry.source = null;
              entry.collected = false;
            }
            this.repository.prune(tenant, snapshot);
          },
        );
      }
      case 'library.basketPartition': {
        const requestedPartition = params.partitionId === null ? null : id(params.partitionId);
        return this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('basketPartition', requestedPartition),
          (snapshot) => {
            snapshot.basketPartitionId = partition(snapshot, requestedPartition);
          },
        );
      }
      case 'library.move': {
        const entryIds = ids(params.ids, MAX_CATALOG, 1);
        const requestedPartition = params.partitionId === null ? null : id(params.partitionId);
        return this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('move', entryIds, requestedPartition),
          (snapshot) => {
            const partitionId = partition(snapshot, requestedPartition);
            for (const entry of entries(snapshot, entryIds)) entry.partitionId = partitionId;
            this.repository.prune(tenant, snapshot);
          },
        );
      }
      case 'library.delete': {
        const entryIds = ids(params.ids, MAX_CATALOG, 1);
        const snapshot = this.repository.change(
          tenant,
          id(params.operationId),
          operationHash('delete', entryIds),
          (snapshot) => {
            this.rejectPending(tenant, entries(snapshot, entryIds));
            this.onDeleted?.(tenant, entryIds);
            const removed = new Set(entryIds);
            snapshot.entries = snapshot.entries.filter((entry) => !removed.has(entry.id));
            snapshot.basket = snapshot.basket.filter((entryId) => !removed.has(entryId));
          },
        );
        authorize();
        return snapshot;
      }
      default:
        throw invalid('未知文件库操作');
    }
  }
}
