import Download from '@mui/icons-material/Download';
import { AlertTitle, Box, Button, Paper, Typography } from '@mui/material';
import { useState } from 'react';
import type { AdminOverview } from '../../../shared/admin';
import { RemoteKitError } from '../../../shared/errors';
import { failureError, FailureNote, presentFailure, type Presentation } from '../../failures';
import {
  formatBytes,
  formatTime,
  LoadState,
  SectionHeader,
  StatTile,
  useAdminResource,
  type AdminCall,
} from './shared';

function issues(overview: AdminOverview) {
  const list: Presentation[] = [];
  if (overview.nodes.ready < overview.nodes.total || overview.nodes.ready === 0)
    list.push({
      class: 'A',
      text: '正在等待节点恢复，新的浏览器会话暂不可用',
      longText: '仍在等待节点恢复，恢复后自动继续',
    });
  if (overview.nodes.mismatched > 0)
    list.push(
      presentFailure(new RemoteKitError(overview.release ? 'unavailable' : 'internal', ''), {
        operation: '更新节点',
        scope: 'surface',
        issue: overview.release ? undefined : 'configuration',
        text: overview.release ? '正在等待节点更新…' : '节点未能自动更新，当前尚未提供发布包',
      }),
    );
  if (overview.storage.underReplicated > 0)
    list.push({
      class: 'A',
      text: '正在补齐文件副本，已有副本仍保留',
      longText: '仍在补齐文件副本，已有副本仍保留',
    });
  if (overview.storage.pendingSessionDeletions > 0)
    list.push({
      class: 'A',
      text: '等待节点上线后继续清理已删除的会话',
      longText: '仍在等待节点上线，恢复后自动继续清理',
    });
  for (const failure of overview.storage.deletionFailures ?? [])
    list.push(
      presentFailure(failure.error, {
        operation: '清理会话数据',
        scope: 'item',
        targetId: failure.sessionId,
        consequence: '该节点上的清理任务仍保留',
      }),
    );
  if (overview.sessionImport.error)
    list.push(
      presentFailure(overview.sessionImport.error, {
        operation: '接收导入邮件',
        scope: 'surface',
        credential: 'mailbox',
        consequence: '手机请求尚未读取',
      }),
    );
  if (overview.sessionImport.outbox.error && overview.sessionImport.outbox.pending)
    list.push(
      presentFailure(overview.sessionImport.outbox.error, {
        operation: '发送导入回信',
        scope: 'surface',
        credential: 'mailbox',
        consequence: `${overview.sessionImport.outbox.pending} 封回信仍在待发队列`,
      }),
    );
  return list;
}

function SessionImportPanel({
  online,
  call,
  status,
}: {
  online: boolean;
  call: AdminCall;
  status: AdminOverview['sessionImport'];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteKitError | undefined>();
  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const deployment = await call('admin.sessionImportDeployment', {});
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(deployment, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'deployment.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setError(failureError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper variant="outlined" className="admin-panel">
      <Box className="admin-panel-heading">
        <Typography fontWeight={600}>会话导入</Typography>
        {status.configured && (
          <Button
            size="small"
            startIcon={<Download />}
            disabled={!online || busy}
            onClick={() => void download()}
          >
            App 部署配置
          </Button>
        )}
      </Box>
      {error && <FailureNote error={error} context={{ operation: '下载部署配置', scope: 'surface' }} />}
      <dl className="admin-facts">
        <dt>收信</dt>
        <dd>
          {!status.configured
            ? '未配置（control.json 的 sessionImport）'
            : status.error
              ? `拉取失败 · ${formatTime(status.lastErrorAt)}`
              : status.lastSuccessAt === null
                ? '正在连接'
                : `正常 · ${formatTime(status.lastSuccessAt)}检查`}
        </dd>
        {status.configured && (
          <>
            <dt>回信</dt>
            <dd>
              {status.outbox.pending === 0
                ? '没有待发回信'
                : status.outbox.error
                  ? `${status.outbox.pending} 封待发 · 发送失败 ${formatTime(status.outbox.lastErrorAt)}`
                  : `${status.outbox.pending} 封待发`}
            </dd>
            <dt>App 构建</dt>
            <dd>部署配置放到 android/deployment.json；更换导入密钥或 Browser 升级后需重新下载并重新构建</dd>
          </>
        )}
      </dl>
    </Paper>
  );
}

export function AdminOverviewSection({ online, call }: { online: boolean; call: AdminCall }) {
  const { data, error } = useAdminResource<AdminOverview>(online, () => call('admin.overview', {}));
  return (
    <Box className="admin-section">
      <SectionHeader title="概览" detail="集群、用户与存储的当前状态" />
      <LoadState error={error} loading={!data} />
      {data && (
        <>
          {data.integrity.problemCount > 0 && (
            <div>
              {data.integrity.problems.map((problem) => (
                <FailureNote
                  key={problem.table + problem.key}
                  error={problem.error}
                  context={{ operation: '校验持久化记录', scope: 'item', consequence: '相关记录尚未修复' }}
                />
              ))}
              <AlertTitle>数据完整性问题（{data.integrity.problemCount}）</AlertTitle>
              <Box
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  m: 0,
                }}
              >
                {data.integrity.problems
                  .slice(0, 20)
                  .map(
                    (problem) =>
                      `${problem.table} · ${problem.key} · ${problem.detail.replace(/[\r\n]+/g, ' ')}`,
                  )
                  .join('\n')}
              </Box>
              {data.integrity.problemCount > 20 && (
                <Typography variant="caption">
                  其余 {data.integrity.problemCount - 20} 条见 Control 日志
                </Typography>
              )}
            </div>
          )}
          <Box className="admin-stat-grid">
            <StatTile
              label="节点"
              value={`${data.nodes.ready} / ${data.nodes.total}`}
              detail="在线 / 已配置"
              tone={
                data.nodes.ready === 0 ? 'error' : data.nodes.ready < data.nodes.total ? 'warning' : undefined
              }
            />
            <StatTile
              label="用户"
              value={data.users.total}
              detail={`${data.users.online} 人在线${data.users.disabled ? ` · ${data.users.disabled} 个已停用` : ''}`}
            />
            <StatTile
              label="浏览器会话"
              value={data.sessions.active}
              detail={`运行中 · ${data.sessions.hibernated} 个已休眠`}
            />
            <StatTile
              label="文件与检查点"
              value={formatBytes(data.storage.bytes)}
              detail={`${data.diagnostics} 个诊断包`}
              tone={data.storage.underReplicated ? 'warning' : undefined}
            />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {issues(data).map((issue) => (
              <FailureNote key={issue.text} presentation={issue} />
            ))}
          </Box>
          <SessionImportPanel online={online} call={call} status={data.sessionImport} />
          <Paper variant="outlined" className="admin-panel">
            <Typography fontWeight={600}>版本</Typography>
            <dl className="admin-facts">
              <dt>Control</dt>
              <dd className="admin-mono">{data.buildId}</dd>
              <dt>节点发布包</dt>
              <dd>
                {data.release ? (
                  <>
                    <span className="admin-mono">{data.release.buildId}</span>
                    {` · ${formatBytes(data.release.size)}`}
                  </>
                ) : (
                  '未提供，节点无法自动更新'
                )}
              </dd>
            </dl>
          </Paper>
        </>
      )}
    </Box>
  );
}
