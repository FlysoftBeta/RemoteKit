import { ErrorOutline } from '@mui/icons-material';
import { CircularProgress } from '@mui/material';
import React from 'react';

export function PageOverlay({
  kind,
  children,
  action,
}: {
  kind: 'progress' | 'error';
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-overlay" role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'error' ? <ErrorOutline color="action" /> : <CircularProgress size={24} thickness={4.5} />}
      <span className="page-overlay-text">{children}</span>
      {action}
    </div>
  );
}
