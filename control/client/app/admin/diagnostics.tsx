import DeleteOutline from '@mui/icons-material/DeleteOutline';
import SaveAlt from '@mui/icons-material/SaveAlt';
import { operationId } from '../../control/product-operations';
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
import { Fragment, useEffect, useState } from 'react';
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
      <SectionHeader title="错误 ID 查找" />
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
        <Typography color="text.secondary">没有找到（日志可能已过期）</Typography>
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
  const { data, mutate, error } = useAdminResource(
    online,
    'admin.diagnostics',
    () => call('admin.diagnostics', {}),
    15000,
  );
  const [deleting, setDeleting] = useState<AdminDiagnostic | null>(null),
    [downloadError, setDownloadError] = useState<RemoteKitError | undefined>();
  const [saved, setSaved] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const save = async (item: AdminDiagnostic) => {
    setSaving(item.id);
    setDownloadError(undefined);
    try {
      await call('admin.diagnostics.save', { id: item.id, operationId: operationId() });
      setSaved(item.id);
    } catch (e) {
      setDownloadError(failureError(e));
    } finally {
      setSaving(undefined);
    }
  };
  return (
    <Box className="admin-section">
      <LogsSection online={online} call={call} />
      <SectionHeader title="诊断采集" detail="用户在设置中收集的诊断包，按诊断 ID 对应" />
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
                      <Tooltip title="保存到我的文件">
                        <span>
                          <IconButton
                            disabled={!online || saving === item.id}
                            aria-label="保存到我的文件"
                            onClick={() => void save(item)}
                          >
                            <SaveAlt />
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
      {saved && <Typography role="status">诊断包已保存到我的文件</Typography>}
      <ErrorLookup online={online} call={call} />
      <ConfirmDialog
        open={!!deleting}
        danger
        title="删除诊断包"
        confirmLabel="删除"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const id = deleting!.id;
          void mutate(
            (items) => items.filter((item) => item.id !== id),
            () => call('admin.deleteDiagnostic', { id }),
            { retry: true },
          );
        }}
      >
        <Typography>删除诊断包 {deleting?.id}？</Typography>
      </ConfirmDialog>
    </Box>
  );
}

function LogsSection({ online, call }: { online: boolean; call: AdminCall }) {
  const dates = useAdminResource(online, 'admin.logs.days', () => call('admin.logs.days', {}), 15000);
  const jobs = useAdminResource(online, 'admin.logs.jobs', () => call('admin.logs.jobs', {}), 2000);
  const settings = useAdminResource(
    online,
    'admin.logs.settings',
    () => call('admin.logs.settings', {}),
    15000,
  );
  const [days, setDays] = useState('30');
  const [error, setError] = useState<RemoteKitError>();
  useEffect(() => {
    if (settings.data) setDays(String(settings.data.logRetentionDays));
  }, [settings.data?.logRetentionDays]);
  const run = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
      await jobs.refresh();
    } catch (cause) {
      setError(failureError(cause));
    }
  };
  return (
    <Box sx={{ mb: 4 }}>
      <SectionHeader title="日志" detail="按主机本地日期保存；打包结果保存到我的文件" />
      <Box
        component="form"
        sx={{ display: 'flex', gap: 1, mb: 2 }}
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await settings.mutate(
              () => ({ logRetentionDays: Number(days) }),
              () => call('admin.logs.settings', { logRetentionDays: Number(days) }),
            );
            await dates.refresh();
          });
        }}
      >
        <TextField
          size="small"
          label="日志保留天数"
          type="number"
          value={days}
          onChange={(event) => setDays(event.target.value)}
          slotProps={{ htmlInput: { min: 1, max: 365, step: 1 } }}
        />
        <Button
          type="submit"
          variant="outlined"
          disabled={!online || !Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365}
        >
          保存
        </Button>
      </Box>
      <LoadState
        error={settings.error ?? dates.error ?? jobs.error ?? error}
        loading={!dates.data || !settings.data}
      />
      {dates.data?.length === 0 && <Typography color="text.secondary">暂无日志</Typography>}
      {dates.data && dates.data.length > 0 && (
        <Box className="admin-table">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>日期</TableCell>
                <TableCell>主机</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {dates.data.map(({ date, hosts }) => (
                <TableRow key={date}>
                  <TableCell>{date}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {hosts.map((host) => (
                        <Chip
                          key={host.host}
                          size="small"
                          variant="outlined"
                          label={`${host.host} · ${host.present ? '有日志' : host.errorId ? '读取失败 ' + host.errorId : '无日志'}`}
                        />
                      ))}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Button
                      disabled={
                        !online || jobs.data?.some((job) => job.date === date && job.state === 'running')
                      }
                      onClick={() =>
                        void run(() => {
                          const id = operationId();
                          return jobs.mutate(
                            (items) =>
                              items.some((item) => item.operationId === id)
                                ? items
                                : [...items, { operationId: id, date, state: 'running', bytes: 0 }],
                            async () => {
                              await call('admin.logs.package', { date, operationId: id });
                              return call('admin.logs.jobs', {});
                            },
                          );
                        })
                      }
                    >
                      打包到我的文件
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {!!jobs.data?.length && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2">打包任务</Typography>
          {jobs.data.map((job) => (
            <Box key={job.operationId} sx={{ py: 1 }}>
              <Typography variant="body2">
                {job.date} ·{' '}
                {job.state === 'running'
                  ? `正在打包 · 已读取 ${formatBytes(job.bytes)}`
                  : job.state === 'done'
                    ? `已保存到我的文件 · ${job.fileName}`
                    : '打包失败'}
              </Typography>
              {job.state === 'failed' && (
                <FailureNote
                  error={new RemoteKitError(job.code, '日志打包失败', { errorId: job.errorId })}
                  context={{ operation: '打包日志', scope: 'item', targetId: job.operationId }}
                />
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
