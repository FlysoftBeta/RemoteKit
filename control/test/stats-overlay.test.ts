import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatsOverlay } from '../client/stats-overlay';
import type { Diagnostics } from '../client/types';

function overlay(reason: string) {
  const diagnostics: Diagnostics = { connection: '已连接', channel: '已连接', rendering: {
    backend: 'unavailable', backendReason: reason, freezeCopies: 0, mediaRefreshRequests: 0,
  } };
  return renderToStaticMarkup(createElement(StatsOverlay, { diagnostics }));
}

test('presentation errors explain why video is unavailable', () => {
  const html = overlay('video-rtp-metadata-unavailable');
  assert.match(html, /Video RTP 元数据不可用/);
  assert.match(html, /unavailable/);
  assert.doesNotMatch(html, /2D 原因|Video 回退/);
});

test('unknown presentation errors retain the actual reason', () => {
  assert.match(overlay('future-video-failure'), />future-video-failure</);
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
    rendering: { backend: 'video', freezeCopies: 0, mediaRefreshRequests: 0 },
  };
  const html = renderToStaticMarkup(createElement(StatsOverlay, { diagnostics }));
  assert.match(html, /Video 提交 FPS/);
  assert.match(html, /接收缓冲均值<\/dt><dd>0.0 ms/);
  assert.match(html, /1296×488/);
  assert.doesNotMatch(html, /捕获完成|GPU copy|Metadata \/ 队列|Marker p50|末包→Video/);
});
