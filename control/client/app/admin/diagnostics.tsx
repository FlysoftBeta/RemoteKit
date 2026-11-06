import DeleteOutline from '@mui/icons-material/DeleteOutline';
import Download from '@mui/icons-material/Download';
import {
  Alert,
  Box,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { AdminDiagnostic } from '../../../shared/admin';
import {
  adminError,
  ConfirmDialog,
  formatBytes,
  formatDateTime,
  LoadState,
  SectionHeader,
  useAdminResource,
  type AdminCall,
} from './shared';

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
    [downloadError, setDownloadError] = useState('');
  const download = async (item: AdminDiagnostic) => {
    setDownloadError('');
    try {
      const { url } = await call('admin.downloadDiagnostic', { id: item.id });
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (e) {
      setDownloadError(adminError(e));
    }
  };
  return (
    <Box className="admin-section">
      <SectionHeader title="诊断" detail="用户在设置中收集的诊断包，按诊断 ID 对应" />
      <LoadState error={error} loading={!data} />
      {downloadError && <Alert severity="error">{downloadError}</Alert>}
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
                    <Typography className="admin-mono" variant="body2" title={item.id}>
                      {item.id.slice(0, 8)}
                    </Typography>
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
