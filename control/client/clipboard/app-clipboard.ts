import type { SelectionClipboard } from '../selection/target';
import { deviceClipboard } from './device-clipboard';
import { RemoteKitError } from '../../shared/errors';

export class AppClipboard implements SelectionClipboard {
  private text = '';
  private revision = 0n;
  private scope?: string;
  private set?: (text: string) => Promise<{ revision: string }>;

  configure(scope: string | undefined, set: (text: string) => Promise<{ revision: string }>) {
    if (scope !== this.scope) {
      this.text = '';
      this.revision = 0n;
    }
    this.scope = scope;
    this.set = scope ? set : undefined;
  }

  receive(value: { revision: string; text: string }) {
    if (!this.scope || BigInt(value.revision) < this.revision) return;
    this.revision = BigInt(value.revision);
    this.text = value.text;
  }

  read() {
    return this.text;
  }

  async write(text: string) {
    if (!this.set) throw new RemoteKitError('unavailable', '剪贴板尚未连接');
    const scope = this.scope;
    const value = await this.set(text);
    if (scope !== this.scope) return;
    this.receive({ ...value, text });
    deviceClipboard.receive({ ...value, text });
  }
}

export const appClipboard = new AppClipboard();
