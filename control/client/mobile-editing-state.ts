import type { Surface } from './types';

export interface EditableView { session: string; id: string; instance: string; document: string; focus: string }
export interface RemoteEditable {
  type: number; flags: number; active: boolean;
  selectionStart: number; selectionEnd: number; compositionStart: number; compositionEnd: number;
  caretX: number; caretY: number; caretWidth: number; caretHeight: number;
}
export interface EditableMessage { type: 'input.editable'; version: 1; revision: string; view: EditableView | null; editable: RemoteEditable }
export function sameEditableView(a: EditableView, b: EditableView) {
  return a.session === b.session && a.id === b.id && a.instance === b.instance && a.document === b.document && a.focus === b.focus;
}
export function editableOwner(view: EditableView) { return JSON.stringify([view.session, view.id, view.instance, view.document, view.focus]); }
/** ui/base/ime/text_input_type.h in the pinned Chromium SDK. No surrounding text is transferred. */
export function editableInputMode(type: number): 'none' | 'text' | 'search' | 'email' | 'decimal' | 'tel' | 'url' {
  if (!Number.isInteger(type) || type <= 0 || type > 17) return 'none';
  return ({ 3: 'search', 4: 'email', 5: 'decimal', 6: 'tel', 7: 'url' } as const)[type as 3] ?? 'text';
}
function validMessage(value: unknown): value is EditableMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as EditableMessage;
  if (v.type !== 'input.editable' || v.version !== 1 || typeof v.revision !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v.revision)) return false;
  if (v.view !== null && (!v.view || !['session', 'id', 'instance', 'document', 'focus'].every(key => typeof v.view![key as keyof EditableView] === 'string'))) return false;
  const e = v.editable;
  return !!e && typeof e.active === 'boolean' && Number.isInteger(e.type) && e.type >= 0 && e.type <= 17 &&
    Number.isInteger(e.flags) && ['selectionStart', 'selectionEnd', 'compositionStart', 'compositionEnd', 'caretX', 'caretY', 'caretWidth', 'caretHeight'].every(key => Number.isFinite(e[key as keyof RemoteEditable]));
}
/** One ordered global editable owner per peer. Layout/media readiness is deliberately separate. */
export class MobileEditingState {
  private revision?: string;
  private candidate?: { message: EditableMessage; expires: number };
  current?: EditableMessage;
  receive(value: unknown, views: readonly Surface[], now = Date.now()): boolean {
    if (!validMessage(value)) return false;
    if (this.revision !== undefined && (value.revision.length < this.revision.length || value.revision.length === this.revision.length && value.revision <= this.revision)) return false;
    this.revision = value.revision;
    this.candidate = undefined;
    this.current = undefined;
    // Consume the watermark even for a message whose old document is gone.
    if (value.view && !views.some(view => sameEditableView(view, value.view!))) {
      if (views.some(view => view.session === value.view!.session && view.id === value.view!.id && view.instance === value.view!.instance && view.document === value.view!.document)) {
        // focus ACK and editable feedback are independent ordered messages.
        // Retain only the newest candidate briefly, never apply its token.
        this.candidate = { message: value, expires: now + 1500 };
      }
      return true;
    }
    this.current = value;
    return true;
  }
  reconcile(views: readonly Surface[], now = Date.now()) {
    if (this.current?.view && !views.some(view => sameEditableView(view, this.current!.view!))) this.current = undefined;
    const candidate = this.candidate;
    if (!candidate) return;
    const view = candidate.message.view!;
    if (now >= candidate.expires || !views.some(next => next.session === view.session && next.id === view.id && next.instance === view.instance && next.document === view.document)) this.candidate = undefined;
    else if (views.some(next => sameEditableView(next, view))) { this.current = candidate.message; this.candidate = undefined; }
  }
  forView(view: Surface | undefined) {
    const value = this.current;
    return view && value?.view && sameEditableView(view, value.view) && value.editable.active && editableInputMode(value.editable.type) !== 'none' ? value : undefined;
  }
  clear() { this.current = undefined; this.candidate = undefined; }
  reset() { this.clear(); this.revision = undefined; }
}

/** Layout barriers may pause IME delivery without changing its document owner. */
export class DeferredEditingInput {
  private owner?: string;
  private expires = 0;
  private events: Record<string, unknown>[] = [];
  get pending() { return this.events.length > 0; }
  enqueue(owner: string, event: Record<string, unknown>, now = Date.now()) {
    if (this.owner !== owner) { this.clear(); this.owner = owner; this.expires = now + 3000; }
    if (now >= this.expires) { this.clear(); return false; }
    const next = [...this.events];
    if (event.type === 'ime_set' && next[next.length - 1]?.type === 'ime_set') next[next.length - 1] = event;
    else next.push(event);
    if (next.length > 32 || next.reduce((sum, value) => sum + (typeof value.text === 'string' ? value.text.length * 2 : 0), 0) > 65536) return false;
    this.events = next; return true;
  }
  drain(owner: string, now = Date.now()) { const events = this.owner === owner && now < this.expires ? this.events : []; this.clear(); return events; }
  clear() { this.owner = undefined; this.events = []; this.expires = 0; }
}
