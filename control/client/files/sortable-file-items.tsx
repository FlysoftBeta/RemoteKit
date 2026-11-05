import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DragIndicator } from '@mui/icons-material';
import { Box, IconButton, Typography } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { basketDragCurrent, basketDrop, type BasketDrag } from './basket-order';

export type FileView = 'cards' | 'list';
export interface SortActivator {
  ref: (node: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}
interface SortableItem {
  id: string;
  name: string;
}
export interface SortablePresentation {
  activator?: SortActivator;
  handle?: React.ReactNode;
  dragging: boolean;
  index: number;
  overlay?: boolean;
}
const cardWidth = 144;

function SortableFileItem({
  id,
  name,
  index,
  mode,
  renderItem,
  disabled,
  isCurrent,
  anyDrag,
  width,
}: {
  id: string;
  name: string;
  index: number;
  mode: FileView;
  renderItem: (props: SortablePresentation) => React.ReactNode;
  disabled: boolean;
  isCurrent: boolean;
  anyDrag: boolean;
  width: number;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
    index: currentIndex,
    activeIndex,
  } = useSortable({ id, disabled: { draggable: disabled, droppable: false } });
  const cards = mode === 'cards';
  const lifted = isCurrent && isDragging;
  const marker =
    isCurrent && isOver && !isDragging ? (activeIndex < currentIndex ? 'after' : 'before') : undefined;
  const enabled = !disabled && (!anyDrag || isDragging);
  const activator = enabled && cards ? { attributes, listeners, ref: setActivatorNodeRef } : undefined;
  const handle = !cards ? (
    <IconButton
      {...attributes}
      {...listeners}
      ref={setActivatorNodeRef}
      aria-label={`拖动排序 ${name}`}
      disabled={!enabled}
      sx={{
        width: 44,
        height: 44,
        touchAction: 'none',
        cursor: lifted ? 'grabbing' : 'grab',
        color: 'text.secondary',
        '&:hover': { color: 'primary.main' },
      }}
    >
      <DragIndicator fontSize="small" />
    </IconButton>
  ) : undefined;
  const markerStyle =
    marker &&
    (cards
      ? { top: 4, bottom: 4, width: 2, left: marker === 'before' ? -6 : 'calc(100% + 4px)' }
      : { left: 0, right: 0, height: 2, top: marker === 'before' ? 0 : 'calc(100% - 2px)' });
  return (
    <Box
      component="li"
      ref={setNodeRef}
      data-sort-item={id}
      data-sort-target={marker}
      style={{
        transform: isCurrent ? CSS.Transform.toString(transform) : undefined,
        transition: isCurrent ? transition : undefined,
      }}
      sx={{
        width: cards ? width : '100%',
        flex: '0 0 auto',
        position: 'relative',
        scrollSnapAlign: cards ? 'start' : undefined,
        '&::before': lifted
          ? {
              content: '""',
              position: 'absolute',
              inset: 0,
              bgcolor: 'action.hover',
              border: '1px dashed',
              borderColor: 'divider',
              borderRadius: '10px',
              pointerEvents: 'none',
            }
          : undefined,
        '&::after': markerStyle
          ? {
              ...markerStyle,
              content: '""',
              position: 'absolute',
              zIndex: 2,
              bgcolor: 'primary.main',
              borderRadius: 1,
              pointerEvents: 'none',
            }
          : undefined,
      }}
    >
      <Box sx={{ opacity: lifted ? 0.18 : 1 }}>
        {renderItem({ handle, activator, dragging: anyDrag, index })}
      </Box>
    </Box>
  );
}

export function SortableFileItems<T extends SortableItem>({
  items,
  revision,
  mode,
  disabled,
  label,
  renderItem,
  onChange,
  onDragging,
  compact = false,
}: {
  items: T[];
  compact?: boolean;
  revision: number;
  mode: FileView;
  disabled: boolean;
  label: string;
  renderItem: (item: T, props: SortablePresentation) => React.ReactNode;
  onChange: (ids: string[], revision: number) => Promise<void>;
  onDragging: (value: boolean) => void;
}) {
  const cards = mode === 'cards';
  const ids = items.map((item) => item.id);
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<BasketDrag | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ ids: string[]; revision: number }>();
  const [scrollEdge, setScrollEdge] = useState(0.16);
  const stale = !!activeId && (!drag.current || disabled || !basketDragCurrent(drag.current, ids, revision));
  const byId = new Map(items.map((item) => [item.id, item]));
  const active = !stale && activeId ? byId.get(activeId) : undefined;
  const order = saving?.revision === revision && saving.ids.every((id) => byId.has(id)) ? saving.ids : ids;
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const mouse = useSensor(MouseSensor, { activationConstraint: { distance: 6 } });
  const touch = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } });
  const keyboard = useSensor(KeyboardSensor, {
    keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Enter', 'Space'] },
    coordinateGetter: (event, args) => {
      const arrows = cards ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (arrows.includes(event.code)) return sortableKeyboardCoordinates(event, args);
      if (!['Home', 'End'].includes(event.code)) return;
      const bounds = args.context.droppableRects.get(ids[event.code === 'Home' ? 0 : ids.length - 1]);
      if (!bounds) return;
      event.preventDefault();
      return { x: bounds.left, y: bounds.top };
    },
  });
  const sensors = useSensors(cards ? mouse : pointer, cards ? touch : undefined, keyboard);
  useEffect(
    () => () => {
      if (drag.current) onDragging(false);
    },
    [onDragging],
  );
  useEffect(() => {
    if (!activeId) return;
    const invalidate = () => {
      drag.current = null;
      setActiveId(null);
      onDragging(false);
    };
    document.addEventListener('pointercancel', invalidate, true);
    return () => document.removeEventListener('pointercancel', invalidate, true);
  }, [activeId, onDragging]);
  function endDrag() {
    drag.current = null;
    setActiveId(null);
    onDragging(false);
  }
  function name(id: string | number) {
    return byId.get(String(id))?.name ?? '文件';
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={(args) => {
          const point = args.pointerCoordinates;
          const bounds = (
            cards ? list.current : compact ? list.current : list.current?.closest('.MuiDialogContent-root')
          )?.getBoundingClientRect();
          if (
            point &&
            bounds &&
            (point.x < bounds.left ||
              point.x > bounds.right ||
              point.y < bounds.top ||
              point.y > bounds.bottom)
          )
            return [];
          return closestCenter(args);
        }}
        modifiers={[({ transform }) => (cards ? { ...transform, y: 0 } : { ...transform, x: 0 })]}
        autoScroll={
          active
            ? {
                acceleration: 4.5,
                interval: 10,
                threshold: cards ? { x: scrollEdge, y: 0 } : { x: 0, y: scrollEdge },
                canScroll: (element) =>
                  element ===
                  (cards
                    ? list.current
                    : compact
                      ? list.current
                      : list.current?.closest('.MuiDialogContent-root')),
              }
            : false
        }
        cancelDrop={() => !drag.current || disabled || !basketDragCurrent(drag.current, ids, revision)}
        accessibility={{
          screenReaderInstructions: {
            draggable: `按空格拿起，按${cards ? '左右' : '上下'}方向键调整位置，按回车或空格放下，按退出键取消。`,
          },
          announcements: {
            onDragStart: ({ active }) => `拿起 ${name(active.id)}。`,
            onDragOver: ({ active, over }) =>
              over
                ? `${name(active.id)} 的目标位置是第 ${ids.indexOf(String(over.id)) + 1} 项。`
                : '已移出排序区域。',
            onDragEnd: ({ active, over }) =>
              over && active.id !== over.id ? `已放下 ${name(active.id)}。` : '顺序未更改。',
            onDragCancel: () => '已取消拖动，顺序未更改。',
          },
        }}
        onDragStart={({ active }) => {
          drag.current = { id: String(active.id), ids, revision };
          setActiveId(drag.current.id);
          onDragging(true);
          const extent = cards
            ? list.current?.clientWidth
            : (compact ? list.current : list.current?.closest('.MuiDialogContent-root'))?.clientHeight;
          if (extent) setScrollEdge(Math.min(0.5, 36 / extent));
        }}
        onDragCancel={endDrag}
        onDragEnd={({ over }) => {
          const result = disabled
            ? undefined
            : basketDrop(drag.current, over ? String(over.id) : undefined, ids, revision);
          endDrag();
          if (!result) return;
          setSaving(result);
          void onChange(result.ids, result.revision).finally(() => setSaving(undefined));
        }}
      >
        <SortableContext
          items={order}
          strategy={cards ? horizontalListSortingStrategy : verticalListSortingStrategy}
        >
          <Box
            component="ul"
            ref={list}
            aria-label={label}
            sx={{
              m: 0,
              p: 0,
              listStyle: 'none',
              flexShrink: 0,
              ...(cards
                ? {
                    display: 'flex',
                    gap: compact ? '6px' : '10px',
                    overflowX: 'auto',
                    overflowY: 'hidden',
                    scrollSnapType: active ? 'none' : 'x proximity',
                    scrollPaddingInline: '4px',
                    px: 0.5,
                    pt: 0.5,
                    pb: 0.75,
                    '&::-webkit-scrollbar': { height: 6 },
                    '&::-webkit-scrollbar-thumb': { bgcolor: 'divider', borderRadius: 3 },
                  }
                : compact
                  ? { maxHeight: 170, overflowY: 'auto' }
                  : {}),
            }}
          >
            {order.map((id, index) => {
              const item = byId.get(id);
              return (
                item && (
                  <SortableFileItem
                    key={id}
                    id={id}
                    name={item.name}
                    index={index}
                    mode={mode}
                    width={compact ? 96 : cardWidth}
                    disabled={disabled || !!saving || ids.length < 2}
                    isCurrent={!!active}
                    anyDrag={!!activeId}
                    renderItem={(flags) => renderItem(item, flags)}
                  />
                )
              );
            })}
          </Box>
        </SortableContext>
        {createPortal(
          <DragOverlay zIndex={1500} dropAnimation={null}>
            {active && (
              <Box
                aria-hidden="true"
                data-basket-drag-overlay
                sx={{
                  borderRadius: '10px',
                  boxShadow: 3,
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  pointerEvents: 'none',
                }}
              >
                {renderItem(active, { index: ids.indexOf(active.id), dragging: true, overlay: true })}
              </Box>
            )}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      {stale && (
        <Typography variant="caption" role="status">
          列表已更新，已取消排序
        </Typography>
      )}
    </>
  );
}
