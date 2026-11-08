import { createContext } from 'react';
import type { ViewerSession } from '../viewer-session';

export const SignInHost = createContext<{
  transport: ViewerSession;
  keyboardActive: boolean;
  measure: (width: number, height: number) => void;
  retry: (tabId: string) => void;
} | null>(null);
