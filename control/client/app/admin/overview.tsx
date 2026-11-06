import Download from '@mui/icons-material/Download';
import { Alert, Box, Button, Paper, Typography } from '@mui/material';
import { useState } from 'react';
import type { AdminOverview } from '../../../shared/admin';
import {
  adminError,
  formatBytes,
  formatTime,
  LoadState,
  SectionHeader,
  StatTile,
  useAdminResource,
  type AdminCall,
} from './shared';

function issues(overview: AdminOverview) {
  const list: { severity: 'warning' | 'error' | 'info'; text: string }[] = [];
  const offline = overview.nodes.total - overview.nodes.ready;
  if (overview.nodes.ready === 0)
    list.push({ severity: 'error', text: '没有在线节点，用户无法打开浏览器。' });
  else if (offline > 0) list.push({ severity: 'warning', text: `${offline} 个节点不在线。` });
  if (overview.nodes.mismatched > 0)
    list.push({
      severity: 'warning',
      text: `${overview.nodes.mismatched} 个节点的版本与 Control 不一致${overview.release ? '，正在等待其更新程序下载发布包' : '，且 Control 未提供发布包'}。`,
    });
  if (overview.storage.underReplicated > 0)
    list.push({
      severity: 'warning',
      text: `${overview.storage.underReplicated} 个对象的副本少于目标数量。`,
    });
  if (overview.storage.pendingSessionDeletions > 0)
    list.push({
      severity: 'info',
      text: `${overview.storage.pendingSessionDeletions} 个已删除会话的数据等待节点上线后清理。`,
    });
  if (overview.sessionImport.lastError)
    list.push({
      severity: 'warning',
      text: `会话导入邮箱拉取失败：${overview.sessionImport.lastError}`,
    });
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
  const [error, setError] = useState('');
  const download = async () => {
    setBusy(true);
    setError('');
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
      setError(adminError(e));
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
      {error && <Alert severity="error">{error}</Alert>}
      <dl className="admin-facts">
        <dt>导入邮箱</dt>
        <dd>
          {!status.configured
            ? '未配置（control.json 的 sessionImport）'
            : status.lastError
              ? `拉取失败 · ${formatTime(status.lastErrorAt)}`
              : status.lastSuccessAt === null
                ? '正在连接'
                : `正常 · ${formatTime(status.lastSuccessAt)}检查`}
        </dd>
        {status.configured && (
          <>
            <dt>App 构建</dt>
            <dd>部署配置放到 android/deployment.json；更换导入密钥或 Browser 升级后需重新下载并重新构建</dd>
          </>
        )}
      </dl>
    </Paper>
  );
}

export function AdminOverviewSection({ online, call }: { online: boolean; call: AdminCall }) {
  const { data, error } = useAdminResource(online, () => call('admin.overview', {}));
  return (
    <Box className="admin-section">
      <SectionHeader title="概览" detail="集群、用户与存储的当前状态" />
      <LoadState error={error} loading={!data} />
      {data && (
        <>
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
              <Alert key={issue.text} severity={issue.severity}>
                {issue.text}
              </Alert>
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
