import './window-tab.css';
import { Close } from '@mui/icons-material';
import { ButtonBase, IconButton } from '@mui/material';
import React from 'react';

// One tab of the tab strip: the selectable body is a ButtonBase (ripple, focus-visible, no native
// tap highlight) and the close control is an IconButton. Drag, ordering and commands stay with the
// owner; this component only renders a tab and reports intents.
export function WindowTab({
  id,
  title,
  icon,
  closeLabel,
  selected,
  disabled,
  attention,
  dragSource,
  shift,
  onPointerDown,
  onContextMenu,
  onSelect,
  onClose,
  onKeyDown,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  closeLabel: string;
  selected: boolean;
  disabled: boolean;
  attention?: boolean;
  dragSource: boolean;
  shift: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu: (anchor: HTMLElement) => void;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className={`window-tab${selected ? ' selected-tab' : ''}${dragSource ? ' tab-drag-source' : ''}`}
      data-tab-id={id}
      style={{ transform: `translateX(${shift}px)` }}
      onPointerDown={onPointerDown}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.currentTarget);
      }}
    >
      <ButtonBase
        className="tab-select"
        role="tab"
        disabled={disabled}
        tabIndex={selected ? 0 : -1}
        aria-selected={selected}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        {icon}
        <span className="tab-title">{title}</span>
        {attention && <span className="tab-attention" aria-label="页面等待处理请求" />}
      </ButtonBase>
      <IconButton className="tab-close" aria-label={closeLabel} disabled={disabled} onClick={onClose}>
        <Close fontSize="inherit" />
      </IconButton>
    </div>
  );
}

export function TabDragGhost({
  title,
  icon,
  left,
  top,
  width,
}: {
  title: string;
  icon: React.ReactNode;
  left: number;
  top: number;
  width: number;
}) {
  return (
    <div className="window-tab selected-tab tab-drag-ghost" aria-hidden style={{ left, top, width }}>
      <span className="tab-select">
        {icon}
        <span className="tab-title">{title}</span>
      </span>
    </div>
  );
}
