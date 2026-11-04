import { keyIdentity } from './keys';

export const EDITOR_SENTINEL = '\u200b';
export function editingKey(key: string, action: 'down' | 'up', modifiers = 0) {
  return { type: 'key', action, ...keyIdentity(key, key), windows_key_code: key === 'Enter' ? 13 : key === 'Backspace' ? 8 : 46,
    modifiers, repeat: false, text: action === 'down' && key === 'Enter' ? '\r' : '', unmodified_text: action === 'down' && key === 'Enter' ? '\r' : '' };
}
/** Local editor ownership deliberately survives same-document layout changes. */
export class EditingInput {
  private owner?: string;
  private composition?: { owner: string; text: string };
  private committed?: { text: string; at: number };
  private physical?: { key: string; at: number };
  private before?: { type: string; data: string | null; at: number };
  get composing() { return this.composition !== undefined; }
  focus(owner: string) { if (owner !== this.owner) { this.invalidate(); this.owner = owner; } }
  matches(owner: string | undefined) { return owner !== undefined && this.owner === owner; }
  invalidate() { this.owner = undefined; this.composition = undefined; this.committed = undefined; this.physical = undefined; this.before = undefined; }
  start(owner: string | undefined) {
    if (owner === undefined || !this.matches(owner)) return false;
    this.composition = { owner, text: '' };
    return true;
  }
  update(owner: string | undefined, text: string) {
    if (!this.composition || this.composition.owner !== owner) return;
    this.composition.text = text;
    return { type: 'ime_set', text, selection_start: text.length, selection_end: text.length };
  }
  end(owner: string | undefined, text: string, at: number) {
    if (!this.composition || this.composition.owner !== owner) return;
    this.composition = undefined; this.committed = { text, at };
    return { type: 'ime_commit', text };
  }
  finishCurrent(owner: string | undefined, at: number) {
    if (!this.composition) return;
    return this.end(owner, this.composition.text, at);
  }
  physicalKey(key: string, at: number) { this.physical = { key, at }; this.committed = undefined; }
  releasePhysicalKey(key: string) { if (this.physical?.key === key) this.physical = undefined; }
  /** beforeinput is authoritative when available; input remains the Chrome89 fallback. */
  edit(owner: string | undefined, type: string, data: string | null, at: number, phase: 'before' | 'input'): { events: Record<string, unknown>[]; unsupported?: string } {
    if (!this.matches(owner) || this.composing || type === 'insertCompositionText' || type === 'insertFromComposition' || type === 'deleteCompositionText') return { events: [] };
    if (phase === 'input' && this.before?.type === type && this.before.data === data && at - this.before.at < 1000) { this.before = undefined; return { events: [] }; }
    if (phase === 'before') this.before = { type, data, at };
    if (phase === 'input' && this.committed) { const duplicate = at - this.committed.at < 100 && data === this.committed.text; this.committed = undefined; if (duplicate) return { events: [] }; }
    const key = type === 'deleteContentBackward' ? 'Backspace' : type === 'deleteContentForward' ? 'Delete' : type === 'insertLineBreak' || type === 'insertParagraph' ? 'Enter' : undefined;
    if (key) {
      if (this.physical?.key === key && at - this.physical.at < 1000) { this.physical = undefined; return { events: [] }; }
      return { events: [editingKey(key, 'down'), editingKey(key, 'up')] };
    }
    // The proxy has no surrounding text or remote replacement range. Never
    // silently turn autocorrect/replacement into an append operation.
    if (type === 'insertReplacementText' || type.startsWith('delete') || type.startsWith('history')) return { events: [], unsupported: type };
    if (type === 'insertText' || type === 'insertFromPaste' || type === 'insertFromDrop' || type === 'insertFromDictation' || !type) return { events: data ? [{ type: 'ime_commit', text: data }] : [] };
    return { events: [], ...(type ? { unsupported: type } : {}) };
  }
}
