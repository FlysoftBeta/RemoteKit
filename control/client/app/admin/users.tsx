import Add from '@mui/icons-material/Add';
import MoreVert from '@mui/icons-material/MoreVert';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  LinearProgress,
  ListItemText,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { AdminSocketMethods, AdminUser, AdminNode } from '../../../shared/admin';
import { RemoteKitError } from '../../../shared/errors';
import { useAutoFocus } from '../../editing/local-autofocus';
import { failureError, FailureNote } from '../../failures';
import { scaledAnchor } from '../ui-scale';
import {
  ConfirmDialog,
  formatBytes,
  formatTime,
  LoadState,
  randomPassword,
  SectionHeader,
  useAdminResource,
  type AdminCall,
} from './shared';

type UserMethod = {
  [K in keyof AdminSocketMethods]: AdminSocketMethods[K]['result'] extends AdminUser[] ? K : never;
}[keyof AdminSocketMethods];
type Action =
  | 'password'
  | 'factors'
  | 'signOut'
  | 'move'
  | 'stop'
  | 'resetSession'
  | 'disable'
  | 'enable'
  | 'transfer'
  | 'delete';

function sessionText(user: AdminUser) {
  if (user.session.state === 'none') return '未启动';
  return `${user.session.nodeId} · ${user.session.state === 'running' ? '运行中' : '已停止'} · ${user.session.dataState === 'dirty' ? '有新更改' : '已保存'} · 完整版本 ${formatTime(user.session.checkpointAt)}`;
}

function PasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <TextField
      label="密码"
      value={value}
      autoComplete="new-password"
      onChange={(event) => onChange(event.target.value)}
      helperText="8–256 个字符，请通过可靠渠道告知用户"
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            <Button size="small" onClick={() => onChange(randomPassword())}>
              随机生成
            </Button>
          </InputAdornment>
        ),
      }}
    />
  );
}

function CreateUserDialog({
  open,
  onClose,
  create,
}: {
  open: boolean;
  onClose: () => void;
  create: (username: string, password: string) => Promise<void>;
}) {
  const autoFocusRef = useAutoFocus<HTMLInputElement>();
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<RemoteKitError | undefined>();
  const close = () => {
    if (busy) return;
    setUsername('');
    setPassword('');
    setError(undefined);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <Box
        component="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await create(username, password);
            setBusy(false);
            setUsername('');
            setPassword('');
            onClose();
          } catch (e) {
            setError(failureError(e));
            setBusy(false);
          }
        }}
      >
        <DialogTitle>新建用户</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {error && (
            <FailureNote error={error} context={{ operation: '更新用户', scope: 'surface', input: true }} />
          )}
          <TextField
            inputRef={autoFocusRef}
            required
            label="用户名"
            value={username}
            autoComplete="off"
            helperText="3–40 个字母、数字或 _ . -"
            onChange={(event) => setUsername(event.target.value)}
          />
          <PasswordField value={password} onChange={setPassword} />
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" variant="contained" disabled={busy || !username || password.length < 8}>
            {busy ? '请稍候…' : '创建'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function ActionDialog({
  action,
  user,
  self,
  nodes,
  run,
  onClose,
}: {
  action: Action | null;
  user: AdminUser | null;
  self: string;
  nodes: AdminNode[];
  run: (method: UserMethod, params: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState(''),
    [typed, setTyped] = useState(''),
    [nodeId, setNodeId] = useState('');
  if (!user || !action) return null;
  const username = user.username;
  const close = () => {
    setPassword('');
    setTyped('');
    setNodeId('');
    onClose();
  };
  const common = { open: true, onClose: close };
  switch (action) {
    case 'password':
      return (
        <ConfirmDialog
          {...common}
          title={`重置 ${username} 的密码`}
          confirmLabel="重置密码"
          disabled={password.length < 8}
          onConfirm={() => run('admin.resetPassword', { username, password })}
        >
          <Typography color="text.secondary">该用户的所有登录会立即失效，需使用新密码重新登录。</Typography>
          <PasswordField value={password} onChange={setPassword} />
        </ConfirmDialog>
      );
    case 'factors':
      return (
        <ConfirmDialog
          {...common}
          title="清除 PIN 与人脸"
          confirmLabel="清除"
          onConfirm={() => run('admin.clearSecondFactors', { username })}
        >
          <Typography>
            清除 {username} 的 PIN 和已登记的人脸，并关闭人脸验证。用户之后只能用账户密码解锁，可重新设置。
          </Typography>
        </ConfirmDialog>
      );
    case 'signOut':
      return (
        <ConfirmDialog
          {...common}
          title="强制下线"
          confirmLabel="强制下线"
          onConfirm={() => run('admin.signOut', { username })}
        >
          <Typography>
            断开 {username} 当前的连接，并让其所有设备上的登录失效。浏览器会话与标签页保留。
          </Typography>
        </ConfirmDialog>
      );
    case 'move':
      return (
        <ConfirmDialog
          {...common}
          title={`转移 ${username} 的 Session`}
          confirmLabel="转移"
          disabled={user.session.state === 'none'}
          onConfirm={() => run('admin.transfer', { username, ...(nodeId ? { nodeId } : {}) })}
        >
          <Typography>
            {user.session.state !== 'none' && user.session.nodeOffline
              ? user.session.checkpointAt === null
                ? '源节点离线，且没有可用的完整版本。将从空白浏览器数据开始，源节点上的数据将丢失。'
                : `源节点离线。将恢复最新完整版本（${formatTime(user.session.checkpointAt)}），此后的更改将丢失。`
              : '将先停止并保存源节点上的 Session，再转移到目标节点。'}
          </Typography>
          <TextField
            select
            label="目标节点"
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
          >
            <MenuItem value="">自动选择</MenuItem>
            {nodes
              .filter(
                (node) =>
                  node.state === 'ready' &&
                  user.session.state !== 'none' &&
                  node.nodeId !== user.session.nodeId,
              )
              .map((node) => (
                <MenuItem key={node.nodeId} value={node.nodeId}>
                  {node.nodeId}
                </MenuItem>
              ))}
          </TextField>
        </ConfirmDialog>
      );
    case 'stop':
      return (
        <ConfirmDialog
          {...common}
          title="立即停止"
          confirmLabel="停止"
          onConfirm={() => run('admin.stop', { username })}
        >
          <Typography>
            关闭 {username} 的浏览器并保存检查点，释放节点资源。用户下次连接时会在合适的节点上恢复。
          </Typography>
        </ConfirmDialog>
      );
    case 'resetSession':
      return (
        <ConfirmDialog
          {...common}
          danger
          title="重置浏览器数据"
          confirmLabel="重置"
          onConfirm={() => run('admin.resetSession', { username })}
        >
          <Typography>
            删除 {username}{' '}
            的浏览器数据：Cookie、网站登录状态、本地存储和历史记录。标签页、设置与“我的文件”保留，下次打开时从空白状态重新载入。
          </Typography>
        </ConfirmDialog>
      );
    case 'disable':
      return (
        <ConfirmDialog
          {...common}
          danger
          title="停用账户"
          confirmLabel="停用"
          onConfirm={() => run('admin.setDisabled', { username, disabled: true })}
        >
          <Typography>{username} 将立即下线且无法登录。数据保留，可随时重新启用。</Typography>
        </ConfirmDialog>
      );
    case 'enable':
      return (
        <ConfirmDialog
          {...common}
          title="启用账户"
          confirmLabel="启用"
          onConfirm={() => run('admin.setDisabled', { username, disabled: false })}
        >
          <Typography>允许 {username} 重新登录。</Typography>
        </ConfirmDialog>
      );
    case 'transfer':
      return (
        <ConfirmDialog
          {...common}
          danger
          title="转让管理员"
          confirmLabel="转让"
          onConfirm={() => run('admin.transferAdmin', { username })}
        >
          <Typography>
            {username} 将成为管理员，你（{self}）将失去管理员权限，管理员面板随即关闭。
          </Typography>
        </ConfirmDialog>
      );
    case 'delete':
      return (
        <ConfirmDialog
          {...common}
          danger
          title={`删除用户 ${username}`}
          confirmLabel="永久删除"
          disabled={typed !== username}
          onConfirm={() => run('admin.deleteUser', { username })}
        >
          <Typography>
            永久删除账户及其全部数据：工作区、设置、我的文件、浏览器数据、检查点与诊断包，包括各节点上的副本。此操作无法撤销。
          </Typography>
          <TextField
            label={`输入 ${username} 以确认`}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </ConfirmDialog>
      );
  }
}

export function AdminUsersSection({
  online,
  call,
  self,
}: {
  online: boolean;
  call: AdminCall;
  self: string;
}) {
  const { data, setData, error } = useAdminResource(online, () => call('admin.users', {}));
  const { data: nodes } = useAdminResource(online, () => call('admin.nodes', {}));
  const [creating, setCreating] = useState(false),
    [menu, setMenu] = useState<{ anchor: HTMLElement; user: AdminUser } | null>(null),
    [action, setAction] = useState<{ action: Action; user: AdminUser } | null>(null);
  const run = async (method: UserMethod, params: Record<string, unknown>) => {
    setData(await call(method, params as never));
  };
  const open = (next: Action) => {
    if (menu) setAction({ action: next, user: menu.user });
    setMenu(null);
  };
  const online_ = data?.filter((user) => user.online).length ?? 0;
  const target = menu?.user,
    other = !!target && target.username !== self;
  return (
    <Box className="admin-section">
      <SectionHeader
        title="用户"
        detail={data ? `${data.length} 个账户 · ${online_} 人在线` : undefined}
        action={
          <Button
            variant="contained"
            startIcon={<Add />}
            disabled={!online}
            onClick={() => setCreating(true)}
          >
            新建用户
          </Button>
        }
      />
      <LoadState error={error} loading={!data} />
      {data && (
        <Box className="admin-table">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>用户</TableCell>
                <TableCell className="admin-wide">浏览器</TableCell>
                <TableCell className="admin-wide">存储</TableCell>
                <TableCell className="admin-wide">最近登录</TableCell>
                <TableCell padding="checkbox" />
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((user) => (
                <TableRow key={user.username} hover>
                  <TableCell>
                    <Box className="admin-user">
                      <Tooltip title={user.online ? '在线' : '离线'}>
                        <span
                          className={`admin-dot${user.online ? ' admin-dot-on' : ''}`}
                          role="img"
                          aria-label={user.online ? '在线' : '离线'}
                        />
                      </Tooltip>
                      <Typography component="span" fontWeight={500} noWrap>
                        {user.username}
                      </Typography>
                      {user.username === self && (
                        <Typography component="span" variant="body2" color="text.secondary">
                          （你）
                        </Typography>
                      )}
                      {user.isAdmin && (
                        <Chip size="small" label="管理员" color="primary" variant="outlined" />
                      )}
                      {user.disabled && <Chip size="small" label="已停用" color="error" variant="outlined" />}
                    </Box>
                    <Typography
                      className="admin-narrow"
                      variant="body2"
                      color="text.secondary"
                      sx={{ pl: 2 }}
                    >
                      {sessionText(user)} · {formatBytes(user.storage.bytes)}
                    </Typography>
                  </TableCell>
                  <TableCell className="admin-wide">
                    <Typography variant="body2" noWrap>
                      {sessionText(user)}
                    </Typography>
                  </TableCell>
                  <TableCell className="admin-wide">
                    <Box className="admin-usage">
                      {user.storage.quotaBytes !== null && (
                        <LinearProgress
                          variant="determinate"
                          value={Math.min(100, (user.storage.bytes / user.storage.quotaBytes) * 100)}
                        />
                      )}
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {formatBytes(user.storage.bytes)}
                        {user.storage.quotaBytes !== null && ` / ${formatBytes(user.storage.quotaBytes)}`}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell className="admin-wide">
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {formatTime(user.lastLoginAt)}
                    </Typography>
                  </TableCell>
                  <TableCell padding="checkbox">
                    <IconButton
                      aria-label={`${user.username} 的操作`}
                      disabled={!online}
                      onClick={(event) => setMenu({ anchor: event.currentTarget, user })}
                    >
                      <MoreVert />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      <Menu anchorEl={scaledAnchor(menu?.anchor)} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem disabled={!other} onClick={() => open('password')}>
          重置密码
        </MenuItem>
        <MenuItem
          disabled={!other || !(target?.secondFactors.pin || target?.secondFactors.face)}
          onClick={() => open('factors')}
        >
          清除 PIN 与人脸
        </MenuItem>
        <MenuItem disabled={!other} onClick={() => open('signOut')}>
          强制下线
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={target?.session.state !== 'running' || target.online}
          onClick={() => open('stop')}
        >
          <ListItemText primary="立即停止" secondary={target?.online ? '用户在线时不可用' : undefined} />
        </MenuItem>
        <MenuItem disabled={!target || target.session.state === 'none'} onClick={() => open('move')}>
          <ListItemText primary="转移" />
        </MenuItem>
        <MenuItem disabled={target?.session.state !== 'stopped'} onClick={() => open('resetSession')}>
          <ListItemText
            primary="重置浏览器数据"
            secondary={target?.session.state === 'running' ? '需先停止' : undefined}
          />
        </MenuItem>
        <Divider />
        {target?.disabled ? (
          <MenuItem disabled={!other} onClick={() => open('enable')}>
            启用账户
          </MenuItem>
        ) : (
          <MenuItem disabled={!other || target?.isAdmin} onClick={() => open('disable')}>
            停用账户
          </MenuItem>
        )}
        <MenuItem disabled={!other || target?.disabled} onClick={() => open('transfer')}>
          转让管理员
        </MenuItem>
        <MenuItem disabled={!other} onClick={() => open('delete')} sx={{ color: 'error.main' }}>
          删除用户
        </MenuItem>
      </Menu>
      <CreateUserDialog
        open={creating}
        onClose={() => setCreating(false)}
        create={async (username, password) => {
          setData(await call('admin.createUser', { username, password }));
        }}
      />
      <ActionDialog
        action={action?.action ?? null}
        user={action?.user ?? null}
        self={self}
        nodes={nodes ?? []}
        run={run}
        onClose={() => setAction(null)}
      />
    </Box>
  );
}
