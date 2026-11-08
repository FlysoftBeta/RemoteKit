import './window-divider.css';
import { useDropTarget } from './window-drag';
import { useRef } from 'react';
import type { ProductSpace } from '../../shared/product';
import type { Action } from './product-dialogs';
import { uiScale } from './ui-scale';

export function dividerWeights(weights: number[], index: number, ratio: number) {
  const next = [...weights];
  const sum = next[index] + next[index + 1];
  const clamped = Math.max(0.05, Math.min(0.95, ratio));
  next[index] = sum * clamped;
  next[index + 1] = sum * (1 - clamped);
  return next;
}

export function WindowDivider({
  space,
  index,
  online,
  action,
  report,
}: {
  space: ProductSpace;
  index: number;
  online: boolean;
  action: Action;
  report(error: unknown): void;
}) {
  const drop = useDropTarget('divider', undefined);
  const drag = useRef<{ x: number; width: number; ratio: number; weights: number[] } | undefined>(undefined);
  const ratio = space.weights[index] / (space.weights[index] + space.weights[index + 1]);
  const change = (next: number) =>
    void action({
      type: 'space.layout',
      spaceId: space.id,
      weights: dividerWeights(space.weights, index, next),
    }).catch(report);
  const restore = (node: HTMLElement) => {
    (node.previousElementSibling as HTMLElement).style.flexGrow = String(space.weights[index]);
    (node.nextElementSibling as HTMLElement).style.flexGrow = String(space.weights[index + 1]);
  };
  return (
    <div
      className="window-divider"
      role="separator"
      aria-label="调整分屏比例"
      aria-orientation="vertical"
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={online ? 0 : -1}
      onKeyDown={(event) => {
        if (online && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          change(ratio + (event.key === 'ArrowLeft' ? -0.05 : 0.05));
        }
      }}
      onPointerDown={(event) => {
        if (!online) return;
        const node = event.currentTarget;
        drag.current = {
          x: event.clientX,
          width:
            (node.previousElementSibling as HTMLElement).offsetWidth +
            (node.nextElementSibling as HTMLElement).offsetWidth,
          ratio,
          weights: [...space.weights],
        };
        node.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const next = dividerWeights(
          current.weights,
          index,
          current.ratio + (event.clientX - current.x) / uiScale() / current.width,
        );
        (event.currentTarget.previousElementSibling as HTMLElement).style.flexGrow = String(next[index]);
        (event.currentTarget.nextElementSibling as HTMLElement).style.flexGrow = String(next[index + 1]);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current) return;
        const next = current.ratio + (event.clientX - current.x) / uiScale() / current.width;
        drag.current = undefined;
        restore(event.currentTarget);
        if (next <= 0.15 || next >= 0.85)
          void action({
            type: 'window.place',
            windowId: space.windowIds[index + (next >= 0.85 ? 1 : 0)],
            placement: { mode: 'space' },
          }).catch(report);
        else change(next);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={(event) => {
        drag.current = undefined;
        restore(event.currentTarget);
      }}
    >
      <span className="window-divider-target" ref={drop.ref} />
    </div>
  );
}
