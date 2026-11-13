const tenant = Number(new URLSearchParams(location.search).get('tenant'));
const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/receiver?tenant=${tenant}`);
let batch = [];
function flush() {
  if (batch.length) send({ type: 'frames', frames: batch.splice(0) });
}
setInterval(flush, 250);
const peer = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
window.schedlab = { peer };
const send = (data) => socket.send(JSON.stringify({ ...data, tenant }));
const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
const codecs = RTCRtpReceiver.getCapabilities('video').codecs.filter(
  (codec) =>
    codec.mimeType.toLowerCase() === 'video/h264' &&
    /packetization-mode=1/.test(codec.sdpFmtpLine) &&
    /profile-level-id=42e0/i.test(codec.sdpFmtpLine),
);
if (!codecs.length) throw new Error('Constrained baseline H264 mode 1 unavailable');
transceiver.setCodecPreferences(codecs);
const streams = transceiver.receiver.createEncodedStreams();
streams.readable
  .pipeThrough(
    new TransformStream({
      transform(frame, controller) {
        batch.push({
          rtpTimestamp: frame.timestamp,
          type: frame.type,
          bytes: frame.data.byteLength,
          arrival: performance.timeOrigin + performance.now(),
        });
        controller.enqueue(frame);
      },
    }),
  )
  .pipeTo(streams.writable)
  .catch((error) => send({ type: 'receiverError', message: String(error) }));
function iceComplete() {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (peer.iceGatheringState !== 'complete') return;
      peer.removeEventListener('icegatheringstatechange', listener);
      resolve();
    };
    peer.addEventListener('icegatheringstatechange', listener);
  });
}
async function stats() {
  const report = await peer.getStats();
  const records = [...report.values()].filter((record) =>
    ['inbound-rtp', 'transport', 'codec', 'candidate-pair'].includes(record.type),
  );
  send({ type: 'stats', epochMs: performance.timeOrigin + performance.now(), records });
}
let timer;
function pollAt(epoch) {
  timer = setTimeout(
    async () => {
      try {
        await stats();
        pollAt(epoch + 1000);
      } catch (error) {
        send({ type: 'receiverError', message: String(error) });
      }
    },
    Math.max(0, epoch - (performance.timeOrigin + performance.now())),
  );
}
pollAt(Date.now() + 1000);
socket.onmessage = async ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === 'answer') await peer.setRemoteDescription({ type: 'answer', sdp: message.sdp });
  if (message.type === 't0') {
    clearTimeout(timer);
    pollAt(message.t0);
  }
  if (message.type === 'flush') {
    await stats();
    flush();
    send({ type: 'flushed' });
  }
  if (message.type === 'stop') {
    clearTimeout(timer);
    peer.close();
  }
};
socket.onopen = async () => {
  try {
    const offer = await peer.createOffer();
    // Keep the receiver level above both lab geometries at 60fps.
    offer.sdp = offer.sdp.replace(/profile-level-id=42e0[0-9a-f]{2}/gi, 'profile-level-id=42e034');
    await peer.setLocalDescription(offer);
    await iceComplete();
    send({ type: 'offer', sdp: peer.localDescription.sdp });
  } catch (error) {
    send({ type: 'receiverError', message: String(error) });
  }
};
