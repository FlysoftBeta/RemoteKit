import DeleteOutline from '@mui/icons-material/DeleteOutline';
import Download from '@mui/icons-material/Download';
import {
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Fragment, useState } from 'react';
import type { AdminDiagnostic } from '../../../shared/admin';
import { RemoteKitError } from '../../../shared/errors';
import { failureError, FailureNote } from '../../failures';
import {
  ConfirmDialog,
  formatBytes,
  formatDateTime,
  LoadState,
  SectionHeader,
  useAdminResource,
  type AdminCall,
  type ErrorSearchResult,
} from './shared';

function ErrorRecord({ source, line }: { source: string; line: string }) {
  const [open, setOpen] = useState(false);
  let record: { ts?: string; lvl?: string; ev?: string; err?: { message?: string; detail?: string } } = {};
  try {
    record = JSON.parse(line);
  } catch {
    record = { ev: '无法解析此行，展开查看原文' };
  }
  const level = record?.lvl;
  return (
    <Fragment>
      <TableRow
        hover
        onClick={() => setOpen(!open)}
        sx={{ cursor: 'pointer' }}
        aria-expanded={open}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <TableCell>{record?.ts ?? '—'}</TableCell>
        <TableCell>
          <Chip
            size="small"
            label={level ?? '—'}
            color={level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'default'}
          />
        </TableCell>
        <TableCell>{record?.ev ?? '—'}</TableCell>
        <TableCell>{source}</TableCell>
        <TableCell>{[record?.err?.message, record?.err?.detail].filter(Boolean).join(' · ')}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={5} sx={{ p: 0, borderBottom: open ? undefined : 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 2,
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                maxHeight: 300,
                overflow: 'auto',
                bgcolor: 'background.default',
              }}
            >
              {line}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function ErrorLookup({ online, call }: { online: boolean; call: AdminCall }) {
  const [errorId, setErrorId] = useState('');
  const [result, setResult] = useState<ErrorSearchResult | null>(null);
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Box sx={{ mb: 3 }}>
      <SectionHeader title="查找错误 ID" />
      <Box
        component="form"
        sx={{ display: 'flex', gap: 1, mb: 2 }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !online) return;
          setBusy(true);
          setError(undefined);
          setResult(null);
          try {
            setResult(await call('admin.findError', { errorId: errorId.trim() }));
          } catch (error) {
            setError(failureError(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          size="small"
          label="错误 ID"
          placeholder="c-…、e-… 或 v-…"
          value={errorId}
          onChange={(event) => setErrorId(event.target.value)}
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
        />
        <Button type="submit" variant="outlined" disabled={!online || busy || !errorId.trim()}>
          查找
        </Button>
      </Box>
      <LoadState error={error} loading={busy} />
      {result && result.records.length === 0 && (
        <Typography color="text.secondary">没有找到（日志可能已轮转）</Typography>
      )}
      {result && result.records.length > 0 && (
        <Box className="admin-table">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>时间</TableCell>
                <TableCell>级别</TableCell>
                <TableCell>事件</TableCell>
                <TableCell>来源</TableCell>
                <TableCell>错误</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {result.records.map((record, index) => (
                <ErrorRecord key={`${record.source}:${index}`} {...record} />
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {result?.failures.map((failure) => (
        <FailureNote
          key={failure.nodeId}
          error={failure.error}
          context={{
            operation: '查询节点日志',
            scope: 'item',
            targetId: failure.nodeId,
            consequence: '其他节点结果仍可查看',
          }}
        />
      ))}
    </Box>
  );
}

const reasons: Record<string, string> = {
  user: '用户停止',
  'duration-limit': '达到时长上限',
  'size-limit': '达到大小上限',
  disconnected: '连接断开',
  'authorization-changed': '登录状态变化',
  shutdown: '服务关闭',
};

export function AdminDiagnosticsSection({ online, call }: { online: boolean; call: AdminCall }) {
  const { data, setData, error } = useAdminResource(online, () => call('admin.diagnostics', {}), 15000);
  const [deleting, setDeleting] = useState<AdminDiagnostic | null>(null),
    [downloadError, setDownloadError] = useState<RemoteKitError | undefined>();
  const download = async (item: AdminDiagnostic) => {
    setDownloadError(undefined);
    try {
      const { url } = await call('admin.downloadDiagnostic', { id: item.id });
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (e) {
      setDownloadError(failureError(e));
    }
  };
  return (
    <Box className="admin-section">
      <ErrorLookup online={online} call={call} />
      <SectionHeader title="诊断" detail="用户在设置中收集的诊断包，按诊断 ID 对应" />
      <LoadState error={error} loading={!data} />
      {downloadError && (
        <FailureNote error={downloadError} context={{ operation: '读取诊断记录', scope: 'surface' }} />
      )}
      {data && data.length === 0 && (
        <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          暂无诊断包
        </Typography>
      )}
      {data && data.length > 0 && (
        <Box className="admin-table">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>诊断 ID</TableCell>
                <TableCell>用户</TableCell>
                <TableCell className="admin-wide">时间</TableCell>
                <TableCell className="admin-wide">结束原因</TableCell>
                <TableCell align="right">大小</TableCell>
                <TableCell padding="checkbox" />
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((item) => (
                <TableRow key={item.id} hover>
                  <TableCell>
                    <Tooltip title={item.id}>
                      <Typography className="admin-mono" variant="body2">
                        {item.id.slice(0, 8)}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{item.username ?? '—'}</TableCell>
                  <TableCell className="admin-wide">
                    <Typography variant="body2" noWrap>
                      {formatDateTime(item.createdAt)}
                    </Typography>
                  </TableCell>
                  <TableCell className="admin-wide">{reasons[item.reason] ?? item.reason}</TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" noWrap>
                      {formatBytes(item.bytes)}
                    </Typography>
                  </TableCell>
                  <TableCell padding="checkbox">
                    <Box sx={{ display: 'flex' }}>
                      <Tooltip title="下载">
                        <span>
                          <IconButton
                            disabled={!online}
                            aria-label="下载诊断包"
                            onClick={() => void download(item)}
                          >
                            <Download />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="删除">
                        <span>
                          <IconButton
                            disabled={!online}
                            aria-label="删除诊断包"
                            onClick={() => setDeleting(item)}
                          >
                            <DeleteOutline />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      <ConfirmDialog
        open={!!deleting}
        danger
        title="删除诊断包"
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          setData(await call('admin.deleteDiagnostic', { id: deleting!.id }));
        }}
      >
        <Typography>删除诊断包 {deleting?.id}？</Typography>
      </ConfirmDialog>
    </Box>
  );
}
