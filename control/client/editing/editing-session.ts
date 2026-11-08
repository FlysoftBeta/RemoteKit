import { type Surface } from '../presentation/types';
import { freezeSnapshot } from '../util/store';
import { EditingView, type EditingViewPorts } from './editing-view';
import { MobileEditingState, sameEditingDocument } from './mobile-editing-state';

import { type Incoming, type SelectionMessage } from '../rtc/protocol';

import type { RtcSession } from '../rtc/rtc-session';

export class EditingSession {
  createView(ports: EditingViewPorts, viewId: string, editor: HTMLTextAreaElement) {
    return new EditingView(ports, viewId, editor);
  }

  constructor(private readonly ports: { rtc: Pick<RtcSession, 'attempt'> }) {}
  readonly mobileEditing = new MobileEditingState();
  private selectionRevision?: bigint;
  private selection?: SelectionMessage;

  editingSurface(viewId: string) {
    return this.mobileEditing.surface(viewId);
  }

  editingIdentity(surface: Surface) {
    return `${this.ports.rtc.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}`;
  }

  handle(message: Incoming) {
    if (message.type === 'layout') {
      this.mobileEditing.acceptLayout(message);
      this.reconcileSelection();
      this.notify();
    }
    if (message.type === 'input.editable') {
      if (
        this.mobileEditing.receive(
          message,
          this.mobileEditing.views,
          Date.now(),
          this.mobileEditing.layoutPending,
        )
      )
        this.notify();
      return;
    }
    if (message.type === 'input.selection') {
      const revision = BigInt(message.revision);
      if (this.selectionRevision !== undefined && revision <= this.selectionRevision) return;
      this.selectionRevision = revision;
      this.selection = message;
      this.reconcileSelection();
      this.notify();
    }
  }

  private reconcileSelection(views: readonly Surface[] = this.mobileEditing.views) {
    const view = this.selection?.view;
    if (view && !views.some((surface) => sameEditingDocument(surface, view))) this.selection = undefined;
  }

  clear() {
    this.mobileEditing.clear();
    this.selection = undefined;
    this.notify();
  }
  reconcile(views: Surface[]) {
    this.mobileEditing.reconcile(views);
    this.reconcileSelection(views);
    this.notify();
  }
  reset() {
    this.mobileEditing.reset();
    this.selection = undefined;
    this.selectionRevision = undefined;
    this.notify();
  }

  notify() {
    const current = this.mobileEditing.current;
    this.snapshot = freezeSnapshot({
      current: current && {
        ...current,
        view: current.view && { ...current.view },
        editable: { ...current.editable },
      },
      selection: this.selection && {
        ...this.selection,
        view: this.selection.view && { ...this.selection.view },
        menu: this.selection.menu && {
          ...this.selection.menu,
          commands: [...this.selection.menu.commands],
        },
      },
      views: this.mobileEditing.views.map((view) => ({ ...view })),
      layoutPending: this.mobileEditing.layoutPending,
      attempt: this.ports.rtc.attempt,
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: {
    current?: import('../rtc/protocol').EditableMessage;
    selection?: SelectionMessage;
    views: Surface[];
    layoutPending: boolean;
    attempt: number;
  } = { views: [], layoutPending: false, attempt: 0 };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
}
