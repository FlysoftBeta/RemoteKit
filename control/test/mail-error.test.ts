import test from 'node:test';
import assert from 'node:assert/strict';
import { mailError } from '../server/session-import/mail-error';
import { RemoteKitError } from '../shared/errors';

test('mailbox authentication failures do not expire the Control session', () => {
  for (const error of [
    { code: 'EAUTH' },
    { authenticationFailed: true },
    { serverResponseCode: 'AUTHENTICATIONFAILED' },
    { responseCode: 535 },
    { responseCode: 530 },
    new RemoteKitError('unauthenticated', 'Mailbox session expired'),
  ]) {
    for (const sending of [false, true]) assert.equal(mailError(error, sending).code, 'forbidden');
  }
  const unavailable = new RemoteKitError('unavailable', 'Mailbox offline');
  assert.equal(mailError(unavailable, false), unavailable);
});
