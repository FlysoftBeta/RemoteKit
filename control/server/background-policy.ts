import { performance } from 'node:perf_hooks';

type BackgroundView = {
  actual?: number; desired?: number; visible?: boolean; canDiscard?: boolean; instance?: unknown;
  pending?: boolean; audible?: boolean; captured?: boolean; pending_close?: boolean;
  close_state?: string; recovery?: { pending?: boolean };
  pageRequests?: { pending?: unknown[] };
};
type Accounting = { eligibleMs: number; observedAt: number; freezeRequested: boolean; identity: string };

// Only Control-local monotonic durations are kept here; no timestamp crosses IPC.
export class BackgroundPolicy {
  private accounting = new Map<string, Accounting>();

  clear() { this.accounting.clear(); }
  forget(key: string) { this.accounting.delete(key); }
  retain(tenant: string, viewIds: Set<string>) {
    const prefix = tenant + '/';
    for (const key of this.accounting.keys()) if (key.startsWith(prefix) && !viewIds.has(key.slice(prefix.length))) this.accounting.delete(key);
  }
  freezeRequested(key: string) { const entry = this.accounting.get(key); if (entry) entry.freezeRequested = true; }

  action(key: string, enabled: boolean, visible: boolean, protectedByProduct: boolean, current: BackgroundView | undefined, browserIncarnation: unknown, now = performance.now()): 'freeze' | 'discard' | undefined {
    // Audio/capture (including their last observed active sample), dialogs,
    // recovery and close work reset the full safe-hidden interval. Consequently
    // freeze has at least 30s and discard 120s of cooling after those end.
    if (!enabled || visible || protectedByProduct || !current || current.visible !== false ||
        current.audible || current.captured || current.pending_close || current.recovery?.pending ||
        current.pageRequests?.pending?.length || current.close_state === 'closing' ||
        current.actual !== 0 && current.actual !== 1) {
      this.forget(key); return;
    }
    const identity = JSON.stringify([browserIncarnation, current.instance]);
    let entry = this.accounting.get(key);
    if (entry && (entry.identity !== identity || now - entry.observedAt > 15000)) { this.forget(key); entry = undefined; }
    // Our own freeze can temporarily make canDiscard false. Pause accounting
    // during that transition, retaining already earned safe time for discard.
    if (current.pending && entry?.freezeRequested && current.desired === 1) {
      entry.observedAt = now; return;
    }
    if (current.pending || current.canDiscard !== true) { this.forget(key); return; }
    if (!entry) { entry = { eligibleMs: 0, observedAt: now, freezeRequested: false, identity }; this.accounting.set(key, entry); }
    else { entry.eligibleMs += Math.max(0, now - entry.observedAt); entry.observedAt = now; entry.freezeRequested = false; }
    if (entry.eligibleMs >= 120000) return 'discard';
    if (current.actual === 0 && entry.eligibleMs >= 30000) return 'freeze';
  }
}
