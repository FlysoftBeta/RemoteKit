import React, { useEffect, useState } from 'react';

type Direction = 'Up' | 'Down' | 'Left' | 'Right';
const sequence: Direction[] = ['Up', 'Up', 'Down', 'Down', 'Left', 'Right', 'Left', 'Right'];

export function lockDirection(x: number, y: number, width: number, height: number): Direction | undefined {
  const dx = x / width - .5, dy = y / height - .5;
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= .05) return;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'Up' : 'Down';
  return dx < 0 ? 'Left' : 'Right';
}

export class RevealSequence {
  private prefix: Direction[] = [];
  private at = -Infinity;
  reset() { this.prefix = []; this.at = -Infinity; }
  push(direction: Direction, now: number) {
    if (now - this.at >= 5000) this.reset();
    this.prefix.push(direction);
    while (this.prefix.some((item, index) => item !== sequence[index])) this.prefix.shift();
    if (this.prefix.length === sequence.length) { this.reset(); return true; }
    this.at = this.prefix.length ? now : -Infinity;
    return false;
  }
}

export function BlankScreen() { return <div className="viewer-lock-blank" />; }

export function RevealScreen({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const reveal = new RevealSequence();
    let tap: { id: number; direction: Direction; x: number; y: number; at: number } | undefined;
    const reset = () => { reveal.reset(); tap = undefined; };
    const hidden = () => { reset(); if (document.hidden) setOpen(false); };
    const push = (direction: Direction) => { if (reveal.push(direction, performance.now())) setOpen(true); };
    const key = (event: KeyboardEvent) => {
      if (open || document.hidden || event.repeat || event.isComposing || event.keyCode === 229 ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      push(event.key.slice(5) as Direction);
    };
    const region = (event: PointerEvent) => lockDirection(event.clientX, event.clientY, innerWidth, innerHeight);
    const down = (event: PointerEvent) => {
      tap = undefined;
      if (open || document.hidden || !event.isPrimary || event.button !== 0) return;
      const direction = region(event);
      if (direction) tap = { id: event.pointerId, direction, x: event.clientX, y: event.clientY, at: performance.now() };
    };
    const moved = (event: PointerEvent) => {
      if (tap?.id === event.pointerId && (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12 || region(event) !== tap.direction)) tap = undefined;
    };
    const up = (event: PointerEvent) => {
      moved(event);
      const held = tap;
      tap = undefined;
      if (held && held.id === event.pointerId && event.isPrimary && event.button === 0 && performance.now() - held.at <= 700) push(held.direction);
    };
    const context = (event: MouseEvent) => { if (!open) event.preventDefault(); };
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
  return open && !document.hidden ? <>{children(() => setOpen(false))}</> : <BlankScreen />;
}
