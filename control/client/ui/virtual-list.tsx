// Adapted from FlysoftBeta/talos-ng packages/client/src/ui/virtual/virtual-scroller.tsx.
import { useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { SizeIndex, virtualRange } from './virtual-scroll';
import './virtual-list.css';

export interface VirtualViewport {
  element(): HTMLDivElement | null;
  scrollTo(top: number, left?: number): void;
}

export function VirtualScroller<T>({
  viewportRef,
  items,
  sizes,
  enabled,
  contentWidth,
  itemKey,
  renderItem,
  onScroll,
  onWidth,
  onResize,
  className,
  label,
  stickyHeader,
}: {
  viewportRef: Ref<VirtualViewport>;
  items: readonly T[];
  sizes: SizeIndex;
  enabled: boolean;
  contentWidth: number;
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  onScroll: (top: number) => void;
  onWidth: (width: number) => void;
  onResize?: () => void;
  className: string;
  label: string;
  stickyHeader?: (item: T) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const currentSizes = useRef(sizes);
  currentSizes.current = sizes;
  const callbacks = useRef({ onWidth, onScroll, onResize });
  callbacks.current = { onWidth, onScroll, onResize };
  const updateRange = (node: HTMLDivElement) => {
    const next = { top: node.scrollTop, height: node.clientHeight };
    setView((previous) => {
      if (previous.height !== next.height) return next;
      const before = virtualRange(currentSizes.current, previous.top, previous.height);
      const after = virtualRange(currentSizes.current, next.top, next.height);
      return before.start === after.start &&
        before.end === after.end &&
        before.offset === after.offset &&
        currentSizes.current.find(previous.top) === currentSizes.current.find(next.top)
        ? previous
        : next;
    });
  };
  const measure = () => {
    const node = scroll.current;
    if (!node) return;
    updateRange(node);
    callbacks.current.onWidth(node.clientWidth);
    callbacks.current.onResize?.();
  };
  useImperativeHandle(viewportRef, () => ({
    element: () => scroll.current,
    scrollTo: (top, left) => {
      const node = scroll.current;
      if (!node) return;
      node.scrollTop = top;
      if (left !== undefined) node.scrollLeft = left;
      measure();
      callbacks.current.onScroll(node.scrollTop);
    },
  }));
  useLayoutEffect(measure, [sizes]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(scroll.current!);
    return () => observer.disconnect();
  }, []);
  const range = virtualRange(sizes, view.top, view.height);
  return (
    <div
      ref={scroll}
      className={className}
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        updateRange(event.currentTarget);
        onScroll(top);
      }}
    >
      <div className="virtual-list-canvas" style={{ height: sizes.total, minWidth: contentWidth }}>
        {stickyHeader && items.length > 0 && (
          <div className="virtual-list-sticky">
            <div>{stickyHeader(items[Math.max(0, sizes.find(view.top))])}</div>
          </div>
        )}
        <div className="virtual-list-layer" style={{ top: range.offset }}>
          {enabled &&
            items.slice(range.start, range.end).map((item, index) => (
              <div
                key={itemKey(item)}
                role="presentation"
                style={{ height: sizes.size(range.start + index) }}
              >
                {renderItem(item, range.start + index)}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function MeasuredRow({ children, measure }: { children: ReactNode; measure: (height: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(measure);
  callback.current = measure;
  useLayoutEffect(() => {
    const node = ref.current!;
    const update = () =>
      callback.current(
        node.getBoundingClientRect().height /
          (Number(getComputedStyle(document.body).getPropertyValue('--ui-scale')) || 1),
      );
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="virtual-measured-row">
      {children}
    </div>
  );
}

export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  estimate = 160,
  onEnd,
  label,
  stickyHeader,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  estimate?: number;
  onEnd?: () => void;
  label: string;
  stickyHeader?: (item: T) => ReactNode;
}) {
  const viewport = useRef<VirtualViewport>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [width, setWidth] = useState(0);
  const sizes = new SizeIndex(items.map((item) => heights[itemKey(item)] ?? estimate));
  const checkEnd = () => {
    const node = viewport.current?.element();
    if (node && node.clientHeight > 0 && node.scrollTop + node.clientHeight + 600 >= sizes.total) onEnd?.();
  };
  useLayoutEffect(checkEnd);
  return (
    <VirtualScroller
      viewportRef={viewport}
      items={items}
      sizes={sizes}
      enabled
      contentWidth={0}
      className="learning-list"
      label={label}
      stickyHeader={stickyHeader}
      itemKey={itemKey}
      onWidth={(next) => {
        if (next !== width) {
          setWidth(next);
          setHeights({});
        }
      }}
      onScroll={checkEnd}
      onResize={checkEnd}
      renderItem={(item, index) => (
        <MeasuredRow
          measure={(height) => {
            const key = itemKey(item);
            setHeights((previous) =>
              Math.abs((previous[key] ?? 0) - height) < 1 ? previous : { ...previous, [key]: height },
            );
          }}
        >
          {renderItem(item, index)}
        </MeasuredRow>
      )}
    />
  );
}
