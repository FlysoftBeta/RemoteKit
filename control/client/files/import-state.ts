import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './file-library-state';
import { ImportQueue, type ImportControls } from './import-queue';

export function useImportQueue(destination: 'library' | 'basket', windowId?: string): ImportControls {
  const { rpc, mutate, online, scope } = useLibrary();
  const [queue] = useState(
    () => new ImportQueue({ rpc, mutate: (method, params) => mutate(method, params, windowId) }, destination),
  );
  useEffect(() => queue.configure(online, scope), [queue, online, scope]);
  useEffect(() => () => queue.dispose(), [queue]);
  return useMemo(
    () => ({
      subscribe: queue.subscribe,
      getSnapshot: queue.getSnapshot,
      enqueue: queue.enqueue,
      discard: queue.discard,
      upload: queue.upload,
    }),
    [queue],
  );
}
