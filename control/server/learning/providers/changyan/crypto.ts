import { constants, createHmac, createPublicKey, publicEncrypt } from 'node:crypto';

const SSO_RSA_MODULUS_HEX =
  'ccd806a03c7391ee8f884f5902102d95f6d534d597ac42219dd8a79b1465e186c0162a6771b55e7be7422c4af494ba0112ede4eb00fc751723f2c235ca419876e7103ea904c29522b72d754f66ff1958098396f17c6cd2c9446e8c2bb5f4000a9c1c6577236a57e270bef07e7fe7bbec1f0e8993734c8bd4750e01feb21b6dc9';

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

/** R2/P: reverse the password, then RSA/PKCS#1 v1.5, lowercase hex. */
export function encryptPassword(password: string): string {
  const modulus = Buffer.from(SSO_RSA_MODULUS_HEX, 'hex');
  const key = createPublicKey({
    key: { kty: 'RSA', n: base64url(modulus), e: 'AQAB' },
    format: 'jwk',
  });
  const reversed = Array.from(password).reverse().join('');
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(reversed, 'utf8')).toString(
    'hex',
  );
}

export function gatewaySignatureWithAppId(
  appSecret: string,
  appId: string,
  pathWithQuery: string,
  nonce: string,
  timestamp: string,
  randomKey = '',
  contentMd5 = '',
): string {
  const source = [pathWithQuery, randomKey, nonce, timestamp, appId, contentMd5].filter(Boolean).join('|');
  return createHmac('sha256', appSecret).update(source, 'utf8').digest('base64');
}
