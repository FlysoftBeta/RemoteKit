import type { KeyboardLayoutMessage } from '../rtc/protocol';

interface KeyboardLayoutSource {
  getLayoutMap(): Promise<ReadonlyMap<string, string>>;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
}

export function keyboardLayoutMessage(map: ReadonlyMap<string, string>): KeyboardLayoutMessage {
  const entries: KeyboardLayoutMessage['entries'] = [];
  for (const [code, key] of map) {
    if (/^[A-Za-z0-9]{1,32}$/.test(code) && key.length >= 1 && key.length <= 4) entries.push([code, key]);
    if (entries.length === 256) break;
  }
  return { type: 'keyboard.layout', entries };
}

export class KeyboardLayout {
  private detach?: () => void;
  connect(
    send: (message: KeyboardLayoutMessage) => void,
    keyboard = typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { keyboard?: KeyboardLayoutSource }).keyboard,
  ) {
    this.disconnect();
    if (typeof keyboard?.getLayoutMap !== 'function') return;
    let active = true;
    let revision = 0;
    const update = async () => {
      const request = ++revision;
      try {
        const map = await keyboard.getLayoutMap();
        if (active && request === revision) send(keyboardLayoutMessage(map));
      } catch {
        active = false;
      }
    };
    keyboard.addEventListener?.('layoutchange', update);
    this.detach = () => {
      active = false;
      keyboard.removeEventListener?.('layoutchange', update);
    };
    void update();
  }
  disconnect() {
    this.detach?.();
    this.detach = undefined;
  }
}
