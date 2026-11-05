export const KEYBOARD_FOCUS_GRACE_MS = 200;

/** One automatic open per document or direct activation, independent of the editor target. */
export class KeyboardVisibility {
  private document?: string;
  private enabled = false;
  private manual = false;
  private permission = false;
  private editable = false;
  private missingUntil?: number;

  get deadline() { return this.missingUntil; }

  sync(document: string | undefined, enabled: boolean, manual: boolean, editable: boolean, focused: boolean, now: number) {
    const replaced = document !== this.document;
    const disabled = this.enabled && !enabled;
    const enteredManual = manual && !this.manual;
    if (replaced || this.manual && !manual) this.permission = !!document;
    if (disabled || enteredManual) this.permission = false;
    this.document = document;
    this.enabled = enabled;
    this.manual = manual;

    if (replaced || !enabled || enteredManual) this.missingUntil = undefined;
    else if (!editable && this.editable && focused) this.missingUntil = now + KEYBOARD_FOCUS_GRACE_MS;
    this.editable = editable;

    if (!enabled || replaced || enteredManual) return focused && 'boundary';
    if (this.missingUntil !== undefined && now >= this.missingUntil) {
      this.dismiss();
      return focused && (editable ? 'boundary' : 'editor-lost');
    }
    if (editable) this.missingUntil = undefined;
    return false;
  }

  activate() { if (this.document && !this.manual) this.permission = true; }
  takeAutoAttempt(ready: boolean) {
    if (!ready || !this.editable || !this.enabled || this.manual || !this.permission) return false;
    this.permission = false;
    return true;
  }

  dismiss() {
    this.permission = false;
    this.missingUntil = undefined;
  }
}
