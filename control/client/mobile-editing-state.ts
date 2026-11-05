import type { Layout, Surface } from './types';

export interface EditableView {
  session: string;
  id: string;
  instance: string;
  document: string;
  focus: string;
}
export interface RemoteEditable {
  type: number;
  flags: number;
  active: boolean;
  target: string;
  selectionStart: number;
  selectionEnd: number;
  compositionStart: number;
  compositionEnd: number;
  caretX: number;
  caretY: number;
  caretWidth: number;
  caretHeight: number;
}
export interface EditableMessage {
  type: 'input.editable';
  version: 1;
  revision: string;
  view: EditableView | null;
  editable: RemoteEditable;
}
function sameEditingDocument(a: EditableView, b: EditableView) {
  return a.session === b.session && a.id === b.id && a.instance === b.instance && a.document === b.document;
}
export function sameEditableView(a: EditableView, b: EditableView) {
  return sameEditingDocument(a, b) && a.focus === b.focus;
}
/** ui/base/ime/text_input_type.h in the pinned Chromium SDK. No surrounding text is transferred. */
export function editableInputMode(
  type: number,
): 'none' | 'text' | 'search' | 'email' | 'decimal' | 'tel' | 'url' {
  if (!Number.isInteger(type) || type <= 0 || type > 17) return 'none';
  return ({ 3: 'search', 4: 'email', 5: 'decimal', 6: 'tel', 7: 'url' } as const)[type as 3] ?? 'text';
}
function validMessage(value: unknown): value is EditableMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as EditableMessage;
  if (
    v.type !== 'input.editable' ||
    v.version !== 1 ||
    typeof v.revision !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(v.revision)
  )
    return false;
  if (
    v.view !== null &&
    (!v.view ||
      !['session', 'id', 'instance', 'document', 'focus'].every(
        (key) => typeof v.view![key as keyof EditableView] === 'string',
      ))
  )
    return false;
  const e = v.editable;
  return (
    !!e &&
    typeof e.active === 'boolean' &&
    typeof e.target === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(e.target) &&
    (e.active ? e.target !== '0' && v.view !== null : e.target === '0') &&
    Number.isInteger(e.type) &&
    e.type >= 0 &&
    e.type <= 17 &&
    Number.isInteger(e.flags) &&
    [
      'selectionStart',
      'selectionEnd',
      'compositionStart',
      'compositionEnd',
      'caretX',
      'caretY',
      'caretWidth',
      'caretHeight',
    ].every((key) => Number.isFinite(e[key as keyof RemoteEditable]))
  );
}
/** One ordered global editable owner per peer. Layout/media readiness is deliberately separate. */
export class MobileEditingState {
  // Document authority outlives media generations. generation=0 is an output
  // barrier (also used for hidden-tab changes), not a list of destroyed views.
  private documents: readonly Surface[] = [];
  layoutPending = false;
  get views() {
    return this.documents;
  }
  surface(id: string) {
    return this.documents.find((view) => view.id === id);
  }
  acceptLayout(layout: Layout) {
    if (layout.generation === '0' && !layout.views.length) {
      if (!this.layoutPending) this.suspendLayout();
      this.layoutPending = true;
    } else {
      this.documents = layout.views;
      this.layoutPending = false;
      this.reconcile(layout.views);
    }
  }
  private revision?: string;
  private candidate?: { message: EditableMessage; expires: number };
  private needsFresh = false;
  current?: EditableMessage;
  suspendLayout() {
    this.needsFresh = true;
    this.candidate = undefined;
  }
  receive(value: unknown, views: readonly Surface[], now = Date.now(), reconfiguring = false): boolean {
    if (!validMessage(value)) return false;
    if (
      this.revision !== undefined &&
      (value.revision.length < this.revision.length ||
        (value.revision.length === this.revision.length && value.revision <= this.revision))
    )
      return false;
    this.revision = value.revision;
    this.candidate = undefined;
    this.current = undefined;
    // Consume the watermark even for a message whose old document is gone.
    if (value.view && (reconfiguring || !views.some((view) => sameEditableView(view, value.view!)))) {
      if (views.some((view) => sameEditingDocument(view, value.view!))) {
        // focus ACK and editable feedback are independent ordered messages.
        // Retain only the newest candidate briefly, never apply its token.
        this.candidate = { message: value, expires: reconfiguring ? Infinity : now + 1500 };
        this.needsFresh = true;
      }
      return true;
    }
    this.current = value;
    this.needsFresh = false;
    return true;
  }
  reconcile(views: readonly Surface[], now = Date.now()) {
    const current = this.current?.view;
    if (current && !views.some((view) => sameEditableView(view, current))) {
      if (views.some((view) => sameEditingDocument(view, current))) this.needsFresh = true;
      else this.current = undefined;
    }
    const candidate = this.candidate;
    if (!candidate) return;
    const view = candidate.message.view!;
    if (now >= candidate.expires || !views.some((next) => sameEditingDocument(next, view)))
      this.candidate = undefined;
    else if (views.some((next) => sameEditableView(next, view))) {
      this.current = candidate.message;
      this.candidate = undefined;
      this.needsFresh = false;
    } else if (candidate.expires === Infinity) candidate.expires = now + 1500;
  }
  keyboardCandidateDeadline(view: Surface | undefined) {
    const candidate = this.candidate;
    return view &&
      candidate?.message.view &&
      sameEditingDocument(view, candidate.message.view) &&
      Number.isFinite(candidate.expires)
      ? candidate.expires
      : undefined;
  }
  keyboardObservation(view: Surface | undefined, now = Date.now()): 'active' | 'inactive' | 'unknown' {
    const value = this.candidate && now < this.candidate.expires ? this.candidate.message : this.current;
    if (!value) return 'unknown';
    return view &&
      value.view &&
      sameEditingDocument(view, value.view) &&
      value.editable.active &&
      editableInputMode(value.editable.type) !== 'none'
      ? 'active'
      : 'inactive';
  }
  forKeyboard(view: Surface | undefined, now = Date.now()) {
    const value = this.candidate && now < this.candidate.expires ? this.candidate.message : this.current;
    return view &&
      value?.view &&
      sameEditingDocument(view, value.view) &&
      value.editable.active &&
      editableInputMode(value.editable.type) !== 'none'
      ? value
      : undefined;
  }
  forView(view: Surface | undefined) {
    const value = this.current;
    return !this.needsFresh &&
      view &&
      value?.view &&
      sameEditableView(view, value.view) &&
      value.editable.active &&
      editableInputMode(value.editable.type) !== 'none'
      ? value
      : undefined;
  }
  clear() {
    this.current = undefined;
    this.candidate = undefined;
    this.needsFresh = false;
  }
  reset() {
    this.clear();
    this.revision = undefined;
    this.documents = [];
    this.layoutPending = false;
  }
}

/** Layout barriers may pause IME delivery without changing its document owner. */
export class DeferredEditingInput {
  private owner?: string;
  private expires = 0;
  private events: Record<string, unknown>[] = [];
  get pending() {
    return this.events.length > 0;
  }
  enqueue(owner: string, event: Record<string, unknown>, now = Date.now()) {
    if (this.owner !== owner) {
      this.clear();
      this.owner = owner;
      this.expires = now + 3000;
    }
    if (now >= this.expires) {
      this.clear();
      return false;
    }
    const next = [...this.events];
    if (event.type === 'ime_set' && next[next.length - 1]?.type === 'ime_set') next[next.length - 1] = event;
    else next.push(event);
    if (
      next.length > 32 ||
      next.reduce((sum, value) => sum + (typeof value.text === 'string' ? value.text.length * 2 : 0), 0) >
        65536
    )
      return false;
    this.events = next;
    return true;
  }
  drain(owner: string, now = Date.now()) {
    const events = this.owner === owner && now < this.expires ? this.events : [];
    this.clear();
    return events;
  }
  clear() {
    this.owner = undefined;
    this.events = [];
    this.expires = 0;
  }
}
