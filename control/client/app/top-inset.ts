import { useEffect, useState } from 'react';

export interface TopInsets {
  safeArea: number;
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
  };
}

const sameInsets = (a: TopInsets, b: TopInsets) => a.safeArea === b.safeArea;

export function useTopInsetProbe() {
  const [insets, setInsets] = useState<TopInsets>(() =>
    typeof document === 'undefined' ? { safeArea: 0 } : probeTopInsets(),
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

export function topInsetHeight(compatibility: boolean, insets: TopInsets) {
  return Math.max(insets.safeArea, compatibility ? 24 : 0);
}
