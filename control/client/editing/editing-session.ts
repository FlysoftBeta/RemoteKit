import { type Surface } from '../presentation/types';
import { freezeSnapshot } from '../util/store';
import { EditingView, type EditingViewPorts } from './editing-view';
import { MobileEditingState } from './mobile-editing-state';

import { type Incoming } from '../rtc/protocol';

import type { RtcSession } from '../rtc/rtc-session';

export class EditingSession {
  createView(ports: EditingViewPorts, viewId: string, editor: HTMLTextAreaElement) {
    return new EditingView(ports, viewId, editor);
  }

  constructor(private readonly ports: { rtc: Pick<RtcSession, 'attempt'> }) {}
  readonly mobileEditing = new MobileEditingState();

  editingSurface(viewId: string) {
    return this.mobileEditing.surface(viewId);
  }

  editingIdentity(surface: Surface) {
    return `${this.ports.rtc.attempt}:${surface.session}:${surface.id}:${surface.instance}:${surface.document}`;
  }

  handle(message: Incoming) {
    if (message.type === 'layout') {
      this.mobileEditing.acceptLayout(message);
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
  }

  clear() {
    this.mobileEditing.clear();
    this.notify();
  }
  reconcile(views: Surface[]) {
    this.mobileEditing.reconcile(views);
    this.notify();
  }
  reset() {
    this.mobileEditing.reset();
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
      views: this.mobileEditing.views.map((view) => ({ ...view })),
      layoutPending: this.mobileEditing.layoutPending,
      attempt: this.ports.rtc.attempt,
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: {
    current?: import('../rtc/protocol').EditableMessage;
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
