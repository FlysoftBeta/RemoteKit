import type { PenInput } from '../rtc/protocol';

export function penInput(event: PointerEvent): PenInput | undefined {
  if (event.pointerType !== 'pen') return;
  return {
    id: event.pointerId,
    pressure: event.buttons === 0 ? 0 : event.pressure,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    twist: typeof event.twist === 'number' ? event.twist : 0,
    eraser: event.button === 5 || (event.buttons & 32) !== 0,
  };
}
