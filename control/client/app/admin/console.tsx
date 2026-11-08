import './console.css';
import BugReportOutlined from '@mui/icons-material/BugReportOutlined';
import CampaignOutlined from '@mui/icons-material/CampaignOutlined';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import DnsOutlined from '@mui/icons-material/DnsOutlined';
import PeopleOutline from '@mui/icons-material/PeopleOutline';
import StorageOutlined from '@mui/icons-material/StorageOutlined';
import { Alert, Box, List, ListItemButton, ListItemIcon, ListItemText, Tab, Tabs } from '@mui/material';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AdminAnnouncementsSection } from './announcements';
import { AdminDiagnosticsSection } from './diagnostics';
import { AdminNodesSection } from './nodes';
import { AdminOverviewSection } from './overview';
import type { AdminCall } from './shared';
import { AdminStorageSection } from './storage';
import { AdminUsersSection } from './users';

const sections = [
  { key: 'overview', label: '概览', icon: <DashboardOutlined /> },
  { key: 'users', label: '用户', icon: <PeopleOutline /> },
  { key: 'announcements', label: '公告', icon: <CampaignOutlined /> },
  { key: 'nodes', label: '节点', icon: <DnsOutlined /> },
  { key: 'storage', label: '存储', icon: <StorageOutlined /> },
  { key: 'diagnostics', label: '诊断', icon: <BugReportOutlined /> },
] as const;
type Section = (typeof sections)[number]['key'];

/** The administrator's console, shown as the built-in `admin` App inside a Window. */
export function AdminApp({
  online,
  self,
  call,
  viewState,
  onState,
}: {
  online: boolean;
  self: string;
  call: AdminCall;
  viewState: Record<string, unknown>;
  onState(state: unknown): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => setCompact(node.offsetWidth < 640);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  const section: Section = sections.find((item) => item.key === viewState.section)?.key ?? 'overview';
  const select = (key: Section) => onState({ ...viewState, section: key });
  const content: Record<Section, ReactElement> = {
    overview: <AdminOverviewSection online={online} call={call} />,
    users: <AdminUsersSection online={online} call={call} self={self} />,
    announcements: <AdminAnnouncementsSection online={online} call={call} />,
    nodes: <AdminNodesSection online={online} call={call} />,
    storage: <AdminStorageSection online={online} call={call} />,
    diagnostics: <AdminDiagnosticsSection online={online} call={call} />,
  };
  return (
    <div ref={host} className={`admin-app${compact ? ' admin-compact' : ''}`}>
      {compact && (
        <Tabs
          value={section}
          onChange={(_, value: Section) => select(value)}
          variant="scrollable"
          scrollButtons={false}
          className="admin-tabs"
        >
          {sections.map((item) => (
            <Tab key={item.key} value={item.key} label={item.label} />
          ))}
        </Tabs>
      )}
      <Box className="admin-body">
        {!compact && (
          <List component="nav" className="admin-nav" aria-label="管理分区">
            {sections.map((item) => (
              <ListItemButton key={item.key} selected={section === item.key} onClick={() => select(item.key)}>
                <ListItemIcon>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} />
              </ListItemButton>
            ))}
          </List>
        )}
        <Box className="admin-content">
          {!online && <Alert severity="warning">连接恢复后可继续管理。</Alert>}
          {content[section]}
        </Box>
      </Box>
    </div>
  );
}
