import { useEffect, useState } from 'react';
import type { TopDeadZone } from '../../shared/product';

// The system overlays the top edge with a notch/status bar (safe-area-inset-top, which needs
// viewport-fit=cover) or, for an installed app with window controls overlay, the title bar.
export interface TopInsets {
  safeArea: number;
  titleBar: number;
}

function probe(expression: string) {
  const element = document.createElement('div');
  element.style.cssText = `position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;padding-top:${expression}`;
  document.body.appendChild(element);
  const value = parseFloat(getComputedStyle(element).paddingTop) || 0;
  element.remove();
  return Math.round(value);
}

export function probeTopInsets(): TopInsets {
  return {
    safeArea: probe('env(safe-area-inset-top, 0px)'),
    titleBar: probe('env(titlebar-area-height, 0px)'),
  };
}

const sameInsets = (a: TopInsets, b: TopInsets) => a.safeArea === b.safeArea && a.titleBar === b.titleBar;

export function useTopInsetProbe() {
  const [insets, setInsets] = useState<TopInsets>(() =>
    typeof document === 'undefined' ? { safeArea: 0, titleBar: 0 } : probeTopInsets(),
  );
  useEffect(() => {
    const update = () => {
      const next = probeTopInsets();
      setInsets((current) => (sameInsets(current, next) ? current : next));
    };
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return insets;
}

// Height of the reserved strip in visual CSS px. The safe area is always kept clear because the
// page opts into viewport-fit=cover; the setting can only add to it.
export function deadZoneHeight(setting: TopDeadZone, insets: TopInsets) {
  if (setting === 'off') return insets.safeArea;
  if (setting === 'auto') return Math.max(insets.safeArea, insets.titleBar);
  return Math.max(insets.safeArea, setting);
}
