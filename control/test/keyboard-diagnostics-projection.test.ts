import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticClientSample } from '../server/diagnostics/projection';

const steps = [
  'tap',
  'remote-focus',
  'candidate-focus',
  'open',
  'inputmode',
  'visual-viewport',
  'keyboard-detected',
  'occlusion-sent',
  'frame-height',
];

test('the keyboard timeline enters the diagnostic sample with its nine named steps', () => {
  const keyboard = [{ tapAtMs: 1234.5, steps: steps.map((step, index) => ({ step, atMs: index * 10.5 })) }];
  const projected = diagnosticClientSample({ input: { keyboard } }, new Set());
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), { input: { keyboard } });
});

test('a keyboard step outside the known names is dropped whole', () => {
  const projected = diagnosticClientSample(
    {
      input: {
        keyboard: [
          {
            tapAtMs: 5,
            steps: [
              { step: 'tap', atMs: 0 },
              { step: 'typed-secret', atMs: 3 },
              { step: 'open', atMs: 4 },
            ],
          },
        ],
      },
    },
    new Set(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), {
    input: {
      keyboard: [
        {
          tapAtMs: 5,
          steps: [
            { step: 'tap', atMs: 0 },
            { step: 'open', atMs: 4 },
          ],
        },
      ],
    },
  });
});

test('unlisted keyboard fields stay out of the sample', () => {
  const projected = diagnosticClientSample(
    {
      input: { keyboard: [{ tapAtMs: 1, text: 'hunter2', steps: [{ step: 'tap', atMs: 0, target: 'x' }] }] },
    },
    new Set(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), {
    input: { keyboard: [{ tapAtMs: 1, steps: [{ step: 'tap', atMs: 0 }] }] },
  });
});

test('the page request timeline enters the diagnostic sample as numbers only', () => {
  const pageRequests = [
    { stateAtMs: 10, stateWallMs: 1795000000000, renderedAtMs: 40, renderedWallMs: 1795000000030 },
  ];
  const projected = diagnosticClientSample(
    { input: { pageRequests: [{ ...pageRequests[0], id: 'secret', origin: 'https://x.test' }] } },
    new Set(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), { input: { pageRequests } });
});
