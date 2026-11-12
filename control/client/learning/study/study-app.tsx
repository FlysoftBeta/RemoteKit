import { onFailureAction } from '../../failures';
import { ArrowBack, AttachFileOutlined, MoreHoriz, SchoolOutlined, SyncOutlined } from '@mui/icons-material';
import {
  Button,
  ButtonBase,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Slider,
  TextField,
  Tooltip,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RemoteKitError } from '../../../shared/errors';
import type { LibraryEntry } from '../../../shared/file-library';
import type { ClassMaterial, HomeworkSummary, MaterialType } from '../../../shared/learning';
import { scaledAnchor } from '../../app/ui-scale';
import { operationId } from '../../control/product-operations';
import { failureError, FailureNote, SurfaceState } from '../../failures';
import { recover } from '../../failures/recovery';
import { useLibrary } from '../../files/file-library-state';
import { FilePreview } from '../../files/file-preview';
import { VirtualList } from '../../ui/virtual-list';
import { day, LoadingRows, Segments, SubjectChip, SubjectDot, time, useContentWidth } from '../common';
import { LearningHtml } from '../html';
import type { LearningAppProps } from '../learning-app';
import { LearningQueries, usePaged, useQuery } from '../queries';
import { QuestionCard } from '../question-card';
import { SignInCard } from '../sign-in-card';
import { AttachmentRow, MaterialRow } from './attachment';

const materialTypes: [MaterialType, string][] = [
  ['all', '全部'],
  ['courseware', '课件'],
  ['document', '文档'],
  ['video', '视频'],
  ['audio', '音频'],
  ['image', '图片'],
  ['other', '其他'],
];
function HomeworkStatus({ item }: { item: HomeworkSummary }) {
  return (
    <Chip
      className={`homework-status status-${item.status}`}
      size="small"
      variant="outlined"
      label={
        item.status === 'pending' ? (
          '未提交'
        ) : item.status === 'submitted' ? (
          '已提交'
        ) : (
          <>
            已批改
            {item.score !== undefined && (
              <>
                {' '}
                <b>
                  {item.score}/{item.totalScore ?? '—'}
                </b>
              </>
            )}
          </>
        )
      }
    />
  );
}

export function StudyApp(
  props: LearningAppProps & { openFiles: (entryId?: string, subject?: string) => Promise<void> },
) {
  const { state, call, windowId, tab, online, openFiles } = props;
  const { ref, size } = useContentWidth();
  const library = useLibrary();
  const account = state.learning.accounts.changyan;
  const sync = state.learning.study;
  const previousSync = useRef(sync.lastSyncAt);
  const [login, setLogin] = useState(false);
  useEffect(
    () =>
      onFailureAction((kind, context) => {
        if (kind === 'provider-login' && context.credential === 'changyan') setLogin(true);
      }),
    [],
  );
  const signed = account.status === 'signed_in' || account.status === 'expired' || login;
  const [section, setSection] = useState<'homework' | 'materials'>('homework');
  const [bucket, setBucket] = useState<'active' | 'completed'>('active');
  const [subject, setSubject] = useState('');
  const [materialState, setMaterialState] = useState<'pending' | 'learned'>('pending');
  const [type, setType] = useState<MaterialType>('all');
  const [selected, setSelected] = useState<
    { kind: 'homework'; id: string } | { kind: 'material'; item: ClassMaterial }
  >();
  const [preview, setPreview] = useState<LibraryEntry>();
  const [menu, setMenu] = useState<HTMLElement>();
  const [retention, setRetention] = useState<number>();
  const [error, setError] = useState<RemoteKitError | undefined>();
  const [revision, setRevision] = useState(0);
  const [materialError, setMaterialError] = useState<RemoteKitError | undefined>();
  const queries = useMemo(() => new LearningQueries(call), [call, signed, revision]);
  const subjects = useQuery(
    `subjects:${revision}`,
    () => queries.get('study.subjects', {}),
    signed && online,
  );
  const homeworkKey = JSON.stringify(['homework', bucket, subject, revision, signed]);
  const homework = usePaged(
    homeworkKey,
    (page) => queries.get('study.homework.list', { bucket, subjectCode: subject || undefined, page }),
    signed && online && section === 'homework',
  );
  const materialSubject = subject || subjects.value?.subjects[0]?.code || '';
  const materialsKey = JSON.stringify(['materials', materialSubject, materialState, type, revision, signed]);
  const materials = usePaged(
    materialsKey,
    (page) =>
      queries.get('study.materials.list', { subjectCode: materialSubject, state: materialState, type, page }),
    signed && online && section === 'materials' && !!materialSubject,
  );
  const detail = useQuery(
    `detail:${selected?.kind === 'homework' ? selected.id : ''}:${revision}`,
    () => queries.get('study.homework.detail', { id: selected?.kind === 'homework' ? selected.id : '' }),
    selected?.kind === 'homework' && online,
  );
  const list = section === 'homework' ? homework : materials;
  const selectionKey = section === 'homework' ? homeworkKey : materialsKey;
  const previousSelectionKey = useRef(selectionKey);
  useEffect(() => {
    if (previousSelectionKey.current !== selectionKey) {
      previousSelectionKey.current = selectionKey;
      setSelected(undefined);
      setPreview(undefined);
      return;
    }
    if (size !== 'wide' || selected || !signed) return;
    if (section === 'homework' && homework.items[0]) {
      setSelected({ kind: 'homework', id: homework.items[0].id });
    } else if (section === 'materials' && materials.items[0]) {
      setSelected({ kind: 'material', item: materials.items[0] });
    }
  }, [selectionKey, size, signed, selected, homework.items, materials.items]);
  useEffect(() => {
    if (account.status === 'signed_in') setLogin(false);
  }, [account.status]);
  useEffect(() => {
    if (!signed) {
      setSelected(undefined);
      setPreview(undefined);
    }
  }, [signed]);
  useEffect(() => {
    if (!sync.syncing && sync.lastSyncAt && sync.lastSyncAt !== previousSync.current) {
      previousSync.current = sync.lastSyncAt;
      queries.clear();
      setRevision((value) => value + 1);
    }
  }, [sync.lastSyncAt, sync.syncing]);
  const actionAbort = useRef(new AbortController());
  useEffect(() => () => actionAbort.current.abort(), []);
  const run = async (operation: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await recover(operation, actionAbort.current.signal, setError);
    } catch (failure) {
      setError(failureError(failure));
    }
  };
  const back = () => {
    if (selected?.kind === 'material') {
      setPreview(undefined);
      setSelected(undefined);
      return;
    }
    if (preview) setPreview(undefined);
    else setSelected(undefined);
  };
  const pushed = !!selected && size !== 'wide';
  const selectSection = (next: typeof section) => {
    setSection(next);
    setSelected(undefined);
    setPreview(undefined);
  };
  const selectedMaterial = selected?.kind === 'material' ? selected.item : undefined;
  const materialEntryId =
    selectedMaterial?.attachment.save.state === 'saved'
      ? selectedMaterial.attachment.save.entryId
      : undefined;
  const materialEntry = library.snapshot?.entries.find((entry) => entry.id === materialEntryId);
  useEffect(() => {
    if (!selectedMaterial || materialEntry || !online) return;
    let active = true;
    const abort = new AbortController();
    let savedEntryId = materialEntryId;
    setMaterialError(undefined);
    const open = async () => {
      const entryId = (savedEntryId ??= (
        await call('study.attachment.save', { key: selectedMaterial.attachment.key })
      ).entryId);
      const snapshot = await library.refresh();
      const entry = snapshot.entries.find((item) => item.id === entryId);
      if (!entry) throw new RemoteKitError('unavailable', '文件尚未就绪');
      if (active) setPreview(entry);
    };
    void recover(open, abort.signal, setMaterialError).catch((failure) => {
      if (active) setMaterialError(failureError(failure));
    });
    return () => {
      active = false;
      abort.abort();
    };
  }, [selectedMaterial, online, call, library.refresh]);
  const shownPreview = preview ?? materialEntry;
  const basket = async (entry: LibraryEntry) => {
    const snapshot = library.snapshot;
    if (!snapshot) return;
    if (snapshot.basket.includes(entry.id)) return;
    await library.mutate(
      'library.basket',
      {
        operationId: operationId(),
        expectedRevision: snapshot.revision,
        ids: [...snapshot.basket, entry.id],
      },
      windowId,
    );
  };
  return (
    <div ref={ref} className={`learning-app study-app learning-${size}`}>
      <div className="learning-topbar">
        {pushed ? (
          <div className="learning-back">
            <IconButton aria-label="返回列表" onClick={back}>
              <ArrowBack />
            </IconButton>
            <strong>
              {preview ? preview.name : selected?.kind === 'homework' ? '作业详情' : '资料预览'}
            </strong>
          </div>
        ) : signed ? (
          <Segments
            value={section}
            values={[
              ['homework', '作业'],
              ['materials', '班级资料'],
            ]}
            onChange={selectSection}
            label="学习导航"
          />
        ) : (
          <span />
        )}
        <div className="learning-top-actions">
          {signed && (
            <Tooltip
              title={
                sync.error
                  ? sync.error.message
                  : sync.lastSyncAt
                    ? `上次同步 ${new Date(sync.lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
                    : '立即同步'
              }
            >
              <span>
                <IconButton
                  aria-label="立即同步"
                  disabled={!online || sync.syncing}
                  onClick={() => void run(() => call('study.sync', {}))}
                >
                  <SyncOutlined className={sync.syncing ? 'learning-spinning' : ''} />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <IconButton aria-label="学习菜单" onClick={(event) => setMenu(event.currentTarget)}>
            <MoreHoriz />
          </IconButton>
        </div>
      </div>
      {!online && (
        <SurfaceState
          error={new RemoteKitError('unavailable', '')}
          context={{ operation: '读取学习资料', scope: 'surface' }}
        />
      )}
      {account.status === 'expired' && (
        <SurfaceState
          error={new RemoteKitError('unauthenticated', '')}
          context={{
            operation: '读取学习资料',
            scope: 'surface',
            credential: 'changyan',
            action: { label: '登录畅言', run: () => setLogin(true) },
          }}
        />
      )}
      {error && (
        <SurfaceState
          error={error}
          context={{ operation: '读取学习资料', scope: 'surface', credential: 'changyan' }}
        />
      )}
      {!signed ? (
        <SignInCard
          provider="changyan"
          account={account}
          windowId={windowId}
          tab={tab}
          call={call}
          online={online}
        />
      ) : (
        <div className="study-body">
          {!pushed && (
            <div className="study-master">
              <div className="study-list-filters">
                <Segments
                  value={section === 'homework' ? bucket : materialState}
                  values={
                    section === 'homework'
                      ? [
                          ['active', '进行中'],
                          ['completed', '已完成'],
                        ]
                      : [
                          ['pending', '待学习'],
                          ['learned', '已学习'],
                        ]
                  }
                  onChange={(value) =>
                    section === 'homework'
                      ? setBucket(value as typeof bucket)
                      : setMaterialState(value as typeof materialState)
                  }
                  label="学习状态"
                />
                <div className="learning-chip-scroll" aria-label="学科筛选">
                  {section === 'homework' && (
                    <SubjectChip name="全部" selected={!subject} onClick={() => setSubject('')} />
                  )}
                  {subjects.value?.subjects.map((item) => (
                    <SubjectChip
                      key={item.code}
                      name={item.name}
                      pending={section === 'materials' && item.hasPending}
                      selected={
                        section === 'homework' ? subject === item.code : materialSubject === item.code
                      }
                      onClick={() => setSubject(item.code)}
                    />
                  ))}
                </div>
                {section === 'materials' &&
                  (size === 'narrow' ? (
                    <div className="learning-chip-scroll material-type-chips" aria-label="资料类型">
                      {materialTypes.map(([id, label]) => (
                        <Chip
                          key={id}
                          label={label}
                          variant={type === id ? 'filled' : 'outlined'}
                          onClick={() => setType(id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <TextField
                      select
                      size="small"
                      className="material-type-select"
                      value={type}
                      slotProps={{
                        select: {
                          MenuProps: { className: 'learning-menu' },
                          renderValue: (value) => `类型：${materialTypes.find(([id]) => id === value)?.[1]}`,
                        },
                        htmlInput: { 'aria-label': '资料类型' },
                      }}
                      onChange={(event) => setType(event.target.value as MaterialType)}
                    >
                      {materialTypes.map(([id, label]) => (
                        <MenuItem key={id} value={id}>
                          {label}
                        </MenuItem>
                      ))}
                    </TextField>
                  ))}
              </div>
              <div className="study-list-body">
                <div className="learning-results">
                  {subjects.error && (
                    <SurfaceState
                      error={subjects.error}
                      context={{ operation: '读取学习资料', scope: 'surface', credential: 'changyan' }}
                    />
                  )}
                  {list.error && (
                    <SurfaceState
                      error={list.error}
                      context={{ operation: '读取学习资料', scope: 'surface', credential: 'changyan' }}
                    />
                  )}
                  {list.loading && !list.items.length ? (
                    <LoadingRows />
                  ) : !list.items.length ? (
                    list.error || subjects.error ? null : (
                      <div className="learning-empty">
                        <strong>{section === 'homework' ? '暂无作业' : '暂无班级资料'}</strong>
                        <span>换个筛选条件试试</span>
                      </div>
                    )
                  ) : section === 'homework' ? (
                    <VirtualList
                      key={homeworkKey}
                      items={homework.items}
                      itemKey={(item) => item.id}
                      label="作业列表"
                      estimate={132}
                      stickyHeader={(item) => day(item.startsAt)}
                      onEnd={homework.next}
                      renderItem={(item, index) => (
                        <>
                          {(index === 0 ||
                            day(homework.items[index - 1].startsAt) !== day(item.startsAt)) && (
                            <div className="study-day">{day(item.startsAt)}</div>
                          )}
                          <ButtonBase
                            className={`homework-card${selected?.kind === 'homework' && selected.id === item.id ? ' selected-card' : ''}`}
                            onClick={() => {
                              setSelected({ kind: 'homework', id: item.id });
                              setPreview(undefined);
                            }}
                          >
                            <span className="homework-heading">
                              <span className="homework-subject">
                                <SubjectDot name={item.subject?.name} />
                                {item.subject?.name ?? '其他'}
                              </span>
                              <HomeworkStatus item={item} />
                            </span>
                            <strong>{item.title}</strong>
                            <span className="homework-footer">
                              <span
                                className={
                                  item.status === 'pending' &&
                                  item.endsAt &&
                                  item.endsAt > Date.now() &&
                                  item.endsAt - Date.now() < 86400000
                                    ? 'learning-attention'
                                    : 'learning-muted'
                                }
                              >
                                截止 {time(item.endsAt)}
                              </span>
                              <span
                                className={
                                  item.attachmentCount > 0 && item.attachmentsSaved === item.attachmentCount
                                    ? 'learning-success'
                                    : 'learning-muted'
                                }
                              >
                                <AttachFileOutlined fontSize="small" />
                                {item.attachmentCount}
                              </span>
                            </span>
                          </ButtonBase>
                        </>
                      )}
                    />
                  ) : (
                    <VirtualList
                      key={materialsKey}
                      items={materials.items}
                      itemKey={(item) => item.id}
                      estimate={56}
                      label="班级资料列表"
                      onEnd={materials.next}
                      renderItem={(item) => (
                        <MaterialRow
                          item={item}
                          selected={selected?.kind === 'material' && selected.item.id === item.id}
                          onClick={() => {
                            setSelected({ kind: 'material', item });
                            setPreview(undefined);
                          }}
                        />
                      )}
                    />
                  )}
                  {list.loading && !!list.items.length && <LinearProgress aria-label="正在加载更多" />}
                </div>
              </div>
            </div>
          )}
          {(selected || size === 'wide') && (
            <div className="study-detail">
              {shownPreview ? (
                <>
                  <div className="study-preview-header">
                    {size === 'wide' && selected?.kind === 'homework' && (
                      <IconButton aria-label="返回作业详情" onClick={() => setPreview(undefined)}>
                        <ArrowBack />
                      </IconButton>
                    )}
                    <strong>{shownPreview.name}</strong>
                    <small>
                      {selectedMaterial
                        ? `${selectedMaterial.sharedBy ?? '教师'} · ${day(selectedMaterial.sharedAt)}`
                        : shownPreview.detail}
                    </small>
                    <Button onClick={() => void run(() => openFiles(shownPreview.id))}>
                      在我的文件中查看
                    </Button>
                  </div>
                  <FilePreview
                    key={shownPreview.assetId}
                    entry={shownPreview}
                    call={call}
                    onBasket={() => void run(() => basket(shownPreview))}
                    onFiles={() => void run(() => openFiles(shownPreview.id))}
                  />
                </>
              ) : selectedMaterial ? (
                <div className="study-detail-scroll">
                  <h2>{selectedMaterial.name}</h2>
                  <p className="learning-muted">
                    {selectedMaterial.sharedBy} · {day(selectedMaterial.sharedAt)}
                  </p>
                  {materialError ? (
                    <SurfaceState
                      error={materialError}
                      context={{ operation: '读取学习资料', scope: 'surface', credential: 'changyan' }}
                    />
                  ) : (
                    <LoadingRows />
                  )}
                </div>
              ) : !selected ? (
                <div className="learning-empty study-detail-empty">
                  <SchoolOutlined />
                  <span>{section === 'homework' ? '选择一项作业查看详情' : '选择一份资料预览'}</span>
                </div>
              ) : detail.error ? (
                <SurfaceState
                  error={detail.error}
                  context={{ operation: '读取学习资料', scope: 'surface', credential: 'changyan' }}
                />
              ) : !detail.value ? (
                <LoadingRows />
              ) : (
                <div className="study-detail-scroll">
                  <span className="homework-subject">
                    <SubjectDot name={detail.value.subject?.name} />
                    {detail.value.subject?.name}
                  </span>
                  <h2>{detail.value.title}</h2>
                  <div className="study-detail-meta">
                    <HomeworkStatus item={detail.value} />
                    <span className="learning-muted">
                      布置 {time(detail.value.startsAt)} · 截止 {time(detail.value.endsAt)}
                    </span>
                  </div>
                  {detail.value.description.trim() && <LearningHtml html={detail.value.description} />}
                  <h3>附件</h3>
                  {detail.value.attachments.length ? (
                    detail.value.attachments.map((attachment) => (
                      <AttachmentRow
                        key={attachment.key}
                        attachment={attachment}
                        call={call}
                        open={setPreview}
                      />
                    ))
                  ) : (
                    <p className="learning-muted">暂无附件</p>
                  )}
                  {!!detail.value.questions.length && (
                    <>
                      <h3>题目</h3>
                      {detail.value.questions.map((question) => (
                        <QuestionCard key={question.id} question={question} number={question.number} />
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <Menu
        className="learning-menu"
        anchorEl={scaledAnchor(menu)}
        open={!!menu}
        onClose={() => setMenu(undefined)}
      >
        <MenuItem
          disabled={!signed || !online}
          onClick={() => {
            setRetention(sync.retentionDays);
            setMenu(undefined);
          }}
        >
          附件保留天数…
        </MenuItem>
        <MenuItem
          disabled={!signed || !online}
          onClick={() => {
            setMenu(undefined);
            void run(() => openFiles());
          }}
        >
          在我的文件中查看
        </MenuItem>
        <MenuItem
          disabled={!signed || !online}
          onClick={() => {
            setMenu(undefined);
            void run(() => call('learning.signOut', { provider: 'changyan' }));
          }}
        >
          退出登录
        </MenuItem>
      </Menu>
      <Dialog
        className="learning-dialog"
        open={retention !== undefined}
        onClose={() => setRetention(undefined)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>附件保留天数</DialogTitle>
        <DialogContent>
          <h3>保留 {retention ?? 7} 天</h3>
          <div className="learning-retention-slider">
            <Slider
              aria-label="保留天数"
              value={retention ?? 7}
              min={1}
              max={60}
              marks={[7, 14, 30, 60].map((value) => ({ value, label: String(value) }))}
              onChange={(_, value) => setRetention(value as number)}
            />
          </div>
          <p className="learning-muted">
            自动保存最近 {retention ?? 7}{' '}
            天内布置的作业与班级资料附件。超过天数的附件会从我的文件中移除，已整理到分区的文件会保留。
          </p>
          {error && (
            <FailureNote error={error} context={{ operation: '保存保留时间', scope: 'field', input: true }} />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRetention(undefined)}>取消</Button>
          <Button
            variant="contained"
            disabled={!online}
            onClick={() =>
              void run(async () => {
                await call('study.settings', { retentionDays: retention ?? 7 });
                setRetention(undefined);
              })
            }
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        className="learning-dialog"
        open={login}
        onClose={() =>
          void run(async () => {
            if (account.status === 'signing_in')
              await call('learning.signInCancel', { provider: 'changyan' });
            setLogin(false);
          })
        }
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>重新登录畅言</DialogTitle>
        <DialogContent>
          <SignInCard
            provider="changyan"
            account={account}
            windowId={windowId}
            tab={tab}
            call={call}
            online={online}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
