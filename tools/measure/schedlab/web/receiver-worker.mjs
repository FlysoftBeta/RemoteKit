let batch = [];
function flush() {
  if (batch.length) postMessage({ type: 'frames', frames: batch.splice(0) });
}
setInterval(flush, 250);
onmessage = ({ data }) => {
  if (data.type === 'flush') {
    flush();
    postMessage({ type: 'flushed' });
    return;
  }
};
onrtctransform = async ({ transformer }) => {
  const { readable, writable } = transformer;
  try {
    await readable
      .pipeThrough(
        new TransformStream({
          transform(frame, controller) {
            const observed = performance.timeOrigin + performance.now();
            const metadata = frame.getMetadata();
            const receiveTime = Number.isFinite(metadata.receiveTime)
              ? performance.timeOrigin + metadata.receiveTime
              : null;
            batch.push({
              rtpTimestamp: frame.timestamp,
              type: frame.type,
              bytes: frame.data.byteLength,
              observed,
              receiveTime,
              captureTime: Number.isFinite(metadata.captureTime)
                ? performance.timeOrigin + metadata.captureTime
                : null,
              senderCaptureTimeOffset: metadata.senderCaptureTimeOffset ?? null,
              arrival: receiveTime ?? observed,
            });
            controller.enqueue(frame);
          },
        }),
      )
      .pipeTo(writable);
  } catch (error) {
    postMessage({ type: 'receiverError', message: String(error) });
  }
};
