import { createContext, useCallback, useContext, useRef } from 'react';

export const KeyboardPreferenceContext = createContext(false);

export function useAutoFocus<T extends HTMLInputElement | HTMLTextAreaElement>(
  enabled = true,
): (element: T | null) => void {
  const autoOpen = useContext(KeyboardPreferenceContext);
  const options = useRef({ enabled, autoOpen });
  options.current = { enabled, autoOpen };
  const cleanup = useRef<(() => void) | undefined>(undefined);
  return useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = undefined;
    if (!element || !options.current.enabled) return;
    if (!options.current.autoOpen && window.matchMedia('(pointer: coarse)').matches) {
      const inputMode = element.getAttribute('inputmode');
      const restore = () => {
        if (inputMode === null) element.removeAttribute('inputmode');
        else element.setAttribute('inputmode', inputMode);
        element.removeEventListener('pointerdown', restore, true);
        element.removeEventListener('blur', restore);
        cleanup.current = undefined;
      };
      element.inputMode = 'none';
      element.addEventListener('pointerdown', restore, true);
      element.addEventListener('blur', restore);
      cleanup.current = restore;
    }
    element.focus({ preventScroll: true });
  }, []);
}
