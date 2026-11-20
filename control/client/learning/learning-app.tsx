import { buildAction } from '../control/action-builder';
import { useCallback } from 'react';
import type { ProductState, ProductTab } from '../../shared/product';
import type { Action } from '../app/product-dialogs';
import type { WorkspaceCall } from '../app/window-state';
import { operationId } from '../control/product-operations';
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
      const command = buildAction({
        type: 'window.open',
        appId: 'files',
        placement: { mode: 'space' },
      });
      await props.action(command);
      await props.action({
        type: 'window.state',
        windowId: command.windowId,
        state: {
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
