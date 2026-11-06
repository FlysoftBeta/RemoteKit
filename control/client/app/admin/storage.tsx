import {
  Box,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import {
  formatBytes,
  formatTime,
  LoadState,
  SectionHeader,
  StatTile,
  useAdminResource,
  type AdminCall,
} from './shared';

export function AdminStorageSection({ online, call }: { online: boolean; call: AdminCall }) {
  const { data, error } = useAdminResource(online, () => call('admin.storage', {}), 15000);
  return (
    <Box className="admin-section">
      <SectionHeader
        title="存储"
        detail="我的文件与浏览器检查点以加密对象保存在节点上，每个对象保留最多 2 个副本"
      />
      <LoadState error={error} loading={!data} />
      {data && (
        <>
          <Box className="admin-stat-grid">
            <StatTile label="对象" value={data.objects} detail={`${formatBytes(data.bytes)} 内容`} />
            <StatTile label="单副本占用" value={formatBytes(data.storedBytes)} detail="加密并压缩后" />
            <StatTile
              label="副本不足"
              value={data.underReplicated}
              detail="等待复制到其他节点"
              tone={data.underReplicated ? 'warning' : undefined}
            />
            <StatTile
              label="待清理"
              value={data.orphans + data.pendingSessionDeletions}
              detail={`${data.orphans} 个孤立副本 · ${data.pendingSessionDeletions} 个已删除会话`}
            />
          </Box>
          <Box className="admin-table">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>用户</TableCell>
                  <TableCell>配额使用</TableCell>
                  <TableCell className="admin-wide">我的文件</TableCell>
                  <TableCell className="admin-wide">检查点</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.users.map((user) => (
                  <TableRow key={user.username}>
                    <TableCell>
                      <Typography fontWeight={500} noWrap>
                        {user.username}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box className="admin-usage">
                        <LinearProgress
                          variant="determinate"
                          color={user.bytes / user.quotaBytes >= 0.9 ? 'error' : 'primary'}
                          value={Math.min(100, (user.bytes / user.quotaBytes) * 100)}
                        />
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {formatBytes(user.bytes)} / {formatBytes(user.quotaBytes)} · {user.objects} 个对象
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell className="admin-wide">{user.libraryFiles} 个文件</TableCell>
                    <TableCell className="admin-wide">
                      {user.checkpoints === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          无
                        </Typography>
                      ) : (
                        <Typography variant="body2" noWrap>
                          {formatBytes(user.latestCheckpointBytes)} · {formatTime(user.latestCheckpointAt)}
                          <Typography component="span" variant="body2" color="text.secondary">
                            {` · 共 ${user.checkpoints} 次`}
                          </Typography>
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </>
      )}
    </Box>
  );
}
