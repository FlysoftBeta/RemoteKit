import { Button } from '@mui/material';
import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import { RemoteViewport } from '../app/remote-viewport';
import { SurfaceState } from '../failures';
import { LoadingRows } from '../learning/common';
import { RemoteDocumentHost } from './remote-document-host';

/** The content area of a compatibility-mode PDF tab: the owner's remote page, measured as a window. */
export function RemoteDocument({ filesTabId, onLocal }: { filesTabId: string; onLocal(): void }) {
  const host = useContext(RemoteDocumentHost);
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const tab = host?.tabs.find((item) => item.owner?.filesTabId === filesTabId);
  useLayoutEffect(() => setReady(false), [tab?.id]);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !host) return;
    const measure = () => {
      if (node.clientWidth && node.clientHeight) host.measure(node.clientWidth, node.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [host?.measure, tab?.id]);
  const error = tab
    ? (tab.documentError ?? tab.lifecycleRecoveryError)
    : new RemoteKitError('unavailable', '文档暂时无法在远端打开');
  return (
    <div className="remote-document" ref={box}>
      {error ? (
        <div className="remote-document-failed">
          <SurfaceState error={error} context={{ operation: '打开文档', scope: 'surface' }} />
          <Button onClick={onLocal}>切回本地阅读器</Button>
        </div>
      ) : (
        <>
          {tab && host && (
            <RemoteViewport
              key={tab.id}
              transport={host.transport}
              viewId={tab.webviewId}
              keyboardActive={host.keyboardActive}
              autoKeyboard={host.autoKeyboard}
              onFrameReady={setReady}
              showConnectingOverlay={false}
            />
          )}
          {!ready && (
            <div className="remote-document-opening" role="status">
              <span>正在打开文档…</span>
              <LoadingRows />
            </div>
          )}
        </>
      )}
    </div>
  );
}
