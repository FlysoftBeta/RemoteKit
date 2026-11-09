import { useEffect, useRef, useState } from 'react';
import { ArrowBack, MoreVert, ShoppingBasketOutlined } from '@mui/icons-material';
import { Alert, Badge, Button } from '@mui/material';
import type { LibraryEntry } from '../../shared/file-library';
import type { LearningCall } from '../learning/queries';
import { Tool } from '../app/window-tool';
import { operationId } from '../control/product-operations';
import { useLibrary } from './file-library-state';
import { basketEntries, fileError } from './file-library-controls';
import { FileTypeIcon } from './file-thumbnail';
import { FilePreview } from './file-preview';
import { FileEntryMenu } from './file-entry-menu';
import { formatFileSize } from './file-format';
import { sourceAppName, sourceChannelName, type FilesTab } from './files-app-state';
import './document-tab.css';

export function DocumentTab({
  tab,
  windowId,
  call,
  onBack,
  onClose,
}: {
  tab: Extract<FilesTab, { kind: 'document' }>;
  windowId: string;
  call?: LearningCall;
  onBack(): void;
  onClose(): void;
}) {
  const { snapshot, online, mutate, apps } = useLibrary();
  const entry = snapshot?.entries.find((entry) => entry.id === tab.entryId);
  const host = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 480));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [!!entry]);
  const [menu, setMenu] = useState<HTMLElement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const basket = basketEntries(snapshot);
  const inBasket = basket.some((item) => item.id === tab.entryId);
  const toggleBasket = async (entry: LibraryEntry) => {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    try {
      await mutate(
        'library.basket',
        {
          operationId: operationId(),
          ids: inBasket
            ? basket.filter((item) => item.id !== entry.id).map((item) => item.id)
            : [...basket.map((item) => item.id), entry.id],
          expectedRevision: snapshot.revision,
        },
        windowId,
      );
    } catch (failure) {
      setError(fileError(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!entry)
    return (
      <div className="document-tab-missing" role="status">
        <span>{snapshot ? '文件已删除' : '正在加载文件…'}</span>
        {snapshot && <Button onClick={onClose}>关闭标签页</Button>}
      </div>
    );
  const secondary = [
    entry.source
      ? [sourceAppName(entry.source.app, apps), sourceChannelName(entry.source)].filter(Boolean).join(' › ')
      : '',
    entry.detail,
    formatFileSize(entry.size),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div ref={host} className={`document-tab${narrow ? ' document-tab-narrow' : ''}`}>
      <div className="navigation-bar document-tab-toolbar">
        {tab.from !== undefined && (
          <Tool title="返回" onClick={onBack}>
            <ArrowBack fontSize="small" />
          </Tool>
        )}
        <span className="document-tab-icon">
          <FileTypeIcon type={entry.type} name={entry.name} />
        </span>
        <div className="document-tab-title">
          <div title={entry.name}>{entry.name}</div>
          <div className="document-tab-secondary" title={secondary}>
            {secondary}
          </div>
        </div>
        <span className="document-tab-spacer" />
        <Tool
          title={inBasket ? '从文件篮移除' : '加入文件篮'}
          disabled={!online || busy || (!inBasket && basket.length >= 64)}
          onClick={() => void toggleBasket(entry)}
        >
          <Badge variant="dot" color="primary" invisible={!inBasket}>
            <ShoppingBasketOutlined fontSize="small" />
          </Badge>
        </Tool>
        <Tool title="更多" disabled={!online} onClick={(event) => setMenu(event.currentTarget)}>
          <MoreVert fontSize="small" />
        </Tool>
      </div>
      {error && (
        <Alert severity="warning" onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      <div className="document-tab-content">
        <FilePreview entry={entry} call={call} />
      </div>
      <FileEntryMenu
        entry={entry}
        anchor={menu}
        windowId={windowId}
        onClose={() => setMenu(undefined)}
        onDeleted={onBack}
      />
    </div>
  );
}
