import './selection-menu.css';
import { ButtonBase, Paper } from '@mui/material';
import { useLayoutEffect, useRef } from 'react';
import type { Surface } from '../presentation/types';
import type { SelectionCommand, SelectionMenu as Menu } from '../rtc/protocol';
import { placeSelectionMenu, type ViewportGeometry } from './viewport-geometry';

const labels: Record<SelectionCommand, string> = {
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
};

export function SelectionMenu({
  menu,
  surface,
  geometry,
  onCommand,
}: {
  menu: Menu;
  surface: Surface;
  geometry: ViewportGeometry;
  onCommand: (command: SelectionCommand) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const place = () => {
      const position = placeSelectionMenu(surface, menu, geometry, node.offsetWidth);
      node.style.left = `${position.left}px`;
      node.style.top = `${position.top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => observer.disconnect();
  }, [surface, menu, geometry]);
  if (!menu.commands.length) return null;
  return (
    <Paper ref={root} className="selection-menu" elevation={0} role="toolbar" aria-label="文本选择">
      {menu.commands.map((command) => (
        <ButtonBase
          key={command}
          className="selection-menu-command"
          disableRipple
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onCommand(command)}
        >
          {labels[command]}
        </ButtonBase>
      ))}
    </Paper>
  );
}
