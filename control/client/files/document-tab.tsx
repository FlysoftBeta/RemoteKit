import { ArrowBack, MoreVert, ShoppingBasketOutlined } from '@mui/icons-material';
import { Badge, Button } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LibraryEntry } from '../../shared/file-library';
import { Tool } from '../app/window-tool';
import { operationId } from '../control/product-operations';
import { failureError, FailureNote, SurfaceState } from '../failures';
import { recoverRead as recover } from '../failures/recovery';
import type { LearningCall } from '../learning/queries';
import './document-tab.css';
import { FileEntryMenu } from './file-entry-menu';
import { formatFileSize } from './file-format';
import { basketEntries } from './file-library-controls';
import { useLibrary } from './file-library-state';
import { FilePreview } from './file-preview';
import { FileTypeIcon } from './file-thumbnail';
import { sourceAppName, sourceChannelName, type FilesTab } from './files-app-state';
import { snippetOriginLabel } from './snippet-view';

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
  const [error, setError] = useState<RemoteKitError | undefined>();
  const basket = basketEntries(snapshot);
  const inBasket = basket.some((item) => item.id === tab.entryId);
  const toggleBasket = async (entry: LibraryEntry) => {
    if (!snapshot) return;
    setBusy(true);
    setError(undefined);
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
      setError(failureError(failure));
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
    entry.kind === 'snippet' ? snippetOriginLabel(entry.origin, apps) : '',
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
        {entry.kind === 'file' && (
          <span className="document-tab-icon">
            <FileTypeIcon type={entry.type} name={entry.name} />
          </span>
        )}
        <div className="document-tab-title">
          <div title={entry.name}>{entry.kind === 'snippet' ? '剪贴片段' : entry.name}</div>
          <div className="document-tab-secondary" title={secondary}>
            {secondary}
          </div>
        </div>
        <span className="document-tab-spacer" />
        {entry.kind === 'file' && (
          <Tool
            title={inBasket ? '从文件篮移除' : '加入文件篮'}
            disabled={!online || busy || (!inBasket && (!entry.available || basket.length >= 64))}
            onClick={() => void toggleBasket(entry)}
          >
            <Badge variant="dot" color="primary" invisible={!inBasket}>
              <ShoppingBasketOutlined fontSize="small" />
            </Badge>
          </Tool>
        )}
        <Tool title="更多" disabled={!online} onClick={(event) => setMenu(event.currentTarget)}>
          <MoreVert fontSize="small" />
        </Tool>
      </div>
      <div className="document-tab-content">
        <SurfaceState live error={error} context={{ operation: '读取阅读位置', scope: 'surface' }} />
        {entry.kind === 'snippet' ? (
          <SnippetDocument id={entry.id} />
        ) : (
          <FilePreview entry={entry} call={call} />
        )}
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

function SnippetDocument({ id }: { id: string }) {
  const { snippet } = useLibrary();
  const [text, setText] = useState<string>();
  const [error, setError] = useState<RemoteKitError | undefined>();
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    void recover(() => snippet(id), abort.signal, setError).then(
      (value) => {
        if (active) {
          setText(value.text);
          setError(undefined);
        }
      },
      (error) => {
        if (active) setError(failureError(error));
      },
    );
    return () => {
      active = false;
      abort.abort();
    };
  }, [id, snippet]);
  return (
    <div
      className="snippet-document"
      data-selectable
      style={{
        padding: 24,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: 'inherit',
        lineHeight: 1.7,
      }}
    >
      {error ? (
        <FailureNote
          error={error}
          context={{ operation: '读取剪贴片段', scope: 'surface', consequence: '文件列表仍保留' }}
        />
      ) : (
        (text ?? '正在加载…')
      )}
    </div>
  );
}
