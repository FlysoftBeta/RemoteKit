import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ProductTab } from '../../shared/product';
import { RemoteViewport } from '../app/remote-viewport';
import { InlineError, LoadingRows } from './common';
import { SignInHost } from './sign-in-host';

export function SignInView({ tab }: { tab?: ProductTab }) {
  const host = useContext(SignInHost);
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
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
  }, [host, tab?.id]);
  const error =
    tab?.lifecycleRecoveryError ||
    (tab?.popup?.status === 'failed' ? tab.popup.error || '登录页面打开失败' : '');
  return (
    <div className="learning-sign-in-view" ref={box}>
      {error ? (
        <InlineError error={error} retry={() => tab && host?.retry(tab.id)} />
      ) : (
        <>
          {tab && host && (
            <RemoteViewport
              key={tab.id}
              transport={host.transport}
              viewId={tab.webviewId}
              keyboardActive={host.keyboardActive}
              onFrameReady={setReady}
              showConnectingOverlay={false}
            />
          )}
          {!ready && (
            <div className="learning-sign-in-opening" role="status">
              <span>正在打开登录页面…</span>
              <LoadingRows />
            </div>
          )}
        </>
      )}
    </div>
  );
}
