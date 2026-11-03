import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatsOverlay } from '../client/stats-overlay';
import type { Diagnostics } from '../client/types';

function overlay(reason: string) {
  const diagnostics: Diagnostics = { connection: '已连接', channel: '已连接', rendering: {
    backend: 'canvas-2d', backendReason: reason, presentationFallbackReason: reason,
    canvasBackendReason: 'single-or-no-eligible-plane', shared: {}, plane2dDraws: 1,
    atlasSnapshotCopies: 0, mediaRefreshRequests: 0, scheduling: { metadataMissingAtRead: 0,
      metadataBlockedSchedules: 0, drops: {}, readToAuthorizeMs: { samples: 0, p50: null, p95: null },
      rafWaitMs: { samples: 0, p50: null, p95: null } },
  } };
  return renderToStaticMarkup(createElement(StatsOverlay, { diagnostics }));
}

test('video fallback and canvas choice have separate visible explanations', () => {
  const html = overlay('video-frame-metadata-timeout');
  assert.match(html, /Video 帧元数据匹配超时/);
  assert.match(html, /单平面 \/ 等待平面/);
  assert.doesNotMatch(html, /GL 初始化失败/);
});

test('unknown presentation fallback retains the actual reason', () => {
  const html = overlay('future-video-failure');
  assert.match(html, />future-video-failure</);
  assert.doesNotMatch(html, /GL 初始化失败/);
});
