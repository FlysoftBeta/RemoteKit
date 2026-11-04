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

test('media diagnostics distinguish GCC targets, display ceiling and compatibility playout hint', () => {
  const diagnostics: Diagnostics = { connection: '已连接', channel: '已连接',
    receiverPlayout: { video: { jitterBufferTargetSupported: false, jitterBufferTarget: null, playoutDelayHintSupported: true, playoutDelayHint: 0 } },
    endpoint: { gccTargetFps: 42, gccTargetBitrate: 12000000, queueFullDrops: 3, appliedFps: 240,
      mediaPolicy: { requested: { degradationPreference: 'balanced', maxFps: 60 }, applied: { degradationPreference: 'balanced', maxFps: 60 } } },
  };
  const html = renderToStaticMarkup(createElement(StatsOverlay, { diagnostics }));
  assert.match(html, /GCC 目标 FPS<\/dt><dd>42.0 fps/);
  assert.match(html, /GCC 目标码率<\/dt><dd>12.00 Mbps/);
  assert.match(html, /编码队列满丢帧<\/dt><dd>3/);
  assert.match(html, /60 \/ 60/); assert.match(html, /balanced/);
  assert.match(html, /兼容 hint 0 s/); assert.doesNotMatch(html, /240/);
});

test('video stats show real receiver intervals without retired capture or canvas rows', () => {
  const diagnostics: Diagnostics = {
    connection: '已连接', channel: '已连接', receiverVideoTiming: { jitterBufferMeanMs: 0, decodeMeanMs: 3, droppedFrames: 1 },
    endpoint: { sourceAtlasWidth: 1296, sourceAtlasHeight: 488 },
    rendering: { backend: 'video', shared: {}, plane2dDraws: 0, atlasSnapshotCopies: 0, mediaRefreshRequests: 0,
      scheduling: { metadataMissingAtRead: 0, metadataBlockedSchedules: 0, drops: {},
        readToAuthorizeMs: { samples: 0, p50: null, p95: null }, rafWaitMs: { samples: 0, p50: null, p95: null } } },
  };
  const html = renderToStaticMarkup(createElement(StatsOverlay, { diagnostics }));
  assert.match(html, /Video 提交 FPS/);
  assert.match(html, /接收缓冲均值<\/dt><dd>0.0 ms/);
  assert.match(html, /1296×488/);
  assert.doesNotMatch(html, /捕获完成|GPU copy|Metadata \/ 队列|Marker p50|末包→Video/);
});
