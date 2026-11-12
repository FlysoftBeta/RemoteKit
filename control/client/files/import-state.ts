import { useEffect } from 'react';
import { useLibrary } from './file-library-state';
import type { ImportControls } from './import-queue';

export function useImportQueue(destination: 'library' | 'basket', windowId?: string): ImportControls {
  const { importQueue } = useLibrary();
  const queue = importQueue(destination, windowId);
  useEffect(queue.show, [queue]);
  return queue;
}
