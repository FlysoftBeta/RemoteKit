import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { log } from './log';
import { RemoteKitError } from '../shared/errors';
const mediaKeys = [
  'encoder',
  'fps',
  'bitrate',
  'maxBitrate',
  'asyncDepth',
  'gop',
  'targetUsage',
  'qsvLowPower',
  'bufferMs',
  'rateControl',
  'idleIdrMs',
  'maxEncodeWidth',
  'maxEncodeHeight',
];
const limitKeys = ['maxSessions', 'diskReserveBytes', 'sessionMemoryBytes'];
const dropped = ['dataPath', 'browser', 'browserTraceDir'];
export function isV1(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    ('cluster' in value ||
      'nodeDefaults' in value ||
      Object.values(value.nodes ?? {}).some(
        (node: any) =>
          node &&
          typeof node === 'object' &&
          !Array.isArray(node) &&
          [...mediaKeys, ...limitKeys, ...dropped, 'controlUrl'].some((key) => key in node),
      ))
  );
}
export function convertV1(source: any): { config: Record<string, any>; warnings: string[] } {
  const warnings: string[] = [];
  for (const [name, value, keys] of [
    ['cluster', source.cluster, ['keyFile', 'controlUrl']],
    ['nodeDefaults', source.nodeDefaults, [...mediaKeys, ...limitKeys, ...dropped, 'peer', 'rtc']],
  ] as const) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new RemoteKitError('invalid_request', `${name} must be an object`);
    for (const key of Object.keys(value))
      if (!(keys as readonly string[]).includes(key))
        throw new RemoteKitError('invalid_request', `Unknown ${name}.${key}`);
  }
  const defaults = source.nodeDefaults ?? {};
  const take = (value: any, keys: string[]) =>
    Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
  const checkDropped = (value: any, name: string) => {
    for (const key of dropped)
      if (value[key] != null && !(key === 'dataPath' && value[key] === 'data'))
        warnings.push(`${name}.${key} is discarded: ${value[key]}`);
  };
  const known = [...mediaKeys, ...limitKeys, ...dropped, 'peer', 'rtc'];
  checkDropped(defaults, 'nodeDefaults');
  const config: Record<string, any> = { ...source };
  delete config.cluster;
  delete config.nodeDefaults;
  config.media = { ...take(defaults, mediaKeys), ...source.media };
  config.nodes = {};
  for (const [id, entry] of Object.entries(source.nodes ?? {}) as [string, any][]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new RemoteKitError('invalid_request', `nodes.${id} must be an object`);
    for (const key of Object.keys(entry))
      if (![...known, 'local', 'controlUrl'].includes(key))
        throw new RemoteKitError('invalid_request', `Unknown nodes.${id}.${key}`);
    checkDropped(entry, `nodes.${id}`);
    const { local } = entry;
    const peer = { listen: '0.0.0.0:3101', ...defaults.peer, ...entry.peer };
    if (peer.listen && !peer.address) {
      if (local || Object.keys(source.nodes).length === 1)
        peer.address = '127.0.0.1:' + peer.listen.split(':').at(-1);
    }
    config.nodes[id] = {
      ...(local ? { local } : { remote: { control: entry.controlUrl ?? source.cluster?.controlUrl } }),
      ...(Object.keys(peer).length ? { peer } : {}),
      rtc: { ...defaults.rtc, ...entry.rtc },
      limits: { ...take(defaults, limitKeys), ...take(entry, limitKeys) },
      media: take(entry, mediaKeys),
    };
  }
  return { config, warnings };
}

export function convertConfigFile(path: string, bootstrapFiles: string[]): (() => void) | undefined {
  const raw = readFileSync(path, 'utf8');
  const source = JSON.parse(raw);
  const backup = path + '.v1';
  if (isV1(source)) {
    const converted = convertV1(source);
    if (!existsSync(backup)) writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
    else if (readFileSync(backup, 'utf8') !== raw)
      throw new RemoteKitError('invalid_request', 'control.json.v1 already exists with different contents');
    writeFileSync(path, JSON.stringify(converted.config, null, 2) + '\n', { mode: 0o600 });
    for (const warning of converted.warnings) log.warn('config.conversion_warning', { message: warning });
    log.info('config.converted', { path });
  }
  if (!existsSync(backup)) return;
  const previous = JSON.parse(readFileSync(backup, 'utf8'));
  const keyFile = resolve(dirname(path), previous.cluster?.keyFile ?? 'cluster.key');
  if (!existsSync(keyFile)) return;
  for (const file of bootstrapFiles) {
    if (existsSync(file) && 'key' in JSON.parse(readFileSync(file, 'utf8'))) rmSync(file);
  }
  return () => rmSync(keyFile, { force: true });
}
