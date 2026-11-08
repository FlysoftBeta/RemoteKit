import { RemoteKitError } from './errors';
import type { PageDialogReply, ProductAction } from './product';

export type RecordedAction =
  | Exclude<ProductAction, { type: 'page.reply' }>
  | {
      type: 'page.reply';
      dialogId: string;
      reply: Exclude<PageDialogReply, { kind: 'http_auth' }> | { kind: 'http_auth'; accept: boolean };
    };

export function recordedAction(action: ProductAction): RecordedAction {
  if (action.type !== 'page.reply') return action;
  const { type, dialogId, reply } = action;
  if (reply && typeof reply === 'object') {
    switch (reply.kind) {
      case 'http_auth':
        return { type, dialogId, reply: { kind: 'http_auth', accept: reply.accept === true } };
      case 'dialog':
        return {
          type,
          dialogId,
          reply: {
            kind: 'dialog',
            accept: reply.accept,
            ...(reply.text === undefined ? {} : { text: reply.text }),
          },
        };
      case 'permission':
        return { type, dialogId, reply: { kind: 'permission', decision: reply.decision } };
      case 'repost':
        return { type, dialogId, reply: { kind: 'repost', accept: reply.accept } };
      case 'protocol_handler':
        return {
          type,
          dialogId,
          reply: { kind: 'protocol_handler', accept: reply.accept, remember: reply.remember },
        };
    }
  }
  throw new RemoteKitError('invalid_request', '无效的页面对话回复');
}
