import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Add } from '@mui/icons-material';
import { WindowTab, TabDragGhost } from './window-tab';
import { beginTabPointer, registerTabStrip, tabShift, useTabDrag } from './tab-drag';
import { uiScale, useUiScale } from './ui-scale';
import { Tool } from './window-tool';
import './tab-strip.css';

export interface TabStripItem {
  id: string;
  title: string;
  icon: React.ReactNode;
  attention?: boolean;
}
export function TabStrip({
  windowId,
  group,
  items,
  activeId,
  disabled = false,
  createDisabled = false,
  select,
  close,
  move,
  menu,
  create,
}: {
  windowId: string;
  group: string;
  items: TabStripItem[];
  activeId?: string;
  disabled?: boolean;
  createDisabled?: boolean;
  select(id: string): void;
  close(id: string): void;
  move(id: string, windowId: string, index: number): void;
  menu(anchor: HTMLElement, id: string): void;
  create(): void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const drag = useTabDrag();
  const scale = useUiScale();
  const stripRef = useCallback(
    (element: HTMLDivElement | null) => {
      strip.current = element;
      registerTabStrip(windowId, group, element);
    },
    [windowId, group],
  );
  useEffect(() => {
    const bar = strip.current;
    const selected = bar?.querySelector('[aria-selected="true"]')?.closest('.window-tab');
    if (!bar || !selected) return;
    const bounds = bar.getBoundingClientRect();
    const tabBounds = selected.getBoundingClientRect();
    if (tabBounds.left < bounds.left) bar.scrollLeft += (tabBounds.left - bounds.left) / uiScale();
    else if (tabBounds.right > bounds.right) bar.scrollLeft += (tabBounds.right - bounds.right) / uiScale();
  }, [activeId, items.length]);
  return (
    <>
      <div
        className={`tab-strip${drag ? ' tab-strip-dragging' : ''}${drag?.target?.windowId === windowId && drag.sourceWindowId !== windowId ? ' tab-drop-target' : ''}`}
        role="tablist"
        aria-label="标签页"
        ref={stripRef}
      >
        {items.map((item, index) => (
          <WindowTab
            key={item.id}
            {...item}
            selected={activeId === item.id}
            disabled={disabled}
            closeLabel={`关闭 ${item.title}`}
            dragSource={drag?.tabId === item.id}
            shift={tabShift(drag, windowId, item.id, index)}
            onPointerDown={(event) =>
              !disabled &&
              beginTabPointer({
                event,
                tabId: item.id,
                windowId,
                title: item.title,
                index,
                move,
                longPress: (anchor) => menu(anchor, item.id),
              })
            }
            onContextMenu={(anchor) => menu(anchor, item.id)}
            onSelect={() => select(item.id)}
            onClose={() => close(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const to = index + (event.key === 'ArrowRight' ? 1 : -1);
              if (event.ctrlKey && event.shiftKey) {
                if (to >= 0 && to < items.length) move(item.id, windowId, to);
              } else
                (
                  strip.current?.querySelectorAll('.tab-select')[
                    (to + items.length) % items.length
                  ] as HTMLElement
                )?.focus({ preventScroll: true });
            }}
          />
        ))}
      </div>
      {drag?.sourceWindowId === windowId &&
        createPortal(
          <TabDragGhost
            title={drag.title}
            icon={items.find((item) => item.id === drag.tabId)?.icon}
            left={(drag.x - drag.grabX) / scale}
            top={(drag.y - drag.grabY) / scale}
            width={drag.width}
          />,
          document.body,
        )}
      <Tool
        title="新建标签页"
        className="new-tab-button"
        disabled={disabled || createDisabled}
        onClick={create}
      >
        <Add fontSize="small" />
      </Tool>
    </>
  );
}
