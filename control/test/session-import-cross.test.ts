import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openMessage, sealMessage, parseDeviceMessage } from '../server/session-import/envelope';
import type { ControlEvent, ImportMessage } from '../shared/session-import';
import {
  controlPrivate,
  controlPublic,
  controlKeyId,
  devicePrivate,
  devicePublic,
  deviceKeyId,
  fixedKeys,
} from './session-import-fixture';
test('Control-to-device cross fixture matches and opens', () => {
  const message: ImportMessage<ControlEvent> = {
    v: 2,
    ack: 2,
    events: [
      { seq: 1, at: 1793900002000, type: 'paired', ref: 1, username: 'student' },
      {
        seq: 2,
        at: 1793900003000,
        type: 'importReceived',
        ref: 2,
        id: 'bf81f466-e992-48e5-a3d3-6b168556c471',
      },
      {
        seq: 3,
        at: 1793900004000,
        type: 'importApplied',
        ref: 2,
        id: 'bf81f466-e992-48e5-a3d3-6b168556c471',
        cookies: { applied: 1, rejected: 0 },
        localStorage: { applied: 1, rejected: 0 },
      },
    ],
  };
  const sealed = sealMessage(controlPrivate, controlPublic, devicePublic, message);
  assert.deepEqual(openMessage(devicePrivate, deviceKeyId, sealed).message, message);
  // Sealing is randomized, so the fixture is written once (delete it to regenerate) and
  // afterwards only checked against the current keys and message.
  const file = new URL('../../protocol/session-import/control-message-fixture.json', import.meta.url);
  if (!existsSync(file))
    writeFileSync(
      file,
      JSON.stringify({ ...fixedKeys, envelope: sealed.toString('base64'), message }, null, 4) + '\n',
    );
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(fixedKeys)) assert.equal(fixture[key], value, key);
  assert.deepEqual(fixture.message, message);
  const opened = openMessage(devicePrivate, deviceKeyId, Buffer.from(fixture.envelope, 'base64'));
  assert.equal(opened.senderKeyId, controlKeyId);
  assert.deepEqual(opened.senderPublic, controlPublic);
  assert.deepEqual(opened.message, message);
});
test('Control opens the device-to-Control fixture produced by the Android JVM test', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../protocol/session-import/device-message-fixture.json', import.meta.url),
      'utf8',
    ),
  );
  for (const [key, value] of Object.entries(fixedKeys)) assert.equal(fixture[key], value, key);
  const opened = openMessage(controlPrivate, controlKeyId, Buffer.from(fixture.envelope, 'base64'));
  assert.equal(opened.senderKeyId, deviceKeyId);
  assert.deepEqual(opened.message, fixture.message);
  assert.deepEqual(parseDeviceMessage(opened.message).message, fixture.message);
});
