import { createDecipheriv, createHash, randomInt } from 'node:crypto';

export const CLIENT = 'front';
export const AES_KEY = '6f0c5ba452b24fa28989e9524d77407a';
const SESSION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

export function createClientSession(now = Date.now()): string {
  let value = String(now);
  for (let index = 0; index < 10; index += 1) {
    value += SESSION_ALPHABET[randomInt(SESSION_ALPHABET.length)];
  }
  return value;
}

export function createHandshakeEncrypt(clientSessionId: string, timestamp: number): string {
  return md5(`${CLIENT}${clientSessionId}${timestamp}`);
}

export function createRequestEncrypt(safeCode: string, clientSessionId: string, timestamp: number): string {
  return md5(`${safeCode}${timestamp}${clientSessionId}${CLIENT}`);
}

export function decryptSafeCode(value: string): string {
  const decipher = createDecipheriv('aes-256-ecb', Buffer.from(AES_KEY, 'utf8'), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()]).toString('utf8');
}
