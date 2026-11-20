import './lock-screen.css';
import React, { useEffect, useState } from 'react';
import type { AuthState } from '../../shared/security';
import type { AuthCamera } from './auth-camera';
import { FaceBadge, useFaceUnlock, type FaceUnlock } from './face-unlock';

const tapGapMs = 500;
const REVEAL_TAPS = 5;
const tapSlopPx = 40;

// The gesture only reveals the form; it does not grant access.
export class RapidTaps {
  private taps: { x: number; y: number; at: number }[] = [];
  reset() {
    this.taps = [];
  }
  push(x: number, y: number, now: number) {
    const last = this.taps[this.taps.length - 1];
    const first = this.taps[0];
    if (!last || now - last.at > tapGapMs || Math.hypot(x - first.x, y - first.y) > tapSlopPx) this.taps = [];
    this.taps.push({ x, y, at: now });
    if (this.taps.length < REVEAL_TAPS) return false;
    this.reset();
    return true;
  }
}

export function BlankScreen({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) {
  return (
    <div className="viewer-lock-blank" onClick={onClick}>
      {children}
    </div>
  );
}

function useReveal() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const reveal = new RapidTaps();
    let tap: { id: number; x: number; y: number; at: number } | undefined;
    const reset = () => {
      reveal.reset();
      tap = undefined;
    };
    const hidden = () => {
      reset();
      if (document.hidden) setOpen(false);
    };
    const push = (x: number, y: number) => {
      if (reveal.push(x, y, performance.now())) setOpen(true);
    };
    const key = (event: KeyboardEvent) => {
      if (
        open ||
        document.hidden ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (event.key !== 'Enter' || event.repeat) {
        reset();
        return;
      }
      event.preventDefault();
      push(0, 0);
    };
    const down = (event: PointerEvent) => {
      tap = undefined;
      if (open || document.hidden || !event.isPrimary || event.button !== 0) return;
      tap = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
    };
    const moved = (event: PointerEvent) => {
      if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12)
        tap = undefined;
    };
    const up = (event: PointerEvent) => {
      moved(event);
      const held = tap;
      tap = undefined;
      if (held && held.id === event.pointerId && event.isPrimary && performance.now() - held.at <= 400)
        push(held.x, held.y);
    };
    const context = (event: MouseEvent) => {
      if (!open) event.preventDefault();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', reset);
    window.addEventListener('contextmenu', context);
    window.addEventListener('resize', reset);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', reset);
      window.removeEventListener('contextmenu', context);
      window.removeEventListener('resize', reset);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [open]);
  return [open && !document.hidden, () => setOpen(false)] as const;
}

export function RevealScreen({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, close] = useReveal();
  return open ? <>{children(close)}</> : <BlankScreen />;
}

export function LockScreen({
  auth,
  camera,
  children,
}: {
  auth: AuthState | null;
  camera: AuthCamera;
  children: (close: () => void, face: FaceUnlock) => React.ReactNode;
}) {
  const face = useFaceUnlock(auth, camera);
  const [open, close] = useReveal();
  if (open)
    return (
      <>
        {children(() => {
          face.stop();
          close();
        }, face)}
      </>
    );
  return (
    <BlankScreen
      onClick={() => {
        if (face.usable && face.phase !== 'scanning') face.begin();
      }}
    >
      {face.usable && <FaceBadge face={face} />}
    </BlankScreen>
  );
}
