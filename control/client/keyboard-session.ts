export const EDITOR_BLUR_GRACE_MS = 200;
export type EditorObservation = 'unknown' | 'active' | 'inactive';
export interface KeyboardContext {
  document?: string;
  enabled: boolean;
  manual: boolean;
  editor: EditorObservation;
  focused: boolean;
  ready: boolean;
  now: number;
}
export interface KeyboardCommand { open?: true; close?: 'boundary' | 'editor-lost' }

/** User intent, DOM attachment and viewport occlusion are independent axes.
 * Only activation/policy/document events arm an open. Media recovery never does.
 * Unknown remote state is not a blur; an authoritative NONE revokes input at once
 * and allows only a short visual grace for a same-document DOM replacement.
 */
export class KeyboardSession {
  private context?: KeyboardContext;
  private intent: 'armed' | 'attached' | 'dismissed' = 'dismissed';
  private missingUntil?: number;
  private explicitlyRequested = false;
  private systemHidden = false;
  get deadline() { return this.missingUntil; }

  observe(next: KeyboardContext): KeyboardCommand {
    const previous = this.context;
    const boundary = previous?.document !== next.document || previous?.enabled && !next.enabled;
    const enteredManual = next.manual && !previous?.manual;
    if (previous?.document !== next.document) {
      this.intent = next.document ? 'armed' : 'dismissed';
      this.missingUntil = undefined;
      this.explicitlyRequested = this.systemHidden = false;
    }
    if (!next.enabled || enteredManual) this.dismiss();
    else if (previous?.manual && !next.manual) this.intent = 'armed';
    this.context = next;
    if (boundary || enteredManual) {
      this.missingUntil = undefined;
      if (next.focused) return { close: 'boundary' };
    }
    if (next.editor === 'inactive' && previous?.editor !== 'inactive' && next.focused)
      this.missingUntil = next.now + EDITOR_BLUR_GRACE_MS;
    if (this.missingUntil !== undefined && next.now >= this.missingUntil) {
      this.dismiss();
      return next.focused ? { close: next.editor === 'inactive' ? 'editor-lost' : 'boundary' } : {};
    }
    if (next.editor === 'active') this.missingUntil = undefined;
    return this.openIfReady();
  }

  activate(explicit = false): KeyboardCommand {
    const c = this.context;
    if (!c?.document || !c.enabled || c.manual && !explicit) return {};
    this.intent = 'armed';
    this.explicitlyRequested = explicit;
    this.systemHidden = false;
    return this.openIfReady(explicit);
  }
  private openIfReady(explicit = false): KeyboardCommand {
    const c = this.context;
    if (!c?.enabled || c.editor !== 'active' || !c.ready || c.manual && !explicit || this.intent !== 'armed') return {};
    // Consume even if the OS rejects the focus request. A render is not a retry.
    this.intent = 'attached';
    return { open: true };
  }
  attached(explicit: boolean) { this.intent = 'attached'; this.explicitlyRequested = explicit; this.systemHidden = false; }
  dismiss() { this.intent = 'dismissed'; this.missingUntil = undefined; this.explicitlyRequested = false; }
  systemDismissed() { this.dismiss(); this.systemHidden = true; }
  shown(focused: boolean, occluded: boolean, coarse: boolean) {
    return focused && (occluded || !this.systemHidden && (!coarse || this.explicitlyRequested));
  }
}
