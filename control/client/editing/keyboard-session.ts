export const EDITOR_BLUR_GRACE_MS = 200;
export type EditorObservation = 'unknown' | 'active' | 'inactive';
export interface KeyboardContext {
  document?: string;
  enabled: boolean;
  autoOpen: boolean;
  editor: EditorObservation;
  revision: string;
  focusRevision: string;
  focusSource: 'pointer' | 'keyboard' | 'script' | 'other';
  focused: boolean;
  ready: boolean;
  now: number;
}
export interface KeyboardCommand {
  open?: true;
  close?: 'boundary' | 'editor-lost';
}

/** Document entry and enabling auto-open arm automatic focus; media recovery never does.
 * Taps always arm. With auto-open off, a tap has 1500 ms to observe fresh pointer focus;
 * after that observation it can wait indefinitely for frame and resize readiness.
 * Disabling auto-open dismisses only automatic arms and never closes an attachment.
 * Unknown remote state is not a blur; authoritative NONE allows a short visual grace
 * for same-document editor replacement. Document changes and disabling input close it.
 */
export class KeyboardSession {
  private context?: KeyboardContext;
  private intent: 'armed' | 'attached' | 'dismissed' = 'dismissed';
  private missingUntil?: number;
  private tapArmedUntil?: number;
  private tapArmed = false;
  private tapRevision = 0n;
  private pointerObserved = false;
  private explicitlyRequested = false;
  private systemHidden = false;
  get deadline() {
    const deadlines = [this.missingUntil, this.tapArmedUntil].filter((value) => value !== undefined);
    return deadlines.length ? Math.min(...deadlines) : undefined;
  }

  observe(next: KeyboardContext): KeyboardCommand {
    const previous = this.context;
    const boundary = previous?.document !== next.document || (previous?.enabled && !next.enabled);
    if (previous?.document !== next.document) {
      this.intent = next.document && next.autoOpen ? 'armed' : 'dismissed';
      this.tapArmed = false;
      this.tapArmedUntil = undefined;
      this.missingUntil = undefined;
      this.explicitlyRequested = this.systemHidden = false;
    }
    if (!next.enabled) this.dismiss();
    else if (previous && previous.document === next.document && next.document) {
      if (!previous.autoOpen && next.autoOpen) {
        this.intent = 'armed';
        this.tapArmed = false;
        this.tapArmedUntil = undefined;
      } else if (previous.autoOpen && !next.autoOpen && this.intent === 'armed' && !this.tapArmed)
        this.intent = 'dismissed';
    }
    if (this.tapArmedUntil !== undefined && next.now >= this.tapArmedUntil) this.dismiss();
    if (
      this.tapArmed &&
      next.editor === 'active' &&
      next.focusSource === 'pointer' &&
      BigInt(next.focusRevision) > this.tapRevision
    ) {
      this.pointerObserved = true;
      this.tapArmedUntil = undefined;
    }
    this.context = next;
    if (boundary) {
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

  activate(explicit = false, now = performance.now()): KeyboardCommand {
    const c = this.context;
    if (!c?.document || !c.enabled) return {};
    this.intent = 'armed';
    this.tapArmed = true;
    this.tapRevision = BigInt(c.revision);
    this.pointerObserved = false;
    this.tapArmedUntil = !c.autoOpen && !explicit ? now + 1500 : undefined;
    this.explicitlyRequested = explicit;
    this.systemHidden = false;
    return this.openIfReady();
  }
  private openIfReady(): KeyboardCommand {
    const c = this.context;
    if (!c?.enabled || c.editor !== 'active' || !c.ready || this.intent !== 'armed') return {};
    if (
      !c.autoOpen &&
      !this.explicitlyRequested &&
      (!this.pointerObserved || c.focusSource !== 'pointer' || BigInt(c.focusRevision) <= this.tapRevision)
    )
      return {};
    // Consume even if the OS rejects the focus request. A render is not a retry.
    this.intent = 'attached';
    this.tapArmedUntil = undefined;
    return { open: true };
  }
  attached(explicit: boolean) {
    this.intent = 'attached';
    this.tapArmedUntil = undefined;
    this.explicitlyRequested = explicit;
    this.systemHidden = false;
  }
  dismiss() {
    this.intent = 'dismissed';
    this.tapArmed = false;
    this.pointerObserved = false;
    this.tapArmedUntil = undefined;
    this.missingUntil = undefined;
    this.explicitlyRequested = false;
  }
  systemDismissed() {
    this.dismiss();
    this.systemHidden = true;
  }
  shown(focused: boolean, occluded: boolean, coarse: boolean) {
    return focused && (occluded || (!this.systemHidden && (!coarse || this.explicitlyRequested)));
  }
}
