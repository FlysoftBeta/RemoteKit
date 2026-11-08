import './setting-layout.css';
import { Switch, Typography } from '@mui/material';
import React from 'react';

export function SettingSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="setting-section">
      <div className="setting-heading">
        <Typography component="h3" fontWeight={600}>
          {title}
        </Typography>
        {action}
      </div>
      {children}
    </section>
  );
}

function SettingText({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <span className="setting-text">
      <Typography component="span">{title}</Typography>
      {description && (
        <Typography component="span" variant="body2" color="text.secondary">
          {description}
        </Typography>
      )}
    </span>
  );
}

export function SettingRow({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <SettingText title={title} description={description} />
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

export function SettingSwitch({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`setting-row setting-toggle${disabled ? ' disabled' : ''}`}>
      <SettingText title={title} description={description} />
      <Switch checked={checked} disabled={disabled} onChange={(_, value) => onChange(value)} />
    </label>
  );
}

export function SettingNote({ text, error }: { text: string; error: boolean }) {
  return (
    <Typography className="setting-result" role="status" color={error ? 'error' : 'text.secondary'}>
      {text}
    </Typography>
  );
}
