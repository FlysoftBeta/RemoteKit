import { FolderOutlined, InsertDriveFileOutlined, Language, SettingsOutlined } from '@mui/icons-material';
import type { ProductWorkspace, ProductWindow } from '../../shared/product';

export function appName(workspace: ProductWorkspace, win: ProductWindow) {
  return (
    workspace.tabs.find((tab) => tab.id === win.activeTabId)?.title ||
    (win.appId === 'browser'
      ? '浏览器'
      : win.appId === 'files'
        ? '我的文件'
        : win.appId === 'settings'
          ? '设置'
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
        : Language;
  return <Icon fontSize="inherit" />;
}
