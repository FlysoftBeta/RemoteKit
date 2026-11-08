import assert from 'node:assert/strict';
import test from 'node:test';
import { providerEndpoint } from '../server/learning/providers/endpoint';

test('provider endpoints can be replaced only in test runs', (t) => {
  const environment = { ...process.env };
  t.after(() => {
    for (const name of ['NODE_ENV', 'REMOTEKIT_TEST_LEARNING_ENDPOINTS']) {
      if (environment[name] === undefined) delete process.env[name];
      else process.env[name] = environment[name];
    }
  });
  process.env.REMOTEKIT_TEST_LEARNING_ENDPOINTS = JSON.stringify({
    'https://open.changyan.com': 'http://127.0.0.1:12345',
  });
  const url = 'https://open.changyan.com/sso/v1/api?test=1';
  for (const mode of ['development', 'production']) {
    process.env.NODE_ENV = mode;
    assert.equal(providerEndpoint(url), url);
  }
  process.env.NODE_ENV = 'test';
  assert.equal(providerEndpoint(url), 'http://127.0.0.1:12345/sso/v1/api?test=1');
  assert.equal(providerEndpoint('https://other.example/path'), 'https://other.example/path');
});
