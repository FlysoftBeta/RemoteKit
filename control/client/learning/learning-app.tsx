import { useCallback } from 'react';
import type { ProductState, ProductTab } from '../../shared/product';
import type { Action } from '../app/product-dialogs';
import type { WorkspaceCall } from '../app/window-state';
import { operationId } from '../control/product-operations';
import { waitForWorkspaceRevision } from '../app/window-state';
import type { ViewerSession } from '../viewer-session';
import { StudyApp } from './study/study-app';
import { QuestionsApp } from './questions/questions-app';
import './learning.css';

export interface LearningAppProps {
  windowId: string;
  state: ProductState;
  tab?: ProductTab;
  call: WorkspaceCall;
  action: Action;
  online: boolean;
  transport: ViewerSession;
}

export function LearningApp(props: LearningAppProps & { appId: 'study' | 'questions' }) {
  const openFiles = useCallback(
    async (entryId?: string, subject?: string) => {
      const result = await props.action({
        type: 'window.open',
        appId: 'files',
        placement: { mode: 'space' },
      });
      const workspace = await waitForWorkspaceRevision(props.transport, result.revision ?? 0);
      const window = workspace.windows.find(
        (win) =>
          win.appId === 'files' &&
          workspace.spaces.find((space) => space.id === workspace.activeSpaceId)?.windowIds.includes(win.id),
      );
      if (window)
        await props.action({
          type: 'window.state',
          windowId: window.id,
          state: {
            ...window.state,
            launch: {
              requestId: operationId(),
              entryId,
              view: { source: { app: 'study', channel: subject ?? '' } },
            },
          },
        });
    },
    [props.action, props.call, props.transport],
  );
  return props.appId === 'study' ? (
    <StudyApp {...props} openFiles={openFiles} />
  ) : (
    <QuestionsApp {...props} />
  );
}
