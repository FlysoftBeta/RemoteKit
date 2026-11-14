import { useEffect, useRef } from 'react';
import type { ProductState } from '../../shared/product';
import type { SessionImportSocketMethods } from '../../shared/session-import';
import { RemoteKitError } from '../../shared/errors';
import { notices } from './notices';
import { presentFailure } from './present';
import { RetryUnit } from '../../shared/retry-unit';

type ImportCall = <K extends keyof SessionImportSocketMethods>(
  method: K,
  params: SessionImportSocketMethods[K]['params'],
) => Promise<SessionImportSocketMethods[K]['result']>;

export function useBackgroundNotices(state: ProductState | null, online: boolean, call: ImportCall) {
  const importResults = useRef(new Map<string, string>());
  useEffect(() => {
    if (!online) return;
    let active = true;
    let pending = false;
    const unit = new RetryUnit();
    const update = async () => {
      if (!active || pending || !unit.ready()) return;
      pending = true;
      try {
        const result = await call('sessionImport.state', {});
        unit.succeed();
        notices.resolve('poll:session-import');
        if (!active) return;
        const visible = !!document.querySelector('[data-session-import]');
        for (const entry of result.timeline) {
          const record = entry.record;
          if (!record) continue;
          const key = 'task:session-import:' + record.id;
          if (visible) {
            notices.resolve(key);
            continue;
          }
          const signature = JSON.stringify([record.state, record.error]);
          if (importResults.current.get(key) === signature) continue;
          const previous = importResults.current.get(key);
          importResults.current.set(key, signature);
          if (!previous && record.state === 'applied') continue;
          if (record.state === 'discarded') notices.resolve(key);
          else if (record.error)
            notices.post(
              key,
              presentFailure(record.error, {
                operation: '导入手机会话',
                scope: 'global',
                targetId: record.id,
                consequence: '已完成的写入仍保留',
              }),
            );
          else if (record.state === 'pending')
            notices.post(
              key,
              presentFailure(new RemoteKitError('unavailable', ''), {
                operation: '导入手机会话',
                scope: 'global',
                text: '已收到手机会话，等待浏览器恢复后写入',
              }),
            );
          else notices.post(key, { class: 'B', text: '手机会话已导入' });
        }
      } catch (error) {
        const failure = unit.fail(error);
        if (failure.first)
          notices.post(
            'poll:session-import',
            presentFailure(failure.error, { operation: '读取会话导入状态', scope: 'global' }),
          );
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => {
      active = false;
      unit.close();
      clearInterval(timer);
    };
  }, [online, call]);
  useEffect(() => {
    if (!state) return;
    const space = state.workspace.spaces.find((space) => space.id === state.workspace.activeSpaceId);
    const visible = state.workspace.windows.some(
      (win) => win.appId === 'study' && space?.windowIds.includes(win.id),
    );
    const key = 'task:study-sync:changyan';
    const sync = state.learning.study;
    const activeAttachments = new Set(
      (sync.attachmentFailures ?? []).map((failure) => 'task:attachment:changyan:' + failure.key),
    );
    for (const notice of notices.getSnapshot())
      if (notice.key.startsWith('task:attachment:changyan:') && !activeAttachments.has(notice.key))
        notices.resolve(notice.key);
    for (const failure of sync.attachmentFailures ?? []) {
      const attachmentKey = 'task:attachment:changyan:' + failure.key;
      if (visible) notices.resolve(attachmentKey);
      else
        notices.post(
          attachmentKey,
          presentFailure(failure.error, {
            operation: '保存附件',
            scope: 'global',
            targetId: failure.key,
            credential: 'changyan',
            consequence: '其他已保存资料仍可查看',
          }),
        );
    }
    if (visible || (!sync.syncing && !sync.error)) notices.resolve(key);
    else
      notices.post(
        key,
        presentFailure(sync.error ?? new RemoteKitError('unavailable', ''), {
          operation: '同步学习资料',
          scope: 'global',
          credential: 'changyan',
          consequence: '已保存资料仍可查看',
        }),
      );
  }, [state?.learning, state?.workspace]);
}
