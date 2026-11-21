import { createContext } from 'react';
import type { ProductTab } from '../../shared/product';
import type { ViewerSession } from '../viewer-session';

/** What a Files window needs to show a document through a remote page of its own. */
export const RemoteDocumentHost = createContext<{
  transport: ViewerSession;
  keyboardActive: boolean;
  autoKeyboard: boolean;
  /** Remote tabs owned by this window's Files tabs. */
  tabs: ProductTab[];
  measure: (width: number, height: number) => void;
} | null>(null);
