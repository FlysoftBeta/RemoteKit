import { RemoteKitError } from '../../shared/errors';
import type { ImportPairing } from '../../shared/session-import';
import { isImportToken } from './envelope';

export function buildPairingCode(pairing: ImportPairing): string {
  return 'RKP1:' + Buffer.from(JSON.stringify(pairing)).toString('base64url');
}
export function parsePairingCode(code: string): ImportPairing {
  try {
    if (!/^RKP1:[A-Za-z0-9_-]+$/.test(code)) throw new Error();
    const encoded = code.slice(5);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    const p = JSON.parse(bytes.toString('utf8')) as ImportPairing;
    if (
      p.v !== 1 ||
      ![p.server, p.user, p.mailbox].every((v) => typeof v === 'string' && v.length) ||
      !/^[0-9a-f]{16}$/.test(p.key.id) ||
      !isImportToken(p.key.x25519) ||
      !isImportToken(p.token)
    )
      throw new Error();
    const browser = p.browser;
    for (const field of [
      'userAgent',
      'platform',
      'platformVersion',
      'architecture',
      'bitness',
      'model',
    ] as const)
      if (typeof browser[field] !== 'string') throw new Error();
    if (typeof browser.wow64 !== 'boolean' || typeof browser.mobile !== 'boolean') throw new Error();
    for (const list of [browser.brands, browser.fullVersionList])
      if (
        !Array.isArray(list) ||
        !list.every((b) => typeof b.brand === 'string' && typeof b.version === 'string')
      )
        throw new Error();
    return p;
  } catch {
    throw new RemoteKitError('invalid_request', 'Invalid pairing code');
  }
}
