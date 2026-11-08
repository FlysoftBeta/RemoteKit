import { createDecipheriv, createHash } from 'node:crypto';

export const CLIENT = 'front';
export const AES_KEY = '6f0c5ba452b24fa28989e9524d77407a';

export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
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
