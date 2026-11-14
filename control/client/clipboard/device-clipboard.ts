import { diagnostics } from '../media/diagnostics';
import { RetryUnit } from '../../shared/retry-unit';

export function clipboardTextHash(text: string) {
  let a = 2166136261,
    b = 2246822519,
    c = 3266489917,
    d = 668265263;
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    a = Math.imul(a ^ value, 16777619);
    b = Math.imul(b ^ value, 2246822519);
    c = Math.imul(c ^ value, 3266489917);
    d = Math.imul(d ^ value, 668265263);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}:${c >>> 0}:${d >>> 0}`;
}

export interface DeviceClipboardPort {
  focused(): boolean;
  read(): Promise<string>;
  write(text: string): Promise<void>;
  granted(): Promise<boolean>;
  failed(): void;
}

export class DeviceClipboardSync {
  get failure() {
    return this.inbound.error ?? this.outbound.error ?? this.reading.error;
  }
  private readonly inbound = new RetryUnit({ name: 'clipboard.inbound' });
  private readonly outbound = new RetryUnit({ name: 'clipboard.outbound' });
  private readonly reading = new RetryUnit({ name: 'clipboard.read' });
  private focusInput = 0;
  private enabled = false;
  private scope?: string;
  private generation = 0;
  private lastHash?: string;
  private revision?: bigint;
  private pending?: { text: string; revision: string };
  private flushing?: Promise<void>;
  private sending: Promise<void> = Promise.resolve();
  private set?: (text: string) => Promise<{ revision: string }>;
  private applied?: (revision: string) => Promise<unknown>;

  constructor(private readonly port: DeviceClipboardPort) {}

  configure(
    scope: string | undefined,
    enabled: boolean,
    set: (text: string) => Promise<{ revision: string }>,
    applied?: (revision: string) => Promise<unknown>,
  ) {
    const activated = enabled && !!scope && (!this.enabled || scope !== this.scope);
    if (scope !== this.scope || enabled !== this.enabled) {
      this.inbound.cancel();
      this.outbound.cancel();
      this.reading.cancel();
      this.generation++;
      this.pending = undefined;
      this.lastHash = undefined;
      this.revision = undefined;
    }
    this.scope = scope;
    this.enabled = enabled && !!scope;
    this.set = set;
    this.applied = applied;
    if (activated) void this.focus();
  }

  receive(value: { revision: string; text: string }) {
    if (!this.enabled) return;
    const revision = BigInt(value.revision);
    if (this.revision !== undefined && revision < this.revision) return;
    this.revision = revision;
    this.lastHash = clipboardTextHash(value.text);
    this.pending = value;
    void this.flush();
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.enabled || !this.pending || !this.port.focused()) return Promise.resolve();
    this.flushing = (async () => {
      while (this.enabled && this.pending && this.port.focused()) {
        const value = this.pending;
        if (!this.inbound.ready(JSON.stringify([this.generation, value.revision, this.focusInput]))) break;
        try {
          await this.port.write(value.text);
          this.inbound.succeed();
          if (this.pending === value) this.pending = undefined;
        } catch (cause) {
          this.inbound.fail(cause);
          this.port.failed();
          break;
        }
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  send(text: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const generation = this.generation;
    const work = this.sending.then(async () => {
      if (!this.enabled || generation !== this.generation) return;
      const hash = clipboardTextHash(text);
      if (hash === this.lastHash) return;
      if (!this.outbound.ready(JSON.stringify([generation, hash, this.focusInput])))
        throw this.outbound.error;
      let value;
      try {
        value = await this.set!(text);
        this.outbound.succeed();
      } catch (cause) {
        this.outbound.fail(cause);
        throw cause;
      }
      const revision = BigInt(value.revision);
      if (generation === this.generation && (this.revision === undefined || revision >= this.revision)) {
        this.revision = revision;
        this.lastHash = hash;
      }
    });
    this.sending = work.catch(() => this.port.failed());
    return work;
  }

  focus = async () => {
    if (!this.enabled || !this.port.focused()) return;
    return this.readFocused(this.generation, ++this.focusInput);
  };

  private async readFocused(generation: number, input: number) {
    if (!this.enabled || generation !== this.generation || input !== this.focusInput || !this.port.focused())
      return;
    if (!this.reading.ready(JSON.stringify([generation, input]))) return;
    try {
      await this.flush();
      if (this.pending) return;
      if (!(await this.port.granted()) || generation !== this.generation || !this.port.focused()) return;
      const revision = this.revision;
      const text = await this.port.read();
      this.reading.succeed();
      if (generation === this.generation && revision === this.revision && !this.pending)
        await this.send(text);
    } catch (cause) {
      this.reading.fail(cause);
      this.port.failed();
      this.reading.schedule(() => {
        void this.readFocused(generation, input);
      });
    }
  }

  async readForPaste(allowPrompt = true) {
    if (!this.enabled) return;
    const generation = this.generation;
    let text: string;
    try {
      if (!allowPrompt && !(await this.port.granted())) return;
      text = await this.port.read();
    } catch {
      this.port.failed();
      return;
    }
    if (generation === this.generation) await this.send(text);
  }

  async preparePaste(text?: string) {
    if (!this.enabled) return;
    const generation = this.generation;
    if (text === undefined) await this.readForPaste();
    else await this.send(text);
    if (generation === this.generation && this.revision !== undefined)
      await this.applied?.(String(this.revision));
  }
}

export const deviceClipboard = new DeviceClipboardSync({
  focused: () => typeof document !== 'undefined' && document.hasFocus() && !document.hidden,
  read: () => navigator.clipboard.readText(),
  write: (text) => {
    if (!window.isSecureContext || !navigator.clipboard?.writeText) return Promise.resolve();
    return navigator.clipboard.writeText(text);
  },
  granted: async () => {
    if (!navigator.permissions?.query || !navigator.clipboard?.readText) return false;
    const permission = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    return permission.state === 'granted';
  },
  failed: () => diagnostics.record('clipboard-sync', 'Clipboard operation unavailable'),
});

export function clipboardCommand(command: string, send: () => void) {
  if (command !== 'paste') {
    send();
    return;
  }
  void deviceClipboard.preparePaste().then(send, () => {
    diagnostics.record('clipboard-sync', 'Clipboard operation unavailable');
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', deviceClipboard.focus);
  document.addEventListener('visibilitychange', deviceClipboard.focus);
}
