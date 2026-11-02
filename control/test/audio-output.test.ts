import test from 'node:test';
import assert from 'node:assert/strict';
import { stereoOpusOffer, ViewerAudioOutput } from '../client/audio-output';

test('stereo Opus modifies audio only and preserves codec parameters idempotently', () => {
  const video = 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e034\r\n';
  const audio = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;stereo=0;useinbandfec=1\r\n';
  const result = stereoOpusOffer(video+audio);
  assert.ok(result.startsWith(video)); assert.match(result, /minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1/);
  assert.equal(stereoOpusOffer(result), result);
  assert.match(stereoOpusOffer(audio.replace(/a=fmtp:[^\r]+\r\n/, '')), /a=fmtp:111 stereo=1;sprop-stereo=1\r\n/);
});

test('audio routing preserves stereo positions, mono upmix, and disconnect ownership', async () => {
  const savedContext = globalThis.AudioContext, savedStream = globalThis.MediaStream,savedDocument=globalThis.document;
  const nodes: any[] = []; let closed = 0;
  class Node {
    gain = { value: 1 }; connections: any[] = []; disconnected = false;
    constructor() { nodes.push(this); }
    connect(...args: any[]) { this.connections.push(args); } disconnect() { this.disconnected = true; }
  }
  class Context {
    state = 'suspended'; destination = new Node(); onstatechange: any;
    createMediaStreamSource() { return new Node(); } createGain() { return new Node(); }
    createChannelSplitter() { return new Node(); } createChannelMerger() { return new Node(); }
    async resume() { this.state = 'running'; } async close() { closed++; }
  }
  Object.assign(globalThis, { AudioContext: Context, MediaStream: class {},document:{createElement:()=>({paused:true,setAttribute(){},async play(){this.paused=false;},pause(){this.paused=true;},remove(){}})} });
  try {
    const output = new ViewerAudioOutput(() => {}), track: any = { readyState: 'live', stop() {} };
    output.setChannels({ left: false, right: true }); output.attach(track);
    assert.equal(output.state, 'blocked');
    assert.equal(nodes[2].channelCount, 2); assert.equal(nodes[2].channelCountMode, 'explicit');
    assert.equal(nodes[5].gain.value, 0); assert.equal(nodes[6].gain.value, 1);
    assert.deepEqual(nodes[5].connections[0].slice(1), [0,0]); assert.deepEqual(nodes[6].connections[0].slice(1), [0,1]);
    output.resume(); await Promise.resolve();await Promise.resolve();await Promise.resolve(); assert.equal(output.state, 'playing');
    output.detach(); assert.equal(closed, 1); assert.ok(nodes.slice(1).every(n => n.disconnected)); assert.equal(track.onended, null);
    assert.equal(output.state, 'unavailable');
  } finally { Object.assign(globalThis, { AudioContext: savedContext, MediaStream: savedStream,document:savedDocument }); }
});
