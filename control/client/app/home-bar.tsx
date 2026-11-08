import { ButtonBase } from '@mui/material';
import { useRef } from 'react';
import { uiScale } from './ui-scale';

export function HomeBar({ launcher, previous }: { launcher(): void; previous(): void }) {
  const gesture = useRef<{ x: number; y: number; consumed: boolean } | undefined>(undefined);
  return (
    <ButtonBase
      disableRipple
      className="home-bar"
      aria-label="主页条"
      onClick={() => {
        if (!gesture.current?.consumed) launcher();
      }}
      onPointerDown={(event) => {
        gesture.current = { x: event.clientX, y: event.clientY, consumed: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (!current || current.consumed) return;
        const dx = (event.clientX - current.x) / uiScale();
        const dy = (event.clientY - current.y) / uiScale();
        if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy)) {
          current.consumed = true;
          previous();
        } else if (dy <= -40) {
          current.consumed = true;
          launcher();
        }
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        gesture.current = undefined;
      }}
    >
      <span className="home-indicator" />
    </ButtonBase>
  );
}
