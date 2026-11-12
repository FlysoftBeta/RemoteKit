import {
  array,
  boolean,
  decodeState,
  encodeState,
  integer,
  literal,
  nullable,
  object,
  record,
  string,
  type Codec,
} from './persistence/codec';
import { migrateConfig } from './config-migrations';

const text = () => string({ min: 1, max: 32768 });
const port = integer({ min: 1, max: 65535 });
const key = string({ pattern: /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/ });
const mediaFields = {
  encoder: literal('auto', 'qsv', 'nvenc'),
  fps: integer({ min: 1, max: 120 }),
  bitrate: integer({ min: 100000, max: 50000000 }),
  maxBitrate: integer({ min: 100000, max: 60000000 }),
  asyncDepth: nullable(integer({ min: 1, max: 8 })),
  gop: nullable(integer({ min: 1, max: 65535 })),
  targetUsage: nullable(integer({ min: 1, max: 7 })),
  qsvLowPower: literal('auto', 'on', 'off'),
  bufferMs: nullable(integer({ min: 50, max: 5000 })),
  rateControl: nullable(literal('cbr', 'vbr')),
  idleIdrMs: integer({ min: 0, max: 4294967295 }),
  maxEncodeWidth: integer({ min: 16, max: 4096 }),
  maxEncodeHeight: integer({ min: 16, max: 4096 }),
};
const limits = object({
  maxSessions: nullable(integer({ min: 1, max: 64 })),
  diskReserveBytes: nullable(integer({ min: 0 })),
  sessionMemoryBytes: nullable(integer({ min: 1 })),
});
const nodeFields = {
  peer: object({ listen: text(), address: text() }),
  rtc: object({ ports: nullable(text()), address: nullable(text()) }),
  limits,
};
const nodeOptional = { media: object({}, mediaFields) };
import { union } from './persistence/codec';
const node = union(
  object({ ...nodeFields, local: object({ root: text() }, { executable: text() }) }, nodeOptional),
  object({ ...nodeFields, remote: object({ control: text() }) }, nodeOptional),
);
const mailServer = object({ host: text(), port, user: text(), password: text() });
export const configDocument = object(
  {
    version: literal(1),
    http: object(
      { listen: text(), origins: array(text(), { max: 256 }) },
      { tls: object({ key: text(), cert: text() }) },
    ),
    storage: object({ database: text(), diagnostics: text(), logs: text() }),
    media: object(mediaFields),
    quotas: object({ tenantObjectBytes: nullable(integer({ min: 1 })) }),
    nodes: record(node),
  },
  {
    sessionImport: object({
      mailbox: text(),
      imap: mailServer,
      smtp: mailServer,
      appMailbox: text(),
      folder: text(),
      pollSeconds: integer({ min: 15, max: 3600 }),
      replyWindowSeconds: integer({ min: 0, max: 600 }),
    }),
  },
);
export const nodeBootstrap = object(
  {
    version: literal(1),
    nodeId: string({ pattern: /^[a-z0-9][a-z0-9-]{0,62}$/ }),
    privateKey: key,
    controlPublicKey: key,
  },
  { control: text() },
);
export const controlKey = object({ version: literal(1), privateKey: key });
export type NodeBootstrap = import('./persistence/codec').Decoded<typeof nodeBootstrap>;

export function decodeConfigFile<T>(text: string, codec: Codec<T>, name: 'control' | 'node' | 'key'): T {
  const migrated: Codec<T> = {
    read(value, path) {
      return codec.read(migrateConfig(name, value), path);
    },
  };
  return decodeState(text, migrated, name);
}
export function encodeConfigFile<T>(value: NoInfer<T>, codec: Codec<T>, name: string): string {
  return encodeState(value, codec, name) + '\n';
}
