// Reports black presented frames from a schedlab run made with --probe black: each black run with
// its RTP range, decoded size and the size change or relay step around it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BLACK = 0.98;
const lines = (path) =>
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export function blackFrames(out) {
  const receiver = lines(join(out, 'receiver.jsonl'));
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const frames = receiver
    .filter((m) => m.type === 'probe')
    .flatMap((m) => m.frames.map((f) => ({ ...f, tenant: m.tenant })));
  const keyframes = new Set(
    receiver
      .filter((m) => m.type === 'frames')
      .flatMap((m) => m.frames.filter((f) => f.type === 'key').map((f) => f.rtpTimestamp)),
  );
  const result = { frames: frames.length, black: 0, runs: [], sizes: [] };
  const tenants = new Map();
  for (const frame of frames) {
    const state = tenants.get(frame.tenant) ?? {};
    tenants.set(frame.tenant, state);
    let { open, previous } = state;
    const size = `${frame.width}x${frame.height}`;
    if (!previous || size !== `${previous.width}x${previous.height}`)
      result.sizes.push({ tenant: frame.tenant, t: (frame.at - run.t0) / 1000, size });
    const black = frame.dark >= BLACK;
    if (black) {
      ++result.black;
      if (!open)
        result.runs.push(
          (open = {
            tenant: frame.tenant,
            t: Math.round(frame.at - run.t0) / 1000,
            frames: 0,
            durationMs: 0,
            firstRtp: frame.rtpTimestamp,
            size,
            keyframe: keyframes.has(frame.rtpTimestamp),
            before: previous && { size: `${previous.width}x${previous.height}`, mean: previous.mean },
          }),
        );
      ++open.frames;
      open.durationMs = Math.round(frame.at - (open.t * 1000 + run.t0));
      open.lastRtp = frame.rtpTimestamp;
    } else if (open) {
      open.after = { size, mean: frame.mean, rtpTimestamp: frame.rtpTimestamp };
      open = undefined;
    }
    previous = frame;
    Object.assign(state, { open, previous });
  }
  return result;
}
if (process.argv[2]) console.log(JSON.stringify(blackFrames(process.argv[2]), null, 2));
