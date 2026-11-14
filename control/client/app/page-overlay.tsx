import './page-overlay.css';
import { CircularProgress } from '@mui/material';
import React from 'react';

export function PageOverlay({ children }: { kind: 'progress'; children: React.ReactNode }) {
  return (
    <div className="page-overlay" role="status">
      <CircularProgress size={24} thickness={4.5} />
      <span className="page-overlay-text">{children}</span>
    </div>
  );
}
