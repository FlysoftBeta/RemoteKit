import { CloudDoneOutlined, CloudOffOutlined, CloudSyncOutlined, ErrorOutline } from '@mui/icons-material';
import { Badge, Button, IconButton, Popover, Typography } from '@mui/material';
import { useState } from 'react';
import { scaledAnchor } from './ui-scale';

export interface SyncSummary {
  pending: number;
  unknown: boolean;
  channelReady: boolean;
  dismissUnknown(): void;
}

/** The one place that shows whether workspace operations have reached the Endpoint. */
export function SyncStatus({ pending, unknown, channelReady, dismissUnknown }: SyncSummary) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const label = unknown
    ? `${pending} 个操作结果未知，请核对工作区`
    : pending > 0
      ? `${pending} 个操作正在同步${channelReady ? '' : '，等待数据通道连接'}`
      : channelReady
        ? '已同步'
        : '数据通道未连接';
  const icon = unknown ? (
    <ErrorOutline color="warning" />
  ) : pending > 0 ? (
    <Badge badgeContent={pending} color="primary" max={99}>
      <CloudSyncOutlined color="primary" />
    </Badge>
  ) : channelReady ? (
    <CloudDoneOutlined color="action" />
  ) : (
    <CloudOffOutlined color="action" />
  );
  return (
    <>
      <IconButton
        className="sync-status"
        aria-label={label}
        title={label}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        {icon}
      </IconButton>
      <Popover
        open={!!anchor}
        anchorEl={scaledAnchor(anchor)}
        onClose={() => setAnchor(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <div className="sync-status-detail">
          <Typography variant="body2">{label}</Typography>
          {unknown && (
            <Button
              size="small"
              onClick={() => {
                dismissUnknown();
                setAnchor(undefined);
              }}
            >
              以当前工作区为准
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}
