import type { InputPipeline } from '../input/input-pipeline';
import { keyIdentity, modifiers } from '../input/keys';
import type { PresentationSession } from '../presentation/presentation-session';
import { Store } from '../util/store';
import { EditingInput, EDITOR_SENTINEL } from './editing-input';
import type { EditingSession } from './editing-session';
import { KeyboardSession } from './keyboard-session';
import { DeferredEditingInput, editableInputMode } from './mobile-editing-state';
import { deviceClipboard } from '../clipboard/device-clipboard';
const pointerMedia = new WeakMap<Window, { coarse: MediaQueryList; fine: MediaQueryList }>();
function pointerQueries() {
  let queries = pointerMedia.get(window);
  if (!queries) {
    queries = { coarse: window.matchMedia('(pointer: coarse)'), fine: window.matchMedia('(pointer: fine)') };
    pointerMedia.set(window, queries);
  }
  return queries;
}
export interface EditingViewPorts {
  input: Pick<InputPipeline, 'sendInput' | 'ensureInputFocus' | 'focus' | 'inputIdentity' | 'getSnapshot'>;
  editing: Pick<EditingSession, 'mobileEditing' | 'editingSurface' | 'editingIdentity'>;
  presentation: Pick<PresentationSession, 'canInput'>;
}
export interface ResizeObservation {
  waiting: boolean;
  keyboardOpen: boolean;
  keyboardDismissals: number;
  blocksInput(): boolean;
}
export interface EditingViewSnapshot {
  error?: string;
  keyboardShown: boolean;
  keyboardReady: boolean;
  keyboardEnabled: boolean;
  observedOwner?: string;
}
export class EditingView extends Store<EditingViewSnapshot> {
  readonly editing = new EditingInput();
  private readonly deferredEditing = new DeferredEditingInput();
  private deferredEditingTimer?: ReturnType<typeof setTimeout>;
  private policyTimer?: ReturnType<typeof setTimeout>;
  private readonly heldKeys = new Map<string, Record<string, unknown>>();
  private restoreHardwareFocus?: string;
  private ackedEditingOwner?: string;
  private previousEditing?: { document?: string; owner?: string };
  private pointerFocus?: {
    identity: string;
    document: string;
    owner: string;
    focusRevision: string;
    revision: string;
  };
  private pointerSequence = 0;
  private readonly keyboardSession = new KeyboardSession();
  private softInputFocused = false;
  private suppressBlur = false;
  private systemDismissalSeen = 0;
  private error?: string;
  private enabled = true;
  private configured = false;
  private autoOpen = false;
  private resize: ResizeObservation = {
    waiting: false,
    keyboardOpen: false,
    keyboardDismissals: 0,
    blocksInput: () => false,
  };
  constructor(
    private readonly ports: EditingViewPorts,
    readonly viewId: string,
    private readonly editor: HTMLTextAreaElement,
  ) {
    super({ keyboardShown: false, keyboardReady: false, keyboardEnabled: false });
    this.resetEditor();
    editor.addEventListener('paste', this.paste);
    const queries = pointerQueries();
    queries.coarse.addEventListener?.('change', this.observe);
    queries.fine.addEventListener?.('change', this.observe);
  }
  configure(enabled: boolean, autoOpen: boolean, resize: ResizeObservation) {
    const changed =
      !this.configured ||
      this.enabled !== enabled ||
      this.autoOpen !== autoOpen ||
      this.resize.waiting !== resize.waiting ||
      this.resize.keyboardOpen !== resize.keyboardOpen ||
      this.resize.keyboardDismissals !== resize.keyboardDismissals ||
      this.resize.blocksInput() !== resize.blocksInput();
    this.configured = true;
    this.enabled = enabled;
    this.autoOpen = autoOpen;
    this.resize = resize;
    if (changed) this.observe();
  }
  get surface() {
    return this.ports.editing.editingSurface(this.viewId);
  }
  get editingSurface() {
    return this.ports.editing.editingSurface(this.viewId);
  }
  get editingIdentity() {
    return this.editingSurface && this.ports.editing.editingIdentity(this.editingSurface);
  }
  get keyboardEnabled() {
    return this.enabled && !!this.editingIdentity;
  }
  get remoteEditable() {
    return this.ports.editing.mobileEditing.forKeyboard(this.editingSurface);
  }
  get strictEditable() {
    return this.ports.editing.mobileEditing.forView(this.surface);
  }
  get editableTarget() {
    return this.remoteEditable?.editable.target;
  }
  get observedOwner() {
    return this.editableTarget && this.editingIdentity
      ? `${this.editingIdentity}/${this.editableTarget}`
      : undefined;
  }
  get editableReady() {
    return !!this.strictEditable && this.strictEditable.editable.target === this.editableTarget;
  }
  get remoteOwner() {
    return this.keyboardEnabled &&
      this.observedOwner &&
      (this.editableReady || this.observedOwner === this.ackedEditingOwner)
      ? this.observedOwner
      : undefined;
  }
  get editorOwner() {
    return (
      this.pointerFocus?.owner ??
      this.remoteOwner ??
      (this.keyboardEnabled && !this.remoteEditable && !this.softInputFocused
        ? this.editingIdentity
        : undefined)
    );
  }
  get keyboardReady() {
    return (
      this.keyboardEnabled && !!this.surface && this.frameReady && !this.resize.waiting && this.editableReady
    );
  }
  get coarsePointer() {
    return pointerQueries().coarse.matches;
  }
  get keyboardShown() {
    return this.keyboardSession.shown(this.softInputFocused, this.resize.keyboardOpen, this.coarsePointer);
  }
  get candidateDeadline() {
    return this.ports.editing.mobileEditing.keyboardCandidateDeadline(this.editingSurface);
  }
  get frameReady() {
    return !!this.ports.presentation.canInput(this.viewId);
  }
  private setError = (error?: string) => {
    this.error = error;
    this.changed();
  };
  private setFocused = (focused: boolean) => {
    this.softInputFocused = focused;
    this.changed();
  };
  private keyboardTick = (_?: unknown) => this.observe();
  private changed() {
    const next = {
      error: this.error,
      keyboardShown: this.keyboardShown,
      keyboardReady: this.keyboardReady,
      keyboardEnabled: this.keyboardEnabled,
      observedOwner: this.observedOwner,
    };
    const previous = this.getSnapshot();
    if (
      Object.keys(next).some(
        (key) => next[key as keyof EditingViewSnapshot] !== previous[key as keyof EditingViewSnapshot],
      )
    )
      this.publish(next);
  }
  observe = () => {
    clearTimeout(this.policyTimer);
    const pointer = this.pointerFocus;
    let transferred = false;
    if (pointer) {
      if (
        !this.keyboardEnabled ||
        pointer.document !== this.editingIdentity ||
        !this.surface ||
        pointer.identity !== this.ports.input.inputIdentity(this.surface) ||
        (BigInt(this.ports.editing.mobileEditing.current?.revision ?? '0') > BigInt(pointer.revision) &&
          this.ports.editing.mobileEditing.current?.editable.active === false) ||
        (this.remoteEditable &&
          BigInt(this.remoteEditable.editable.focusRevision) > BigInt(pointer.focusRevision) &&
          this.remoteEditable.editable.focusSource !== 'pointer')
      ) {
        this.pointerFocus = undefined;
        this.editing.invalidate();
      } else if (
        this.editableReady &&
        this.ports.input.getSnapshot().focus.phase === 'granted' &&
        this.remoteOwner &&
        this.strictEditable?.editable.focusSource === 'pointer' &&
        BigInt(this.strictEditable.editable.focusRevision) > BigInt(pointer.focusRevision)
      ) {
        this.pointerFocus = undefined;
        const composition = this.editing.transfer(pointer.owner, this.editorOwner!);
        transferred = true;
        if (composition) this.sendEdit(composition);
      }
    }
    this.changed();
    if (
      this.frameReady &&
      !this.resize.blocksInput() &&
      this.editableReady &&
      this.remoteOwner &&
      this.currentEditTarget() === this.editableTarget
    ) {
      clearTimeout(this.deferredEditingTimer);
      for (const event of this.deferredEditing.drain(this.remoteOwner))
        if (!this.send(event)) {
          this.setError('键盘输入暂未送达，请重新输入。');
          break;
        }
    }
    const previous = this.previousEditing;
    const replaced = previous && previous.document !== this.editingIdentity;
    if (replaced || !this.keyboardEnabled || (!transferred && previous?.owner !== this.editorOwner)) {
      clearTimeout(this.deferredEditingTimer);
      this.deferredEditing.clear();
      this.editing.invalidate();
      this.heldKeys.clear();
      if (!this.editing.composing) this.resetEditor();
    }
    if (replaced || !this.keyboardEnabled || this.observedOwner !== this.ackedEditingOwner) {
      this.ackedEditingOwner = undefined;
    }
    if (this.editableReady && this.remoteOwner) this.ackedEditingOwner = this.remoteOwner;
    this.previousEditing = { document: this.editingIdentity, owner: this.editorOwner };
    const node = this.editor;
    const focused = !!node && document.activeElement === node;

    const policy = this.keyboardSession;
    const observedDismissal = this.resize.keyboardDismissals !== this.systemDismissalSeen;
    this.systemDismissalSeen = this.resize.keyboardDismissals;
    const dismissedCurrentKeyboard = observedDismissal && !replaced && this.softInputFocused;
    if (dismissedCurrentKeyboard) {
      this.dismissRemoteEditable();
      policy.systemDismissed();
    }
    const now = performance.now();
    const command = policy.observe({
      document: this.editingIdentity,
      enabled: this.keyboardEnabled,
      autoOpen: this.autoOpen,
      editor: this.ports.editing.mobileEditing.keyboardObservation(this.editingSurface),
      revision: this.ports.editing.mobileEditing.current?.revision ?? '0',
      focusRevision: this.remoteEditable?.editable.focusRevision ?? '0',
      focusSource: this.remoteEditable?.editable.focusSource ?? 'other',
      focused: this.softInputFocused,
      ready: this.keyboardReady && !this.resize.blocksInput(),
      now,
    });
    const close = command.close;
    const restore = this.restoreHardwareFocus;
    this.restoreHardwareFocus = undefined;
    const closing = focused && (replaced || !this.keyboardEnabled || close);
    if (closing) {
      if (close === 'editor-lost' && !this.resize.keyboardOpen && pointerQueries().fine.matches)
        this.restoreHardwareFocus = this.editingIdentity;
      this.hideKeyboard(false);
    } else {
      // After a real remote blur, keep physical navigation available on a
      // desktop that was already routing keys to this same document.
      if (
        restore &&
        !replaced &&
        restore === this.editorOwner &&
        !this.remoteEditable &&
        document.activeElement === document.body
      )
        this.focusEditor(false);
      if (focused && this.editorOwner && node) {
        this.editing.focus(this.editorOwner);
        if (this.softInputFocused && this.remoteEditable && !this.editing.composing)
          node.inputMode = editableInputMode(this.remoteEditable.editable.type);
      }
      if (!dismissedCurrentKeyboard && command.open && !this.softInputFocused) this.focusEditor(true);
    }
    this.changed();
    const deadline = policy.deadline;
    const delay = Math.min(
      deadline === undefined ? Infinity : deadline - now,
      this.candidateDeadline === undefined ? Infinity : this.candidateDeadline - Date.now(),
    );
    if (!Number.isFinite(delay) || (delay <= 0 && deadline === undefined)) return;
    this.policyTimer = setTimeout(() => this.observe(), Math.max(1, Math.ceil(delay)));
  };
  release(endEditing = true) {
    for (const event of this.heldKeys.values())
      this.sendEdit({ ...event, action: 'up', repeat: false, text: '', unmodified_text: '' });
    this.heldKeys.clear();
    if (!endEditing) return;
    this.pointerFocus = undefined;
    if (this.editing.composing && this.editing.matches(this.editorOwner) && this.editableReady)
      this.send(this.withEditTarget({ type: 'ime_cancel' }));
    this.deferredEditing.clear();
    this.editing.invalidate();
    this.resetEditor();
    if (this.surface) this.ports.input.focus(this.surface, false);
    this.hideKeyboard();
  }
  dispose() {
    this.editor.removeEventListener('paste', this.paste);
    const queries = pointerQueries();
    queries.coarse.removeEventListener?.('change', this.observe);
    queries.fine.removeEventListener?.('change', this.observe);
    this.release();
    clearTimeout(this.policyTimer);
    clearTimeout(this.deferredEditingTimer);
    this.deferredEditing.clear();
  }
  onFocus = () => {
    if (this.surface && this.editorOwner && this.frameReady && !this.resize.blocksInput()) {
      this.editing.focus(this.editorOwner);
      if (!this.editing.composing) this.resetEditor();
      this.ports.input.ensureInputFocus(this.surface);
    }
  };
  onBlur = () => {
    if (this.suppressBlur) return;
    if (this.editor.inputMode !== 'none') this.keyboardSession.dismiss();
    this.setFocused(false);
    this.finishLocalEditing();
    this.editor.inputMode = 'none';
  };
  compositionStart = () => {
    if (document.activeElement === this.editor) this.editing.start(this.editorOwner);
  };
  compositionUpdate = (data: string) => {
    const event = this.editing.update(this.editorOwner, data);
    if (event) this.sendEdit(event);
  };
  compositionEnd = (data: string) => {
    const event = this.editing.end(this.editorOwner, data, performance.now());
    if (event) this.sendEdit(event);
    if (!this.editing.composing) this.resetEditor();
  };
  toggleKeyboard = () => {
    if (this.keyboardShown) this.dismissRemoteEditable();
    else if (this.surface && this.keyboardReady && !this.resize.blocksInput()) {
      this.keyboardSession.activate(true);
      this.focusEditor(true, true);
      this.ports.input.ensureInputFocus(this.surface);
    }
  };
  send = (event: Record<string, unknown>) => {
    return !!(
      this.surface &&
      ((this.frameReady && !this.resize.blocksInput()) ||
        (event.type === 'touch' && event.action === 'cancel')) &&
      this.ports.input.sendInput(this.surface, event)
    );
  };
  withEditTarget = (event: Record<string, unknown>) =>
    this.editableTarget ? { ...event, editableTarget: this.editableTarget } : event;
  sendEdit = (event: Record<string, unknown>) => {
    const pointer = this.pointerFocus;
    if (pointer) {
      if (
        !this.keyboardEnabled ||
        !this.surface ||
        pointer.document !== this.editingIdentity ||
        pointer.identity !== this.ports.input.inputIdentity(this.surface) ||
        !this.editing.matches(pointer.owner)
      )
        return;
      // Pointer and keys share the focus-lease queue. Until the editable node is
      // known, commit text as a character event instead of guessing its target.
      if (event.type === 'ime_commit') {
        for (const text of String(event.text)) {
          if (
            !this.send({
              type: 'key',
              action: 'char',
              ...keyIdentity('', text),
              windows_key_code: 0,
              repeat: false,
              text,
              unmodified_text: text,
              modifiers: 0,
            })
          ) {
            this.setError('键盘输入暂未送达，请重新输入。');
            break;
          }
        }
      } else if (event.type === 'key' && !this.send(event)) this.setError('键盘输入暂未送达，请重新输入。');
      return;
    }
    const target = this.currentEditTarget();
    if (
      !this.keyboardEnabled ||
      !this.editing.matches(this.editorOwner) ||
      (this.remoteOwner ? target !== this.editableTarget : target !== undefined || event.type !== 'key')
    )
      return;
    const value = this.withEditTarget(event);
    const waiting =
      !this.frameReady || this.resize.blocksInput() || (!!this.remoteOwner && !this.editableReady);
    if (!waiting && this.send(value)) return;
    const pending = this.deferredEditing.pending;
    if (this.remoteOwner && waiting && this.deferredEditing.enqueue(this.remoteOwner, value)) {
      if (!pending) {
        clearTimeout(this.deferredEditingTimer);
        this.deferredEditingTimer = setTimeout(() => {
          if (!this.deferredEditing.pending) return;
          this.deferredEditing.clear();
          this.setError('画面恢复超时，暂存键盘输入已取消，请重新输入。');
        }, 3000);
      }
      return;
    }
    this.deferredEditing.clear();
    this.setError('键盘输入暂未送达，请等待画面恢复后重新输入。');
  };
  finishLocalEditing = () => {
    if (this.editing.matches(this.editorOwner)) {
      for (const event of this.heldKeys.values())
        this.sendEdit({ ...event, action: 'up', repeat: false, text: '', unmodified_text: '' });
      const composition = this.editing.finishCurrent(this.editorOwner, performance.now());
      if (composition) this.sendEdit(composition);
    }
    this.heldKeys.clear();
    this.editing.blurred(performance.now());
    this.resetEditor();
  };
  hideKeyboard = (dismiss = true) => {
    if (dismiss) this.keyboardSession.dismiss();
    this.setFocused(false);
    const node = this.editor;
    if (!node || document.activeElement !== node) {
      this.editing.blurred(performance.now());
      return;
    }
    // Prefer the browser's final compositionend. If blur sends none, commit
    // the latest composition update to the current remote target once.
    this.suppressBlur = true;
    node.blur();
    this.suppressBlur = false;
    node.inputMode = 'none';
    this.finishLocalEditing();
  };
  private dismissRemoteEditable = () => {
    const editable = this.remoteEditable;
    this.hideKeyboard();
    if (!editable) return;
    this.sendEditDismiss(editable.editable.target, editable.revision);
  };
  private sendEditDismiss(target: string, revision: string) {
    const event = { type: 'editing.dismiss', target, revision };
    if (this.remoteOwner && this.deferredEditing.pending) {
      this.deferredEditing.enqueue(this.remoteOwner, event);
      return;
    }
    const surface = this.editingSurface;
    if (surface) this.ports.input.sendInput(surface, event);
  }
  focusEditor = (allowSoftKeyboard: boolean, userRequested = false) => {
    const node = this.editor;
    if (!node || !this.editorOwner) return false;
    const wantsSoftKeyboard = allowSoftKeyboard && !!this.remoteEditable;
    const inputMode = wantsSoftKeyboard ? editableInputMode(this.remoteEditable.editable.type) : 'none';
    if (
      document.activeElement === node &&
      inputMode !== 'none' &&
      !this.editing.composing &&
      (node.inputMode === 'none' || (userRequested && !this.resize.keyboardOpen))
    ) {
      this.suppressBlur = true;
      node.blur();
      this.suppressBlur = false;
      this.finishLocalEditing();
    }
    node.inputMode = inputMode;
    this.editing.focus(this.editorOwner);
    node.focus({ preventScroll: true });
    const focused = document.activeElement === node && wantsSoftKeyboard && inputMode !== 'none';
    this.setFocused(focused);
    if (focused) {
      this.keyboardSession.attached(userRequested);
      if (userRequested) this.keyboardTick();
    }
    return focused;
  };
  currentEditTarget = () => {
    const current = this.ports.editing.editingSurface(this.viewId);
    if (!current || this.ports.editing.editingIdentity(current) !== this.editingIdentity) return undefined;
    return this.ports.editing.mobileEditing.forKeyboard(current)?.editable.target;
  };
  resetEditor = () => {
    if (this.editor) {
      this.editor.value = EDITOR_SENTINEL;
      this.editor.setSelectionRange(1, 1);
    }
  };
  activateKeyboard = () => {
    if (this.keyboardSession.activate().open && !this.keyboardShown) this.focusEditor(true, true);
    this.observe();
  };
  beginPointerFocus = () => {
    const surface = this.surface;
    if (!surface || !this.keyboardEnabled) return;
    this.editing.invalidate();
    this.heldKeys.clear();
    this.deferredEditing.clear();
    this.pointerFocus = {
      identity: this.ports.input.inputIdentity(surface),
      document: this.editingIdentity!,
      owner: `pointer:${++this.pointerSequence}:${this.editingIdentity}`,
      focusRevision: this.remoteEditable?.editable.focusRevision ?? '0',
      revision: this.ports.editing.mobileEditing.current?.revision ?? '0',
    };
    this.editing.focus(this.pointerFocus.owner);
    this.previousEditing = { document: this.editingIdentity, owner: this.editorOwner };
  };
  key = (event: KeyboardEvent, action: string) => {
    if (this.editing.composing || event.isComposing || event.keyCode === 229) return;
    if (!this.editing.matches(this.editorOwner) || (action === 'up' && !this.heldKeys.has(event.code)))
      return;
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') return;
    if (
      event.key === 'Tab' ||
      ['Enter', 'Backspace', 'Delete'].includes(event.key) ||
      event.ctrlKey ||
      event.metaKey ||
      event.key.startsWith('Arrow')
    )
      event.preventDefault();
    const value = {
      type: 'key',
      action,
      ...keyIdentity(event.code, event.key),
      windows_key_code: event.keyCode,
      modifiers: modifiers(event),
      repeat: event.repeat,
      text: action === 'down' && event.key === 'Enter' ? '\r' : '',
      unmodified_text: action === 'down' && event.key === 'Enter' ? '\r' : '',
    };
    if (action === 'down') this.editing.physicalKey(event.key, performance.now());
    else this.editing.releasePhysicalKey(event.key);
    if (action === 'down') this.heldKeys.set(event.code, value);
    else this.heldKeys.delete(event.code);
    this.sendEdit(value);
  };
  private paste = (event: ClipboardEvent) => {
    if (!this.editing.matches(this.editorOwner)) return;
    event.preventDefault();
    const owner = this.editorOwner;
    const text = event.clipboardData?.getData('text/plain');
    const pending = text === undefined ? Promise.resolve() : deviceClipboard.send(text);
    void pending
      .then(() => {
        if (owner !== this.editorOwner || !this.editing.matches(owner)) return;
        this.sendEdit({
          type: 'key',
          action: 'down',
          ...keyIdentity('KeyV', 'v'),
          windows_key_code: 86,
          modifiers: 2,
          text: '',
          unmodified_text: '',
          repeat: false,
        });
        this.sendEdit({
          type: 'key',
          action: 'up',
          ...keyIdentity('KeyV', 'v'),
          windows_key_code: 86,
          modifiers: 2,
          text: '',
          unmodified_text: '',
          repeat: false,
        });
      })
      .catch(() => this.setError('剪贴板暂未同步，请重试粘贴。'));
  };
  edit = (event: InputEvent, phase: 'before' | 'input') => {
    if (document.activeElement !== this.editor) return;
    if (event.isComposing || this.editing.composing) return;
    const data =
      phase === 'input' &&
      event.data === null &&
      ['insertText', 'insertFromPaste', 'insertFromDictation'].includes(event.inputType)
        ? this.editor?.value.replace(EDITOR_SENTINEL, '') || null
        : event.data;
    const operation = this.editing.edit(this.editorOwner, event.inputType, data, performance.now(), phase);
    const deferredText =
      data === null && ['insertText', 'insertFromPaste', 'insertFromDictation'].includes(event.inputType);
    if (phase === 'before' && event.cancelable && !deferredText) event.preventDefault();
    for (const value of operation.events) this.sendEdit(value);
    if (operation.unsupported)
      this.setError(`当前键盘编辑操作尚不支持：${operation.unsupported}。请使用逐字输入或远端选区编辑。`);
    else if (operation.events.length) this.setError(undefined);
    if (phase === 'input' || event.defaultPrevented) this.resetEditor();
  };
}
