import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openEnvelope } from '../server/session-import/envelope';
test('Control opens the envelope produced by the Android JVM implementation', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../protocol/session-import/envelope-fixture.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    openEnvelope(
      Buffer.from(fixture.recipientPrivate, 'base64url'),
      fixture.keyId,
      Buffer.from(fixture.envelope, 'base64'),
    ),
    fixture.payload,
  );
});
