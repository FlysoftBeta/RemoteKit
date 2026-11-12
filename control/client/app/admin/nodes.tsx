import { Alert, Box, Button, Chip, Paper, Typography } from '@mui/material';
import { useState } from 'react';
import type { AdminNode } from '../../../shared/admin';
import {
  ConfirmDialog,
  formatBytes,
  formatPercent,
  formatTime,
  LoadState,
  Meter,
  SectionHeader,
  useAdminResource,
  type AdminCall,
} from './shared';
import { OverflowText } from '../overflow-text';

const states: Record<
  AdminNode['state'],
  { label: string; color: 'success' | 'warning' | 'default' | 'error' }
> = {
  ready: { label: '在线', color: 'success' },
  connecting: { label: '连接中', color: 'warning' },
  offline: { label: '离线', color: 'default' },
  removed: { label: '已移除', color: 'error' },
};
const rejections: Record<string, string> = {
  identity_mismatch: '身份不匹配：请将新的 node.json 复制到该节点',
  build_mismatch: '版本与 Control 不一致',
  no_release: 'Control 没有可下发的发布包',
};
const exits: Record<number, string> = {
  1: '启动或运行失败',
  3: '需要更新',
  4: '配置已变更，正在重启',
};

function problems(node: AdminNode) {
  const list: { severity: 'warning' | 'error' | 'info'; text: string }[] = [];
  if (node.state !== 'ready' && node.rejected)
    list.push({
      severity: 'error',
      text: `${formatTime(node.rejected.at)}被拒绝连接：${rejections[node.rejected.code] ?? node.rejected.code}${
        node.rejected.code === 'build_mismatch' ? `（节点版本 ${node.rejected.buildId}）` : ''
      }`,
    });
  if (node.state !== 'ready' && node.exited)
    list.push({
      severity: node.exited.code === 0 ? 'info' : 'warning',
      text: `${formatTime(node.exited.at)}进程退出${
        node.exited.code === null
          ? '：无法启动'
          : `（代码 ${node.exited.code}${exits[node.exited.code] ? `，${exits[node.exited.code]}` : ''}）`
      }`,
    });
  if (node.underPressure) list.push({ severity: 'warning', text: '持续高负载，新会话会优先放到其他节点。' });
  if (node.diskDraining)
    list.push({ severity: 'warning', text: '磁盘空间低于保留值，正在清理冷副本并停止接收新数据。' });
  return list;
}

function NodeCard({
  node,
  online,
  change,
}: {
  node: AdminNode;
  online: boolean;
  change: (node: AdminNode) => void;
}) {
  const metrics = node.metrics;
  const state = states[node.state];
  return (
    <Paper variant="outlined" className="admin-node">
      <Box className="admin-node-head">
        <Box sx={{ minWidth: 0 }}>
          <Box className="admin-user">
            <Typography fontWeight={600} noWrap>
              {node.nodeId}
            </Typography>
            <Chip
              size="small"
              label={state.label}
              color={state.color}
              variant={node.state === 'ready' ? 'filled' : 'outlined'}
            />
          </Box>
          <Typography variant="body2" color="text.secondary" noWrap>
            {node.managed ? 'Control 托管进程' : '外部节点'} · {node.peerAddress}
          </Typography>
        </Box>
        <Button
          size="small"
          disabled={!online || node.state === 'ready'}
          color={node.state === 'removed' ? 'primary' : 'error'}
          onClick={() => change(node)}
        >
          {node.state === 'removed' ? '重新添加' : '移除节点'}
        </Button>
      </Box>
      {problems(node).map((problem) => (
        <Alert key={problem.text} severity={problem.severity} sx={{ py: 0 }}>
          {problem.text}
        </Alert>
      ))}
      {metrics ? (
        <Box className="admin-meters">
          <Meter label="CPU" value={metrics.cpu} detail={formatPercent(metrics.cpu)} />
          <Meter
            label="内存"
            value={1 - metrics.memory.available / metrics.memory.total}
            detail={`可用 ${formatBytes(metrics.memory.available)} / ${formatBytes(metrics.memory.total)}`}
          />
          {metrics.gpus.map((gpu, index) => (
            <Box key={index} className="admin-gpu">
              <OverflowText variant="caption" color="text.secondary">
                {gpu.name}
              </OverflowText>
              <Meter label="3D" value={gpu.engine3d} detail={formatPercent(gpu.engine3d)} />
              <Meter
                label="视频编码"
                value={gpu.engineVideoEncode}
                detail={formatPercent(gpu.engineVideoEncode)}
              />
              {gpu.dedicatedTotal > 0 && (
                <Meter
                  label="显存"
                  value={gpu.dedicatedUsed / gpu.dedicatedTotal}
                  detail={`${formatBytes(gpu.dedicatedUsed)} / ${formatBytes(gpu.dedicatedTotal)}`}
                />
              )}
            </Box>
          ))}
          <Meter
            label="磁盘"
            value={1 - metrics.disk.free / metrics.disk.total}
            detail={`剩余 ${formatBytes(metrics.disk.free)} / ${formatBytes(metrics.disk.total)}`}
          />
        </Box>
      ) : (
        node.state === 'ready' && (
          <Typography variant="body2" color="text.secondary">
            等待节点上报负载…
          </Typography>
        )
      )}
      <dl className="admin-facts">
        <dt>会话</dt>
        <dd>
          {node.sessions}
          {node.maxSessions !== null && ` / ${node.maxSessions}`}
          {node.users.length > 0 && ` · ${node.users.join('、')}`}
        </dd>
        <dt>综合压力</dt>
        <dd>{node.pressure === null ? '—' : formatPercent(node.pressure)}</dd>
        <dt>余量</dt>
        <dd>{node.headroom === null ? '—' : formatPercent(node.headroom)}</dd>
        <dt>对象副本</dt>
        <dd>{formatBytes(node.replicaBytes)}</dd>
        <dt>公钥指纹</dt>
        <dd className="admin-mono">{node.publicKeyFingerprint}</dd>
        {node.bootstrapFile && (
          <>
            <dt>节点配置</dt>
            <dd className="admin-mono">{node.bootstrapFile}</dd>
          </>
        )}
        <dt>版本</dt>
        <dd className="admin-mono">{node.buildId ?? '—'}</dd>
        <dt>{node.state === 'ready' ? '连接于' : '断开于'}</dt>
        <dd>{formatTime(node.state === 'ready' ? node.connectedAt : node.disconnectedAt)}</dd>
      </dl>
    </Paper>
  );
}

export function AdminNodesSection({ online, call }: { online: boolean; call: AdminCall }) {
  const { data, setData, error } = useAdminResource(online, () => call('admin.nodes', {}));
  const [selected, setSelected] = useState<AdminNode | null>(null);
  const ready = data?.filter((node) => node.state === 'ready').length ?? 0;
  return (
    <Box className="admin-section">
      <SectionHeader
        title="节点"
        detail={data ? `${ready} / ${data.length} 个在线 · 节点在 Control 配置文件中定义` : undefined}
      />
      <LoadState error={error} loading={!data} />
      {data && (
        <Box className="admin-node-grid">
          {data.map((node) => (
            <NodeCard key={node.nodeId} node={node} online={online} change={setSelected} />
          ))}
        </Box>
      )}
      <ConfirmDialog
        open={!!selected}
        danger={selected?.state !== 'removed'}
        title={selected?.state === 'removed' ? '重新添加节点' : '移除节点'}
        confirmLabel={selected?.state === 'removed' ? '重新添加' : '移除'}
        onClose={() => setSelected(null)}
        onConfirm={async () => {
          const node = selected!;
          setData(
            await call(node.state === 'removed' ? 'admin.readdNode' : 'admin.removeNode', {
              nodeId: node.nodeId,
              discardDirty: true,
            }),
          );
        }}
      >
        <Typography>
          {selected?.state === 'removed'
            ? `允许节点 ${selected.nodeId} 重新连接。`
            : `移除节点 ${selected?.nodeId}？其上的会话将从最新检查点在其他节点恢复，没有检查点的会话从空白浏览器数据开始；该节点上的副本不再计入。`}
        </Typography>
        {selected?.state !== 'removed' && !!selected?.dirtyUsers.length && (
          <Typography color="error">
            以下用户的未提交更改将永久丢失：{selected.dirtyUsers.join('、')}
          </Typography>
        )}
      </ConfirmDialog>
    </Box>
  );
}
