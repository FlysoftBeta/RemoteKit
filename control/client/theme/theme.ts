import { useReduceMotion } from '../app/motion-preference';
import { createTheme } from '@mui/material';
import { useMemo, useSyncExternalStore } from 'react';

type ColorScheme = 'light' | 'dark';
let preference: MediaQueryList | undefined;
const colorPreference = () => (preference ??= window.matchMedia('(prefers-color-scheme: dark)'));

export const colorScheme = {
  getSnapshot: (): ColorScheme => (colorPreference().matches ? 'dark' : 'light'),
  subscribe: (listener: () => void) => {
    const query = colorPreference();
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  },
};

export function createViewerTheme(mode = colorScheme.getSnapshot(), reduceMotion = false) {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string) => tokens.getPropertyValue(`--${name}`).trim();
  return createTheme({
    transitions: reduceMotion
      ? {
          getAutoHeightDuration: () => 0,
          duration: {
            shortest: 0,
            shorter: 0,
            short: 0,
            standard: 0,
            complex: 0,
            enteringScreen: 0,
            leavingScreen: 0,
          },
        }
      : undefined,
    palette: {
      mode,
      primary: { main: token('primary') },
      background: { default: token('surface-background'), paper: token('surface') },
      text: { primary: token('text-primary'), secondary: token('text-secondary') },
      divider: token('border'),
    },
    typography: { fontFamily: token('font-family'), fontSize: 14 },
    shape: { borderRadius: Number.parseFloat(token('radius-md')) },
    components: {
      MuiButtonBase: { defaultProps: { disableRipple: reduceMotion } },
      MuiIconButton: { defaultProps: { size: 'small' } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiDialog: { defaultProps: { transitionDuration: reduceMotion ? 0 : 150 } },
    },
  });
}

export function useViewerTheme() {
  const mode = useSyncExternalStore(colorScheme.subscribe, colorScheme.getSnapshot);
  const reduceMotion = useReduceMotion();
  return useMemo(() => createViewerTheme(mode, reduceMotion), [mode, reduceMotion]);
}
