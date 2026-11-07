import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { DiagnosticState } from '../media/diagnostic-collection';
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
      <SettingRow description="收集连接、媒体与性能信息，停止后保存在服务端。" title="诊断数据收集">
        <Button
          variant="outlined"
          onClick={start}
          disabled={!online || (state.phase !== 'idle' && state.phase !== 'start-error')}
        >
          {state.phase === 'starting' ? '正在开始…' : '开始诊断'}
        </Button>
      </SettingRow>
      {state.phase === 'start-error' && (
        <Alert severity="error" sx={{ mt: 1 }}>
          未能确认诊断已开始，请重试。
        </Alert>
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
  return state.phase === 'complete' || state.phase === 'failed' ? (
    <DiagnosticResult
      key={state.id}
      id={state.id}
      complete={state.phase === 'complete'}
      missingSamples={state.missingSamples}
      reason={state.reason}
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
  dismiss,
}: {
  id: string;
  complete: boolean;
  missingSamples: number;
  reason?: string;
  dismiss: () => void;
}) {
  const [copy, setCopy] = useState<'copied' | 'error'>();
  return (
    <Dialog open onClose={dismiss} fullWidth maxWidth="xs">
      <DialogTitle>{complete ? '诊断已保存' : '诊断保存失败'}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {complete ? '可将诊断 ID 提供给服务端维护人员。' : '请记录此 ID，关闭后可重新开始诊断。'}
        </Typography>
        {reason && stopReasons.has(reason) && (
          <Typography variant="body2" sx={{ mb: 2 }}>
            {stopReasons.get(reason)}
          </Typography>
        )}
        {missingSamples > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            有 {missingSamples} 次客户端采样未完成或未收到确认。
          </Alert>
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
