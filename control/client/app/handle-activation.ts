import { useEffect, useRef, useState, type MouseEvent } from 'react';

const DOUBLE_CLICK_MS = 250;
const SLOP = 8;

export function useHandleActivation({
  onMenu,
  onDouble,
  disabled = false,
}: {
  onMenu(anchor: HTMLElement): void;
  onDouble(): void;
  disabled?: boolean;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const cleanup = useRef(() => {});
  const latest = useRef({ onDouble, disabled });
  latest.current = { onDouble, disabled };
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    if (disabled) closeMenu();
  }, [disabled]);
  function closeMenu() {
    cleanup.current();
    setMenuAnchor(null);
  }
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) return;
    cleanup.current();
    const anchor = event.currentTarget;
    setMenuAnchor(anchor);
    onMenu(anchor);
    if (event.detail === 0) return;
    const rect = anchor.getBoundingClientRect();
    const at = performance.now();
    let clickTimer: ReturnType<typeof setTimeout>;
    const swallow = (click: globalThis.MouseEvent) => {
      click.preventDefault();
      click.stopImmediatePropagation();
      cleanup.current();
    };
    const down = (next: PointerEvent) => {
      cleanup.current();
      if (
        latest.current.disabled ||
        !next.isPrimary ||
        next.button !== 0 ||
        performance.now() - at > DOUBLE_CLICK_MS ||
        next.clientX < rect.left - SLOP ||
        next.clientX > rect.right + SLOP ||
        next.clientY < rect.top - SLOP ||
        next.clientY > rect.bottom + SLOP
      )
        return;
      next.preventDefault();
      next.stopImmediatePropagation();
      setMenuAnchor(null);
      latest.current.onDouble();
      window.addEventListener('click', swallow, true);
      window.addEventListener('pointerup', released, true);
      window.addEventListener('pointercancel', released, true);
      cleanup.current = () => {
        clearTimeout(clickTimer);
        window.removeEventListener('click', swallow, true);
        window.removeEventListener('pointerup', released, true);
        window.removeEventListener('pointercancel', released, true);
      };
    };
    const released = () => {
      clickTimer = setTimeout(() => cleanup.current(), 0);
    };
    const timer = setTimeout(() => cleanup.current(), DOUBLE_CLICK_MS);
    window.addEventListener('pointerdown', down, { capture: true, passive: false });
    cleanup.current = () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', down, true);
    };
  };
  return { menuAnchor, closeMenu, buttonProps: { onClick } };
}
