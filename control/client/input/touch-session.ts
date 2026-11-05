import { type Layout, type Surface } from '../presentation/types';
import { freezeSnapshot } from '../util/store';
import { RequestTracker } from '../util/request-tracker';

import { diagnostics } from '../media/diagnostics';
import { type Outgoing } from '../rtc/protocol';
import type { InputDelivery, InputRequest, TerminalInput, TouchRetireLease } from './types';
import { terminalQueryDelays } from './types';

import { TouchView, type TouchViewPorts } from './touch-view';
export interface TouchPorts {
  queuedTerminalCount(): number;
  nextSequence(): string;
  identity(surface: Surface): string;
  report(
    request: InputRequest & { epoch?: string },
    phase: InputDelivery['phase'],
    sequence?: string,
    reason?: string,
  ): void;
  layout(): Layout | null;
  scope(): { locked: boolean; epoch?: number };
  attempt(): number;
  channel(): { readyState: RTCDataChannelState; bufferedAmount: number } | null;
  send(message: Outgoing): void;
}
export class TouchSession {
  getTerminal(sequence: string) {
    return this.terminalInput.get(sequence);
  }
  trackTerminal(sequence: string, entry: TerminalInput) {
    this.terminalInput.set(sequence, entry);
    this.scheduleTerminalQuery(sequence, entry);
    this.notify();
  }
  acceptTerminal(sequence: string) {
    const entry = this.terminalInput.get(sequence);
    if (!entry) return;
    entry.pending = true;
    entry.retries = 0;
    entry.unconfirmed = false;
    this.queries.resolve(sequence, undefined);
    this.scheduleTerminalQuery(sequence, entry);
  }
  settleTouch(identity: string, sequenceId: string) {
    for (const [sequence, entry] of this.terminalInput)
      if (entry.identity === identity && entry.event.sequenceId === sequenceId) this.deleteTerminal(sequence);
  }

  private readonly queries = new RequestTracker<void>();
  private readonly views = new Set<TouchView>();
  createView(ports: TouchViewPorts, viewId: string, canvas: HTMLCanvasElement) {
    const view = new TouchView(ports, viewId, canvas);
    this.views.add(view);
    view.subscribe(() => {
      if (view.isDetached && view.getSnapshot().phase === 'released') this.views.delete(view);
      this.notify();
    });
    return view;
  }
  deleteTerminal(sequence: string) {
    this.terminalInput.delete(sequence);
    this.queries.resolve(sequence, undefined);
    this.notify();
  }

  constructor(private readonly ports: TouchPorts) {}
  private readonly terminalInput = new Map<string, TerminalInput>();

  clearTerminalInput() {
    this.terminalInput.clear();
    this.queries.clear();
    this.views.forEach((view) => view.reset());
    this.notify();
  }

  reservedTerminalInput() {
    return this.terminalInput.size + this.ports.queuedTerminalCount();
  }

  pruneTerminalInput() {
    for (const [sequence, entry] of this.terminalInput) {
      if (entry.retirement) continue;
      const view = this.ports.layout()?.views.find((view) => view.id === entry.surface.id);
      if (view && this.ports.identity(view) === entry.identity) continue;
      this.deleteTerminal(sequence);
    }
  }

  private scheduleTerminalQuery(sequence: string, entry: TerminalInput) {
    if (this.queries.has(sequence)) return;
    void this.queries
      .request(
        sequence,
        terminalQueryDelays[entry.retries] ?? 2000,
        () => {},
        undefined,
        () => {
          if (this.terminalInput.get(sequence) !== entry) return;
          if (entry.retries >= terminalQueryDelays.length && !entry.unconfirmed) {
            entry.unconfirmed = true;
            this.ports.report(entry, 'unconfirmed', sequence, 'terminal-query-timeout');
          }
          const channel = this.ports.channel();
          if (
            channel?.readyState === 'open' &&
            !this.ports.scope().locked &&
            this.ports.scope().epoch !== 0 &&
            channel.bufferedAmount <= 256 * 1024
          ) {
            try {
              this.ports.send({
                type: 'input.touchStatus',
                clientSequence: sequence,
                sequenceId: String(entry.event.sequenceId),
              });
              entry.retries++;
            } catch (error) {
              diagnostics.record('touch-status', error);
            }
          }
          this.scheduleTerminalQuery(sequence, entry);
        },
      )
      .catch(() => {
        /* Proof and scope resets settle the ledger independently of this deadline. */
      });
  }

  retryTouchTerminal(identity: string, sequenceId: string) {
    if (
      this.ports.scope().locked ||
      this.ports.channel()?.readyState !== 'open' ||
      this.ports.scope().epoch === 0
    )
      return false;
    const entry = [...this.terminalInput.entries()]
      .reverse()
      .find(([, request]) => request.identity === identity && request.event.sequenceId === sequenceId);
    if (!entry || entry[1].event.gestureMode !== 'client-v1') return false;
    const [sequence, request] = entry;
    this.queries.resolve(sequence, undefined);
    request.retries = 0;
    request.unconfirmed = false;
    this.scheduleTerminalQuery(sequence, request);
    return true;
  }

  touchRetirementCurrent(lease: TouchRetireLease) {
    return (
      !this.ports.scope().locked &&
      this.ports.scope().epoch !== 0 &&
      this.ports.scope().epoch === lease.authorization &&
      lease.identity.startsWith(`${this.ports.attempt()}:`)
    );
  }

  retireTouch(lease: TouchRetireLease, event: Record<string, unknown>) {
    const channel = this.ports.channel();
    if (
      !this.touchRetirementCurrent(lease) ||
      channel?.readyState !== 'open' ||
      channel.bufferedAmount > 256 * 1024 ||
      !this.ports.layout() ||
      this.ports.layout()!.epoch === lease.layoutEpoch ||
      event.type !== 'touch' ||
      event.gestureMode !== 'client-v1' ||
      event.action !== 'cancel' ||
      typeof event.sequenceId !== 'string' ||
      this.reservedTerminalInput() >= 64
    )
      return false;
    const { id: view, session, instance, document, focus } = lease.surface;
    const sequence = this.ports.nextSequence();
    try {
      this.ports.send({
        type: 'input.touchRetire',
        view,
        session,
        instance,
        document,
        focus,
        layoutEpoch: lease.layoutEpoch,
        sequence,
        sequenceId: event.sequenceId,
      });
    } catch {
      return false;
    }
    const entry = {
      surface: lease.surface,
      identity: lease.identity,
      event,
      requiresTerminalState: true,
      pending: false,
      retries: 0,
      retirement: true,
    };
    this.terminalInput.set(sequence, entry);
    this.scheduleTerminalQuery(sequence, entry);
    return true;
  }

  private notify() {
    this.snapshot = freezeSnapshot({
      pendingTerminals: this.terminalInput.size,
      owners: [...this.views].map((view) => ({ viewId: view.viewId, ...view.getSnapshot() })),
    });
    this.listeners.forEach((listener) => listener());
  }

  private readonly listeners = new Set<() => void>();

  private snapshot: {
    pendingTerminals: number;
    owners: ({ viewId: string } & import('./touch-view').TouchOwnerState)[];
  } = { pendingTerminals: 0, owners: [] };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
}
