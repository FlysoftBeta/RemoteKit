import { UploadQueueView } from '../files/file-library-controls';
import { createRoot, type Root } from 'react-dom/client';
import { RemoteKitError } from '../../shared/errors';
import { SurfaceState } from './components';
import { notices } from './notices';
import { presentFailure } from './present';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
export function showFailureScene(scene: 'notices' | 'item' | 'recovering' | 'calm' | 'action') {
  root?.unmount();
  host?.remove();
  notices.clear();
  if (scene === 'notices') {
    notices.post(
      'control:connection',
      presentFailure(new RemoteKitError('unavailable', ''), {
        operation: '恢复工作区连接',
        scope: 'global',
        connection: true,
      }),
    );
    notices.post(
      'task:download:b3',
      presentFailure(new RemoteKitError('internal', 'forced download failure'), {
        operation: '下载到我的文件',
        scope: 'global',
      }),
    );
    return;
  }
  host = document.createElement('div');
  host.dataset.b3FailureScene = scene;
  const visible = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (element) => element.getClientRects().length,
    );
  const viewport = visible('.remote-viewport');
  const item = visible('.library-tab [data-upload-queue-area]');
  const owner = scene === 'item' ? item : viewport;
  if (!owner) throw new Error(`Missing surface for ${scene}`);
  owner.appendChild(host);
  if (scene !== 'item') host.style.display = 'contents';
  root = createRoot(host);
  if (scene === 'item')
    root.render(
      <UploadQueueView
        busy={false}
        jobs={[
          {
            id: 'b3-upload',
            name: '课程资料.pdf',
            error: new RemoteKitError('internal', 'forced upload failure'),
          },
        ]}
      />,
    );
  else if (scene === 'action')
    root.render(
      <SurfaceState
        live
        error={new RemoteKitError('limit_exceeded', '', { capacity: 'windows' })}
        context={{ operation: '打开项目', scope: 'surface' }}
      />,
    );
  else
    root.render(
      <SurfaceState
        live
        error={new RemoteKitError('unavailable', '')}
        context={{ operation: '连接浏览器', scope: 'surface', connection: true }}
        since={Date.now() - (scene === 'calm' ? 30_000 : 1500)}
      />,
    );
}
