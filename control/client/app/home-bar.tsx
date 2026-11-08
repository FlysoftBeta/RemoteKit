import { ButtonBase } from '@mui/material';
import { useEffect, useRef } from 'react';
import { uiScale } from './ui-scale';

export function HomeBar({
  launcher,
  switcher,
  previous,
}: {
  launcher(): void;
  switcher(): void;
  previous(): void;
}) {
  const gesture = useRef<
    | { x: number; y: number; up: boolean; consumed: boolean; timer?: ReturnType<typeof setTimeout> }
    | undefined
  >(undefined);
  useEffect(() => () => clearTimeout(gesture.current?.timer), []);
  return (
    <ButtonBase
      disableRipple
      className="home-bar"
      aria-label="主页条"
      onClick={() => {
        if (!gesture.current?.consumed) launcher();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        switcher();
      }}
      onPointerDown={(event) => {
        clearTimeout(gesture.current?.timer);
        gesture.current = { x: event.clientX, y: event.clientY, up: false, consumed: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || current.consumed) return;
        const dx = (event.clientX - current.x) / uiScale();
        const dy = (event.clientY - current.y) / uiScale();
        if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy)) {
          clearTimeout(current.timer);
          current.consumed = true;
          previous();
        } else if (dy <= -40 && !current.up) {
          current.up = true;
          current.timer = setTimeout(() => {
            current.consumed = true;
            switcher();
          }, 250);
        } else if (dy > -40 && current.up) {
          current.up = false;
          clearTimeout(current.timer);
        }
      }}
      onPointerUp={(event) => {
        clearTimeout(gesture.current?.timer);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        clearTimeout(gesture.current?.timer);
        gesture.current = undefined;
      }}
    >
      <span className="home-indicator" />
    </ButtonBase>
  );
}
