import { type Surface } from '../presentation/types';
import { freezeSnapshot } from '../util/store';
import { EditingView, type EditingViewPorts } from './editing-view';
import { MobileEditingState, sameEditingDocument } from './mobile-editing-state';

import { type Incoming, type SelectionMessage, type ContextMenuMessage } from '../rtc/protocol';

import type { RtcSession } from '../rtc/rtc-session';

export class EditingSession {
  createView(ports: EditingViewPorts, viewId: string, editor: HTMLTextAreaElement) {
    return new EditingView(ports, viewId, editor);
  }

  constructor(private readonly ports: { rtc: Pick<RtcSession, 'attempt'> }) {}
  readonly mobileEditing = new MobileEditingState();
  private selectionRevision?: bigint;
  private selection?: SelectionMessage;
  private contextMenuRevision?: bigint;
  private contextMenu?: ContextMenuMessage;

  editingSurface(viewId: string) {
    return this.mobileEditing.surface(viewId);
  }

  editingIdentity(surface: Surface) {
    return `${this.ports.rtc.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}`;
  }

  handle(message: Incoming) {
    if (message.type === 'layout') {
      this.mobileEditing.acceptLayout(message);
      this.reconcileMenus();
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
      this.reconcileMenus();
      this.notify();
    }
    if (message.type === 'input.contextMenu') {
      const revision = BigInt(message.revision);
      if (this.contextMenuRevision !== undefined && revision <= this.contextMenuRevision) return;
      this.contextMenuRevision = revision;
      this.contextMenu = message;
      this.reconcileMenus();
      this.notify();
    }
  }

  private reconcileMenus(views: readonly Surface[] = this.mobileEditing.views) {
    const view = this.selection?.view;
    if (view && !views.some((surface) => sameEditingDocument(surface, view))) this.selection = undefined;
    const contextView = this.contextMenu?.view;
    if (contextView && !views.some((surface) => sameEditingDocument(surface, contextView)))
      this.contextMenu = undefined;
  }

  clear() {
    this.mobileEditing.clear();
    this.selection = undefined;
    this.contextMenu = undefined;
    this.notify();
  }
  reconcile(views: Surface[]) {
    this.mobileEditing.reconcile(views);
    this.reconcileMenus(views);
    this.notify();
  }
  reset() {
    this.mobileEditing.reset();
    this.selection = undefined;
    this.selectionRevision = undefined;
    this.contextMenu = undefined;
    this.contextMenuRevision = undefined;
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
      contextMenu: this.contextMenu && {
        ...this.contextMenu,
        view: this.contextMenu.view && { ...this.contextMenu.view },
        menu: this.contextMenu.menu && {
          ...this.contextMenu.menu,
          link: this.contextMenu.menu.link && { ...this.contextMenu.menu.link },
          image: this.contextMenu.menu.image && { ...this.contextMenu.menu.image },
          editable: this.contextMenu.menu.editable && { ...this.contextMenu.menu.editable },
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
    contextMenu?: ContextMenuMessage;
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
