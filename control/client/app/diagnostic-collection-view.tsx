import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { RemoteKitError, type WireError } from '../../shared/errors';
import { FailureNote, notices, presentFailure } from '../failures';
import type { DiagnosticState } from '../media/diagnostic-collection';
import { recoveryDelay } from '../failures/recovery';
import { SettingRow, SettingSection } from './setting-layout';

export function DiagnosticSettings({
  state,
  online,
  start,
}: {
  state: DiagnosticState;
  online: boolean;
  start: () => void;
}) {
  return (
    <SettingSection title="诊断">
      <span data-diagnostic-settings />
      <SettingRow description="收集连接、媒体与性能信息，停止后保存在服务端。" title="诊断数据收集">
        <Button variant="outlined" onClick={start} disabled={!online || state.phase !== 'idle'}>
          {state.phase === 'starting' ? '正在开始…' : '开始诊断'}
        </Button>
      </SettingRow>
      {state.phase === 'start-error' && (
        <FailureNote error={state.error} context={{ operation: '开始诊断', scope: 'surface' }} />
      )}
    </SettingSection>
  );
}

export function DiagnosticCollectionView({
  state,
  dismiss,
}: {
  state: DiagnosticState;
  dismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () =>
      setVisible(!!document.querySelector('[data-diagnostic-settings]')?.getClientRects().length);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    return () => observer.disconnect();
  }, []);
  const sourceKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const nextKey =
      'id' in state
        ? 'task:diagnostic:' + state.id
        : state.phase === 'start-error'
          ? 'task:diagnostic-start'
          : undefined;
    if (sourceKey.current !== nextKey && sourceKey.current) notices.resolve(sourceKey.current);
    sourceKey.current = nextKey;
    if (state.phase === 'start-error') {
      if (visible) notices.resolve('task:diagnostic-start');
      else
        notices.post(
          'task:diagnostic-start',
          presentFailure(state.error, {
            operation: '开始诊断',
            scope: 'global',
            consequence: '本次诊断尚未开始',
          }),
        );
      return;
    }
    if (!('id' in state)) return;
    const key = 'task:diagnostic:' + state.id;
    if (visible) {
      notices.resolve(key);
      return;
    }
    if (state.phase === 'complete')
      notices.post(key, { class: 'B', text: `诊断已保存，诊断 ID ${state.id}` });
    else
      notices.post(
        key,
        presentFailure(
          state.error ?? new RemoteKitError(state.phase === 'failed' ? 'internal' : 'unavailable', ''),
          {
            operation: '确认诊断保存结果',
            scope: 'global',
            text: state.phase === 'collecting' ? '正在收集诊断数据…' : undefined,
            longText: state.phase === 'collecting' ? '仍在收集诊断数据，停止后自动保存' : undefined,
            consequence: '当前诊断已结束',
          },
        ),
      );
  }, [state, visible]);
  return visible && (state.phase === 'complete' || state.phase === 'failed') ? (
    <DiagnosticResult
      key={state.id}
      id={state.id}
      complete={state.phase === 'complete'}
      missingSamples={state.missingSamples}
      reason={state.reason}
      error={state.error}
      sampleError={state.sampleFailures?.[0]?.error}
      dismiss={dismiss}
    />
  ) : null;
}

const stopReasons = new Map([
  ['duration-limit', '已达到诊断时长上限。'],
  ['size-limit', '已达到诊断数据量上限。'],
  ['disconnected', '连接中断，收集已停止。'],
  ['authorization-changed', '登录状态变化，收集已停止。'],
  ['shutdown', '服务端停止运行，收集已停止。'],
]);

function DiagnosticResult({
  id,
  complete,
  missingSamples,
  reason,
  error,
  sampleError,
  dismiss,
}: {
  id: string;
  complete: boolean;
  missingSamples: number;
  reason?: string;
  error?: WireError | import('../../shared/errors').RemoteKitError;
  sampleError?: RemoteKitError;
  dismiss: () => void;
}) {
  const [copy, setCopy] = useState<'copied' | 'error'>();
  return (
    <Dialog open onClose={dismiss} fullWidth maxWidth="xs">
      <DialogTitle>{complete ? '诊断已保存' : '诊断保存失败'}</DialogTitle>
      <DialogContent>
        <FailureNote
          error={error}
          context={{ operation: '保存诊断包', scope: 'surface', consequence: '当前诊断已结束' }}
        />
        <Typography variant="body2" sx={{ mb: 2 }}>
          {complete ? '可将诊断 ID 提供给服务端维护人员。' : '当前诊断已结束，诊断包未能保存。'}
        </Typography>
        {reason && stopReasons.has(reason) && (
          <Typography variant="body2" sx={{ mb: 2 }}>
            {stopReasons.get(reason)}
          </Typography>
        )}
        {missingSamples > 0 && (
          <>
            <Typography variant="body2">
              部分样本未能收集或确认，当前诊断包含已收到的样本（{missingSamples} 次未完成）
            </Typography>
            <FailureNote
              error={sampleError && recoveryDelay(sampleError, 0) === undefined ? sampleError : undefined}
              context={{
                operation: '收集诊断样本',
                scope: 'item',
                consequence: `诊断包含已收到的样本，${missingSamples} 次未完成`,
              }}
            />
          </>
        )}
        <TextField
          label="诊断 ID"
          value={id}
          size="small"
          fullWidth
          slotProps={{ input: { readOnly: true } }}
          onFocus={(event) => (event.target as HTMLInputElement).select()}
        />
        {copy && (
          <Typography variant="body2" role="status" sx={{ mt: 1 }}>
            {copy === 'copied' ? '已复制' : '复制失败，可选中诊断 ID 手动复制。'}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {typeof navigator.clipboard?.writeText === 'function' && (
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(id).then(
                () => setCopy('copied'),
                () => setCopy('error'),
              )
            }
          >
            复制 ID
          </Button>
        )}
        <Button onClick={dismiss}>完成</Button>
      </DialogActions>
    </Dialog>
  );
}
