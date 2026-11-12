import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RemoteKitError, type WireError } from '../../shared/errors';
import { presentFailure, type FailureContext, type Presentation } from './present';
import { notices } from './notices';
import { recoveryTiming, recoveringDelayMs, longRecoveryMs, connectionRecoveryMs } from './thresholds';
import './failures.css';

export function ErrorId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="failure-id"
      onClick={(event) => {
        event.stopPropagation();
        const target = event.currentTarget;
        void (navigator.clipboard?.writeText(id) ?? Promise.reject()).then(
          () => setCopied(true),
          () => {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(target);
            selection?.removeAllRanges();
            selection?.addRange(range);
          },
        );
      }}
    >
      {copied ? '已复制' : `错误 ID ${id}`}
    </button>
  );
}

type Props = {
  error?: RemoteKitError | WireError | null;
  context?: FailureContext;
  presentation?: Presentation;
  since?: number;
  onDismiss?: () => void;
};
export function FailureNote({ error, context, presentation, since, onDismiss }: Props) {
  const failure = useMemo(
    () =>
      presentation ??
      (error ? presentFailure(error, context ?? { operation: '完成操作', scope: 'item' }) : undefined),
    [
      error,
      presentation,
      context?.operation,
      context?.scope,
      context?.targetId,
      context?.input,
      context?.capacity,
      context?.text,
      context?.issue,
      context?.action,
      context?.itemName,
      context?.consequence,
      context?.connection,
      context?.longText,
    ],
  );
  const [started, setStarted] = useState(since ?? Date.now());
  const [now, setNow] = useState(Date.now());
  const recovering = failure?.class === 'A';
  useEffect(() => {
    setStarted(since ?? Date.now());
    setNow(Date.now());
  }, [recovering, since]);
  useEffect(() => {
    if (!recovering) return;
    const timers = [
      recoveringDelayMs,
      longRecoveryMs,
      ...(failure?.connection ? [connectionRecoveryMs] : []),
    ].map((delay) => setTimeout(() => setNow(Date.now()), Math.max(0, started + delay - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [recovering, started, failure?.connection]);
  if (!failure || failure.class === 'silent') return null;
  const timing = recoveryTiming(started, now, failure.connection);
  if (recovering && !timing.visible) return null;
  return (
    <div
      className={`failure-note failure-${failure.class}${timing.calm ? ' failure-calm' : ''}`}
      onPointerDown={(event) => event.stopPropagation()}
      role={failure.class === 'C' ? 'alert' : 'status'}
    >
      {recovering && !timing.calm && <span className="failure-spinner" aria-hidden />}
      {onDismiss && (
        <button type="button" className="failure-dismiss" aria-label="关闭通知" onClick={onDismiss}>
          ×
        </button>
      )}
      <div className="failure-content">
        <span>{recovering && timing.long ? (failure.longText ?? failure.text) : failure.text}</span>
        {failure.class === 'C' && failure.errorId && <ErrorId id={failure.errorId} />}
      </div>
      {failure.class === 'B' && failure.action && (
        <button
          type="button"
          className="failure-action"
          onClick={(event) => {
            event.stopPropagation();
            failure.action!.run(event.currentTarget);
          }}
        >
          {failure.action.label}
        </button>
      )}
    </div>
  );
}

export function SurfaceState({ live = false, onDismiss, ...props }: Props & { live?: boolean }) {
  return (
    <div className={`failure-surface${live ? ' failure-surface-live' : ''}`}>
      <FailureNote {...props} onDismiss={onDismiss} />
    </div>
  );
}
export function NoticeCenter() {
  const items = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
  return (
    <aside className="notice-center" aria-label="通知" aria-live="polite">
      {items.slice(0, 3).map((notice) => (
        <div className="notice-entry" key={notice.key} data-notice-key={notice.key}>
          <FailureNote presentation={notice.presentation} since={notice.since} />
          {notice.kind !== 'progress' && (
            <button
              className="notice-dismiss"
              aria-label="关闭通知"
              onClick={() => notices.dismiss(notice.key)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </aside>
  );
}
