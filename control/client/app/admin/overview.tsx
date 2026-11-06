import { Alert, Box, Paper, Typography } from '@mui/material';
import type { AdminOverview } from '../../../shared/admin';
import { formatBytes, LoadState, SectionHeader, StatTile, useAdminResource, type AdminCall } from './shared';

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
  return list;
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
