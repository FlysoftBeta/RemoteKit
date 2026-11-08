import {
  Close,
  FilterListOutlined,
  MoreHoriz,
  SearchOutlined,
  ExpandMore,
  VisibilityOutlined,
  VisibilityOffOutlined,
} from '@mui/icons-material';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControlLabel,
  IconButton,
  InputAdornment,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Switch,
  TextField,
  Tooltip,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { scaledAnchor } from '../../app/ui-scale';
import type { BankCatalogNode, BankQuestionType } from '../../../shared/learning';
import { VirtualList } from '../../ui/virtual-list';
import type { LearningAppProps } from '../learning-app';
import { InlineError, LoadingRows, SubjectDot, useContentWidth } from '../common';
import { LearningQueries, usePaged, useQuery } from '../queries';
import { QuestionCard } from '../question-card';
import { SignInCard } from '../sign-in-card';

function Catalog({
  nodes,
  selected,
  select,
}: {
  nodes: BankCatalogNode[];
  selected: string;
  select: (id: string) => void;
}) {
  return (
    <ul className="bank-catalog">
      {nodes.map((node) => (
        <li key={node.id}>
          {node.children.length ? (
            <details>
              <summary className={selected === node.id ? 'catalog-selected' : ''}>
                {node.selectable ? (
                  <Button
                    onClick={(event) => {
                      event.preventDefault();
                      select(node.id);
                    }}
                  >
                    {node.title}
                  </Button>
                ) : (
                  node.title
                )}
              </summary>
              <Catalog nodes={node.children} selected={selected} select={select} />
            </details>
          ) : (
            <Button
              disabled={!node.selectable}
              className={selected === node.id ? 'catalog-selected' : ''}
              onClick={() => select(node.id)}
            >
              {node.title}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
const flattenTypes = (types: BankQuestionType[]): BankQuestionType[] =>
  types.flatMap((type) => [type, ...flattenTypes(type.children)]);
const findCatalog = (nodes: BankCatalogNode[], id: string): string | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node.title;
    const found = findCatalog(node.children, id);
    if (found) return found;
  }
};

export function QuestionsApp({ state, call, windowId, tab, online }: LearningAppProps) {
  const { ref, size } = useContentWidth();
  const account = state.learning.accounts.xinjiaoyu;
  const [login, setLogin] = useState(false);
  const signed = account.status === 'signed_in' || account.status === 'expired' || login;
  const [subject, setSubject] = useState('');
  const [textbook, setTextbook] = useState('');
  const [catalog, setCatalog] = useState('');
  const [typeIds, setTypeIds] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [showAnswers, setShowAnswers] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [typeMenu, setTypeMenu] = useState<HTMLElement>();
  const [difficultyMenu, setDifficultyMenu] = useState<HTMLElement>();
  const [sortMenu, setSortMenu] = useState<HTMLElement>();
  const [menu, setMenu] = useState<HTMLElement>();
  const [error, setError] = useState('');
  const queries = useMemo(() => new LearningQueries(call), [call, signed]);
  const subjects = useQuery(
    `bank-subjects:${signed}`,
    () => queries.get('bank.subjects', {}),
    signed && online,
  );
  const subjectId = subject || subjects.value?.subjects[0]?.id || '';
  const metadata = useQuery(
    `bank-subject:${subjectId}`,
    () => queries.get('bank.subject', { subjectId }),
    signed && online && !!subjectId,
  );
  const catalogs = useQuery(
    `bank-catalog:${subjectId}:${textbook}`,
    () => queries.get('bank.catalog', { subjectId, textbookId: textbook }),
    signed && online && !!subjectId && !!textbook,
  );
  const query = {
    subjectId,
    textbookId: textbook || undefined,
    catalogId: catalog || undefined,
    typeIds: typeIds.length ? typeIds : undefined,
    difficultyIds: difficulty ? [difficulty] : undefined,
    search: debounced.trim() || undefined,
    sort,
    pageSize: 30,
  };
  const key = JSON.stringify([query, signed]);
  const questions = usePaged(
    key,
    (page) => queries.get('bank.questions', { ...query, page }),
    signed && online && !!subjectId,
  );
  const types = flattenTypes(metadata.value?.types ?? []);
  const selectedSubject = subjects.value?.subjects.find((item) => item.id === subjectId);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (account.status === 'signed_in') setLogin(false);
  }, [account.status]);
  const changeSubject = (id: string) => {
    setSubject(id);
    setTextbook('');
    setCatalog('');
    setTypeIds([]);
    setDifficulty('');
  };
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  const sidebar = (
    <aside className="bank-sidebar" aria-label="题库筛选">
      <div className="bank-sidebar-heading">
        <strong>学科</strong>
        {size !== 'wide' && (
          <IconButton aria-label="关闭筛选" onClick={() => setDrawer(false)}>
            <Close />
          </IconButton>
        )}
      </div>
      {subjects.error ? (
        <InlineError error={subjects.error} retry={subjects.retry} />
      ) : !subjects.value ? (
        <LoadingRows />
      ) : !subjects.value.subjects.length ? (
        <p className="learning-muted">暂无可用学科</p>
      ) : (
        <List aria-label="题库学科">
          {subjects.value.subjects.map((item) => (
            <ListItemButton
              key={item.id}
              selected={subjectId === item.id}
              onClick={() => changeSubject(item.id)}
            >
              <SubjectDot name={item.name} />
              <ListItemText primary={item.name} />
              <span className="learning-muted bank-stage">{item.stage}</span>
            </ListItemButton>
          ))}
        </List>
      )}
      {metadata.error && <InlineError error={metadata.error} retry={metadata.retry} />}
      {metadata.value && (
        <>
          <TextField
            select
            slotProps={{ select: { MenuProps: { className: 'learning-menu' } } }}
            label="教材"
            size="small"
            fullWidth
            value={textbook}
            onChange={(event) => {
              setTextbook(event.target.value);
              setCatalog('');
            }}
          >
            <MenuItem value="">全部教材</MenuItem>
            {metadata.value.textbooks.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {item.name}
                {item.edition ? ` · ${item.edition}` : ''}
              </MenuItem>
            ))}
          </TextField>
          <details className="bank-chapters" open>
            <summary>章节</summary>
            <Button fullWidth className={!catalog ? 'catalog-selected' : ''} onClick={() => setCatalog('')}>
              全部章节
            </Button>
            {catalogs.error ? (
              <InlineError error={catalogs.error} retry={catalogs.retry} />
            ) : !textbook ? (
              <p className="learning-muted">选择教材后查看章节</p>
            ) : !catalogs.value ? (
              <LoadingRows />
            ) : (
              <Catalog nodes={catalogs.value.nodes} selected={catalog} select={setCatalog} />
            )}
          </details>
        </>
      )}
      {size !== 'wide' && (
        <div className="bank-drawer-controls">
          <TextField
            select
            fullWidth
            size="small"
            label="题型"
            value={typeIds}
            slotProps={{ select: { multiple: true, MenuProps: { className: 'learning-menu' } } }}
            onChange={(event) =>
              setTypeIds(
                typeof event.target.value === 'string'
                  ? event.target.value.split(',').filter(Boolean)
                  : event.target.value,
              )
            }
          >
            {types.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                <Checkbox checked={typeIds.includes(item.id)} />
                {item.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            size="small"
            slotProps={{ select: { MenuProps: { className: 'learning-menu' } } }}
            label="难度"
            value={difficulty}
            onChange={(event) => setDifficulty(event.target.value)}
          >
            <MenuItem value="">全部难度</MenuItem>
            {metadata.value?.difficulties.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {item.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            fullWidth
            size="small"
            slotProps={{ select: { MenuProps: { className: 'learning-menu' } } }}
            label="排序"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <MenuItem value="newest">最新</MenuItem>
            <MenuItem value="oldest">最早</MenuItem>
          </TextField>
        </div>
      )}
    </aside>
  );
  const activeFilters = (
    <div className="learning-chips bank-active-filters">
      {textbook && (
        <Chip
          size="small"
          label={metadata.value?.textbooks.find((item) => item.id === textbook)?.name ?? '教材'}
          onDelete={() => {
            setTextbook('');
            setCatalog('');
          }}
        />
      )}
      {catalog && (
        <Chip
          size="small"
          label={findCatalog(catalogs.value?.nodes ?? [], catalog) ?? '章节'}
          onDelete={() => setCatalog('')}
        />
      )}
      {typeIds.map((id) => (
        <Chip
          key={id}
          size="small"
          label={types.find((type) => type.id === id)?.name ?? id}
          onDelete={() => setTypeIds(typeIds.filter((value) => value !== id))}
        />
      ))}
      {difficulty && (
        <Chip
          size="small"
          label={metadata.value?.difficulties.find((item) => item.id === difficulty)?.name ?? difficulty}
          onDelete={() => setDifficulty('')}
        />
      )}
      {sort === 'oldest' && <Chip size="small" label="最早" onDelete={() => setSort('newest')} />}
    </div>
  );
  return (
    <div ref={ref} className={`learning-app questions-app learning-${size}`}>
      <div className="learning-topbar">
        <strong>
          {signed && selectedSubject ? `${selectedSubject.name} · ${selectedSubject.stage}` : '题库'}
        </strong>
        <div className="learning-top-actions">
          <span className="learning-muted">
            {account.status === 'signed_in' || account.status === 'expired' ? account.displayName : '未登录'}
          </span>
          <IconButton aria-label="题库菜单" onClick={(event) => setMenu(event.currentTarget)}>
            <MoreHoriz />
          </IconButton>
        </div>
      </div>
      {!online && <Alert severity="info">连接已断开，恢复后可继续浏览</Alert>}
      {account.status === 'expired' && (
        <Alert severity="warning" action={<Button onClick={() => setLogin(true)}>重新登录</Button>}>
          新教育登录已过期
        </Alert>
      )}
      {error && (
        <InlineError
          error={error}
          retry={() => {
            setError('');
            void call('learning.signOut', { provider: 'xinjiaoyu' }).catch((failure) =>
              setError(failure.message),
            );
          }}
        />
      )}
      {!signed ? (
        <SignInCard
          provider="xinjiaoyu"
          account={account}
          windowId={windowId}
          tab={tab}
          call={call}
          online={online}
        />
      ) : (
        <div className="bank-body">
          {size === 'wide' && sidebar}
          <main className="bank-main">
            <div className="bank-toolbar">
              <div className="bank-search-row">
                <TextField
                  size="small"
                  placeholder="搜索题目"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  slotProps={{
                    htmlInput: { 'aria-label': '搜索题目' },
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchOutlined />
                        </InputAdornment>
                      ),
                      endAdornment: search ? (
                        <InputAdornment position="end">
                          <IconButton aria-label="清除搜索" onClick={() => setSearch('')}>
                            <Close />
                          </IconButton>
                        </InputAdornment>
                      ) : undefined,
                    },
                  }}
                />
                {size === 'wide' ? (
                  <>
                    <Button endIcon={<ExpandMore />} onClick={(event) => setTypeMenu(event.currentTarget)}>
                      题型{typeIds.length ? ` (${typeIds.length})` : ''}
                    </Button>
                    <Button
                      endIcon={<ExpandMore />}
                      onClick={(event) => setDifficultyMenu(event.currentTarget)}
                    >
                      {metadata.value?.difficulties.find((item) => item.id === difficulty)?.name ?? '难度'}
                    </Button>
                    <Button endIcon={<ExpandMore />} onClick={(event) => setSortMenu(event.currentTarget)}>
                      排序
                    </Button>
                    <FormControlLabel
                      control={
                        <Switch checked={showAnswers} onChange={(_, checked) => setShowAnswers(checked)} />
                      }
                      label="显示答案"
                    />
                  </>
                ) : (
                  <>
                    <Button startIcon={<FilterListOutlined />} onClick={() => setDrawer(true)}>
                      筛选
                    </Button>
                    <Tooltip title="显示答案">
                      <IconButton
                        aria-label="显示答案"
                        aria-pressed={showAnswers}
                        onClick={() => setShowAnswers(!showAnswers)}
                      >
                        {showAnswers ? <VisibilityOutlined /> : <VisibilityOffOutlined />}
                      </IconButton>
                    </Tooltip>
                  </>
                )}
              </div>
              {size !== 'wide' && activeFilters}
            </div>
            {questions.value && (
              <div className="bank-result-count">
                共 {questions.value.total.toLocaleString('zh-CN')} 题 · 可浏览{' '}
                {questions.value.accessibleTotal.toLocaleString('zh-CN')} 题
              </div>
            )}
            {metadata.error && <InlineError error={metadata.error} retry={metadata.retry} />}
            {size !== 'wide' && subjects.error && (
              <InlineError error={subjects.error} retry={subjects.retry} />
            )}
            {questions.error && <InlineError error={questions.error} retry={questions.retry} />}
            {(questions.loading || (online && !subjects.value && !subjects.error)) &&
            !questions.items.length ? (
              <LoadingRows />
            ) : questions.items.length ? (
              <VirtualList
                key={key}
                items={questions.items}
                itemKey={(item) => item.id}
                label="题目列表"
                estimate={360}
                onEnd={questions.next}
                renderItem={(question, index) => (
                  <QuestionCard question={question} number={String(index + 1)} showAnswers={showAnswers} />
                )}
              />
            ) : questions.error || subjects.error ? null : (
              <div className="learning-empty">
                <strong>暂无题目</strong>
                <span>换个关键词或筛选条件试试</span>
              </div>
            )}
            {questions.loading && !!questions.items.length && <LinearProgress aria-label="正在加载更多" />}
          </main>
          <Drawer
            anchor="left"
            open={drawer && size !== 'wide'}
            onClose={() => setDrawer(false)}
            slotProps={{ paper: { className: 'learning-drawer' } }}
          >
            {sidebar}
          </Drawer>
        </div>
      )}
      <Menu
        className="learning-menu"
        anchorEl={scaledAnchor(typeMenu)}
        open={!!typeMenu}
        onClose={() => setTypeMenu(undefined)}
      >
        <MenuItem onClick={() => setTypeIds([])}>全部题型</MenuItem>
        {types.map((type) => (
          <MenuItem key={type.id} onClick={() => setTypeIds(toggle(typeIds, type.id))}>
            <Checkbox checked={typeIds.includes(type.id)} />
            {type.name}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        className="learning-menu"
        anchorEl={scaledAnchor(difficultyMenu)}
        open={!!difficultyMenu}
        onClose={() => setDifficultyMenu(undefined)}
      >
        <MenuItem
          selected={!difficulty}
          onClick={() => {
            setDifficulty('');
            setDifficultyMenu(undefined);
          }}
        >
          全部难度
        </MenuItem>
        {metadata.value?.difficulties.map((item) => (
          <MenuItem
            key={item.id}
            selected={difficulty === item.id}
            onClick={() => {
              setDifficulty(item.id);
              setDifficultyMenu(undefined);
            }}
          >
            {item.name}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        className="learning-menu"
        anchorEl={scaledAnchor(sortMenu)}
        open={!!sortMenu}
        onClose={() => setSortMenu(undefined)}
      >
        {(
          [
            ['newest', '最新'],
            ['oldest', '最早'],
          ] as const
        ).map(([value, label]) => (
          <MenuItem
            key={value}
            selected={sort === value}
            onClick={() => {
              setSort(value);
              setSortMenu(undefined);
            }}
          >
            {label}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        className="learning-menu"
        anchorEl={scaledAnchor(menu)}
        open={!!menu}
        onClose={() => setMenu(undefined)}
      >
        <MenuItem
          disabled={!signed || !online}
          onClick={() => {
            setMenu(undefined);
            void call('learning.signOut', { provider: 'xinjiaoyu' }).catch((failure) =>
              setError(failure.message),
            );
          }}
        >
          退出登录
        </MenuItem>
      </Menu>
      <Dialog
        className="learning-dialog"
        open={login}
        onClose={() => {
          if (account.status === 'signing_in')
            void call('learning.signInCancel', { provider: 'xinjiaoyu' })
              .then(() => setLogin(false))
              .catch((failure) => setError(failure.message));
          else setLogin(false);
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>重新登录新教育</DialogTitle>
        <DialogContent>
          <SignInCard
            provider="xinjiaoyu"
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
