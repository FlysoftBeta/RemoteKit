import {
  AdminPanelSettingsOutlined,
  FolderOutlined,
  InsertDriveFileOutlined,
  Language,
  SettingsOutlined,
} from '@mui/icons-material';
import {
  BUILTIN_APP_TITLES,
  isBuiltinApp,
  type ProductWorkspace,
  type ProductWindow,
} from '../../shared/product';

export function appName(workspace: ProductWorkspace, win: ProductWindow) {
  return (
    workspace.tabs.find((tab) => tab.id === win.activeTabId)?.title ||
    (isBuiltinApp(win.appId)
      ? BUILTIN_APP_TITLES[win.appId]
      : (workspace.apps.find((app) => `web:${app.id}` === win.appId)?.name ?? 'App'))
  );
}
export function AppIcon({ appId, iconUrl, file }: { appId?: string; iconUrl?: string; file?: boolean }) {
  if (iconUrl) return <img src={iconUrl} className="launcher-app-icon" alt="" draggable={false} />;
  const Icon = file
    ? InsertDriveFileOutlined
    : appId === 'files'
      ? FolderOutlined
      : appId === 'settings'
        ? SettingsOutlined
        : appId === 'admin'
          ? AdminPanelSettingsOutlined
          : Language;
  return <Icon fontSize="inherit" />;
}
