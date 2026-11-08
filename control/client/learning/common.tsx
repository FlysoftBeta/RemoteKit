import { Alert, Button, Chip, Skeleton, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useLayoutEffect, useRef, useState } from 'react';

const subjectColors: Record<string, string> = {
  语文: '#c43f45',
  数学: '#2874c4',
  英语: '#8254bd',
  物理: '#168580',
  化学: '#37854b',
  生物: '#7c8e27',
  政治: '#c56a24',
  历史: '#93694b',
  地理: '#238ca1',
  其他: '#718096',
};
export const subjectColor = (name?: string) => subjectColors[name ?? ''] ?? subjectColors.其他;
export function SubjectDot({ name }: { name?: string }) {
  return <span className="subject-dot" style={{ background: subjectColor(name) }} />;
}
export function Segments<T extends string>({
  value,
  values,
  onChange,
  label,
}: {
  value: T;
  values: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      aria-label={label}
      onChange={(_, next: T | null) => next && onChange(next)}
    >
      {values.map(([id, name]) => (
        <ToggleButton key={id} value={id}>
          {name}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
export function SubjectChip({
  name,
  selected,
  onClick,
  pending,
}: {
  name: string;
  selected: boolean;
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <Chip
      label={
        <>
          <SubjectDot name={name} />
          {name}
          {pending && <span className="learning-pending-badge" role="img" aria-label="有待学习资料" />}
        </>
      }
      variant={selected ? 'filled' : 'outlined'}
      onClick={onClick}
      aria-pressed={selected}
    />
  );
}
export function LoadingRows() {
  return (
    <div className="learning-loading" role="status" aria-label="正在加载">
      <Skeleton width="32%" />
      <Skeleton height={64} />
      <Skeleton height={64} />
      <Skeleton height={64} />
    </div>
  );
}
export function InlineError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Alert severity="error" action={<Button onClick={retry}>重试</Button>}>
      {error}
    </Alert>
  );
}
export function useContentWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current!;
    const resize = () => setWidth(node.clientWidth);
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    return () => observer.disconnect();
  }, []);
  return { ref, width, size: width >= 960 ? 'wide' : width >= 600 ? 'medium' : 'narrow' };
}
export const time = (value?: number) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '未设置';
export function day(value?: number) {
  if (!value) return '未设置日期';
  const date = new Date(value);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (value >= start && value < start + 86400000) return '今天';
  if (value >= start - 86400000 && value < start) return '昨天';
  return date
    .toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
    .replace('日', '日 ');
}
