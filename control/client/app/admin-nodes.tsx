import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { AdminNode } from '../../shared/product';
import { formatError } from '../util/format-error';

const stateLabels: Record<AdminNode['state'], string> = {
  ready: '在线',
  connecting: '连接中',
  offline: '离线',
  removed: '已移除',
};

export function AdminNodes({
  online,
  load,
  change,
}: {
  online: boolean;
  load: () => Promise<AdminNode[]>;
  change: (nodeId: string, action: 'remove' | 'readd') => Promise<AdminNode[]>;
}) {
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [selected, setSelected] = useState<AdminNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!online) return;
    let active = true;
    const refresh = () =>
      void load().then(
        (value) => {
          if (active) setNodes(value);
        },
        (error) => {
          if (active) setError(formatError(error));
        },
      );
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [online, load]);
  return (
    <Box>
      <Typography variant="h6">集群节点</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {['节点', '状态', '构建', '压力', '会话', '操作'].map((title) => (
                <TableCell key={title}>{title}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {nodes.map((node) => (
              <TableRow key={node.nodeId}>
                <TableCell>{node.nodeId}</TableCell>
                <TableCell>{stateLabels[node.state]}</TableCell>
                <TableCell sx={{ maxWidth: 120, overflowWrap: 'anywhere' }}>{node.buildId ?? '—'}</TableCell>
                <TableCell>{node.pressure === null ? '—' : `${Math.round(node.pressure * 100)}%`}</TableCell>
                <TableCell>{node.sessions}</TableCell>
                <TableCell>
                  <Button
                    disabled={!online || busy || node.state === 'ready'}
                    color={node.state === 'removed' ? 'primary' : 'error'}
                    onClick={() => setSelected(node)}
                  >
                    {node.state === 'removed' ? '重新添加' : '移除节点'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Dialog
        open={selected !== null}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
      >
        <DialogTitle>{selected?.state === 'removed' ? '重新添加节点' : '移除节点'}</DialogTitle>
        <DialogContent>
          {error && <Alert severity="error">{error}</Alert>}
          {selected?.state === 'removed'
            ? `允许节点 ${selected.nodeId} 重新连接？`
            : `移除节点 ${selected?.nodeId}？其会话将使用最新检查点在可用节点恢复；没有检查点的会话将从空白目录启动。`}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setSelected(null)}>
            取消
          </Button>
          <Button
            disabled={!online || busy}
            color={selected?.state === 'removed' ? 'primary' : 'error'}
            onClick={async () => {
              if (!selected || busy) return;
              setBusy(true);
              setError('');
              try {
                setNodes(await change(selected.nodeId, selected.state === 'removed' ? 'readd' : 'remove'));
                setSelected(null);
              } catch (error) {
                setError(formatError(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            确认
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
