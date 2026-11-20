import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { LearningProvider } from '../../shared/learning';
import type { Sessions } from '../learning/accounts';
import type { AtRestKey } from '../auth/crypto';
import {
  array,
  number,
  integer,
  literal,
  object,
  corruptRecord,
  decodeJson,
  encodeJson,
  type Codec,
} from './codec';
import { changyanSession, xinjiaoyuSession } from './documents';

export const learningKeyInfo = 'remotekit learning account key 1';

export function decodeSealedRecord(value: unknown): Buffer {
  if (typeof value !== 'string') throw new Error('expected sealed base64 string');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 28 || bytes.toString('base64') !== value)
    throw new Error('expected canonical authenticated ciphertext');
  return bytes;
}

export function learningKey(master: Buffer) {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), learningKeyInfo, 32));
}
function sessionCodec<P extends LearningProvider>(provider: P): Codec<Sessions[P]> {
  return (provider === 'changyan' ? changyanSession : xinjiaoyuSession) as Codec<Sessions[P]>;
}
export function openLearningSession<P extends LearningProvider>(
  key: Buffer,
  tenant: string,
  provider: P,
  sealed: string,
): Sessions[P] {
  return openLearningDocument(key, tenant, provider, sealed, sessionCodec(provider));
}
export function openLearningDocument<T>(
  key: Buffer,
  tenant: string,
  provider: LearningProvider,
  sealed: string,
  codec: Codec<T>,
): T {
  const where = `learning_accounts.sealed ${tenant}/${provider}`;
  try {
    const bytes = decodeSealedRecord(sealed);
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([tenant, provider])));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return decodeJson(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      codec,
      where,
    );
  } catch (error) {
    throw corruptRecord(where, error);
  }
}

function validFaceTemplate(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 128 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(Math.sqrt(value.reduce((sum, n) => sum + n * n, 0)) - 1) < 1e-3
  );
}

export const faceTemplate: Codec<number[]> = {
  read(value, path) {
    const template = array(number()).read(value, path);
    if (!validFaceTemplate(template))
      throw new Error(`${path} expected normalized 128-dimensional face template`);
    return template;
  },
};

export interface FaceGallery {
  version: 2;
  templates: { source: 'enrolled' | 'learned'; vector: number[]; addedAt: number }[];
}

const galleryShape = object({
  version: literal(2),
  templates: array(
    object({
      source: literal('enrolled', 'learned'),
      vector: faceTemplate,
      addedAt: integer(),
    }),
    { min: 1, max: 9 },
  ),
});
const faceGallery: Codec<FaceGallery> = {
  read(value, path) {
    const gallery = galleryShape.read(value, path);
    const enrolled = gallery.templates.filter((entry) => entry.source === 'enrolled').length;
    if (enrolled < 1 || enrolled > 5 || gallery.templates.length - enrolled > 4)
      throw new Error(`${path} expected 1..5 enrolled and 0..4 learned templates`);
    return gallery;
  },
};

export function sealFaceGallery(key: AtRestKey, user: string, gallery: FaceGallery, modelVersion: string) {
  return key.seal(
    JSON.stringify([user, modelVersion]),
    Buffer.from(encodeJson(gallery, faceGallery, `user_security.face_ciphertext ${user}`)),
  );
}

export function openFaceGallery(key: AtRestKey, user: string, sealed: string, modelVersion: string) {
  try {
    return decodeJson(
      key.open(JSON.stringify([user, modelVersion]), sealed).toString(),
      faceGallery,
      `user_security.face_ciphertext ${user}`,
    );
  } catch (error) {
    throw corruptRecord(`user_security.face_ciphertext ${user}`, error);
  }
}
export function sealLearningSession<P extends LearningProvider>(
  key: Buffer,
  tenant: string,
  provider: P,
  session: Sessions[P],
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([tenant, provider])));
  const bytes = Buffer.concat([
    cipher.update(
      encodeJson(session, sessionCodec(provider), `learning_accounts.sealed ${tenant}/${provider}`),
    ),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
