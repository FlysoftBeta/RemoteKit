import { useEffect, useState } from 'react';
import type { IdleKeepAliveOutcome, ProductAction, ProductTab } from '../../shared/product';
import { SurfaceState } from './components';

export function idleKeepAliveText(record: IdleKeepAliveOutcome) {
  if (record.outcome === 'survived') {
    const minutes = Math.max(0, Math.floor(((record.returnedAt ?? record.at) - record.leftAt) / 60_000));
    const hours = Math.floor(minutes / 60);
    return `挂机期间页面保持运行（${hours ? `${hours} 小时 ` : ''}${minutes % 60} 分）`;
  }
  const time = new Date(record.at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const reason = { statistics: '统计判断长时间未使用', pressure: '节点资源紧张', exhaustion: '节点内存不足' }[
    record.reason
  ];
  return `页面于 ${time} 因${reason}被回收，已重新打开，页面内未保存的状态可能丢失`;
}

export class IdleKeepAliveReturns {
  private readonly seen = new Map<string, string>();
  take(tenant: string, tab: ProductTab | undefined) {
    const record = tab?.idleKeepAliveOutcome;
    if (!tab || !record || record.returnedAt === undefined) return;
    const key = `${tenant}/${tab.id}`;
    const identity = JSON.stringify(record);
    if (this.seen.get(key) === identity) return;
    this.seen.set(key, identity);
    return { ...record };
  }
}
const returns = new IdleKeepAliveReturns();

export function IdleKeepAliveNotice({
  tenant,
  tab,
  visible,
  acknowledge,
}: {
  tenant: string;
  tab?: ProductTab;
  visible: boolean;
  acknowledge(action: ProductAction): void;
}) {
  const [notice, setNotice] = useState<{ tabId: string; record: IdleKeepAliveOutcome }>();
  useEffect(() => {
    if (!visible) return;
    const record = returns.take(tenant, tab);
    if (!record || !tab) return;
    setNotice({ tabId: tab.id, record });
    acknowledge({
      type: 'tab.ackIdleKeepAliveOutcome',
      tabId: tab.id,
      at: record.at,
      returnedAt: record.returnedAt!,
    });
  }, [tenant, tab, visible, acknowledge]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 10_000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!visible || notice?.tabId !== tab?.id || !notice) return null;
  return (
    <SurfaceState
      live
      presentation={{ class: 'info', text: idleKeepAliveText(notice.record) }}
      onDismiss={() => setNotice(undefined)}
    />
  );
}
