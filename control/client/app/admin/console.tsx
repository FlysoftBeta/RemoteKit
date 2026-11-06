import BugReportOutlined from '@mui/icons-material/BugReportOutlined';
import Close from '@mui/icons-material/Close';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import DnsOutlined from '@mui/icons-material/DnsOutlined';
import PeopleOutline from '@mui/icons-material/PeopleOutline';
import StorageOutlined from '@mui/icons-material/StorageOutlined';
import {
  Alert,
  Box,
  Dialog,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tab,
  Tabs,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useState, type ReactElement } from 'react';
import { AdminDiagnosticsSection } from './diagnostics';
import { AdminNodesSection } from './nodes';
import { AdminOverviewSection } from './overview';
import type { AdminCall } from './shared';
import { AdminStorageSection } from './storage';
import { AdminUsersSection } from './users';

const sections = [
  { key: 'overview', label: '概览', icon: <DashboardOutlined /> },
  { key: 'users', label: '用户', icon: <PeopleOutline /> },
  { key: 'nodes', label: '节点', icon: <DnsOutlined /> },
  { key: 'storage', label: '存储', icon: <StorageOutlined /> },
  { key: 'diagnostics', label: '诊断', icon: <BugReportOutlined /> },
] as const;
type Section = (typeof sections)[number]['key'];

export function AdminConsole({
  open,
  online,
  self,
  call,
  onClose,
}: {
  open: boolean;
  online: boolean;
  self: string;
  call: AdminCall;
  onClose: () => void;
}) {
  const compact = useMediaQuery('(max-width:760px)');
  const [section, setSection] = useState<Section>('overview');
  const content: Record<Section, ReactElement> = {
    overview: <AdminOverviewSection online={online} call={call} />,
    users: <AdminUsersSection online={online} call={call} self={self} />,
    nodes: <AdminNodesSection online={online} call={call} />,
    storage: <AdminStorageSection online={online} call={call} />,
    diagnostics: <AdminDiagnosticsSection online={online} call={call} />,
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={compact}
      fullWidth
      maxWidth="lg"
      disableScrollLock
      PaperProps={{ className: 'admin-paper' }}
    >
      <Box className="admin-header">
        <Typography variant="h6" component="h1" fontWeight={600}>
          管理员面板
        </Typography>
        <IconButton aria-label="关闭管理员面板" onClick={onClose}>
          <Close />
        </IconButton>
      </Box>
      {compact && (
        <Tabs
          value={section}
          onChange={(_, value: Section) => setSection(value)}
          variant="fullWidth"
          className="admin-tabs"
        >
          {sections.map((item) => (
            <Tab key={item.key} value={item.key} label={item.label} />
          ))}
        </Tabs>
      )}
      <Box className="admin-body">
        {!compact && (
          <List component="nav" className="admin-nav" aria-label="管理员面板分区">
            {sections.map((item) => (
              <ListItemButton
                key={item.key}
                selected={section === item.key}
                onClick={() => setSection(item.key)}
              >
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            ))}
          </List>
        )}
        <Box className="admin-content">
          {!online && <Alert severity="warning">连接恢复后可继续管理。</Alert>}
          {open && content[section]}
        </Box>
      </Box>
    </Dialog>
  );
}
