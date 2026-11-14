import { QuizOutlined, SchoolOutlined, VisibilityOffOutlined, VisibilityOutlined } from '@mui/icons-material';
import { Button, IconButton, InputAdornment, LinearProgress, TextField } from '@mui/material';
import { useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { LearningAccount, LearningProvider } from '../../shared/learning';
import type { ProductTab } from '../../shared/product';
import { failureError, FailureNote } from '../failures';
import type { LearningCall } from './queries';
import { SignInView } from './sign-in-view';

export function SignInCard({
  provider,
  account,
  windowId,
  tab,
  call,
  online,
}: {
  provider: LearningProvider;
  account: LearningAccount;
  windowId: string;
  tab?: ProductTab;
  call: LearningCall;
  online: boolean;
}) {
  const study = provider === 'changyan';
  const [username, setUsername] = useState('username' in account ? (account.username ?? '') : '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteKitError | undefined>();
  const failedFlow = account.status === 'failed' && !!account.failureKind;
  const signing = account.status === 'signing_in';
  const remote = signing && (account.step === 'verification' || account.step === 'site');
  const finishing = signing && account.step === 'finishing';
  const signIn = async () => {
    if (!online || busy || signing || (study && (!username.trim() || !password))) return;
    setBusy(true);
    setError(undefined);
    const secret = password;
    setPassword('');
    try {
      await call(
        'learning.signIn',
        study
          ? { provider: 'changyan', windowId, username, password: secret }
          : { provider: 'xinjiaoyu', windowId },
      );
    } catch (failure) {
      setError(failureError(failure));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      await call('learning.signInCancel', { provider });
    } catch (failure) {
      setError(failureError(failure));
    }
  };
  return (
    <div className={`learning-auth${remote && !study ? ' learning-auth-site' : ''}`}>
      <form
        className={`learning-auth-card${remote ? ' verification-card' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void signIn();
        }}
      >
        {remote ? (
          <>
            <div className="learning-auth-heading">
              <h2>{study ? '请完成安全验证' : '登录新教育'}</h2>
              <Button disabled={!online} onClick={() => void cancel()}>
                取消
              </Button>
            </div>
            <SignInView tab={tab} />
            <p className="learning-verification-caption">
              {study ? '验证完成后会自动继续' : '登录完成后会自动返回题库'}
            </p>
          </>
        ) : (
          <>
            <div className="learning-auth-icon">{study ? <SchoolOutlined /> : <QuizOutlined />}</div>
            <h2>{study ? '登录畅言' : '登录新教育'}</h2>
            <p>{study ? '作业和班级资料使用同一个畅言账号' : '在下方页面中登录你的新教育账号'}</p>
            {finishing ? (
              <div role="status">
                <LinearProgress />
                <p>正在登录…</p>
              </div>
            ) : (
              <>
                {study && (
                  <>
                    <TextField
                      label="账号"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      disabled={busy || signing}
                      fullWidth
                    />
                    <TextField
                      label="密码"
                      type={show ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="off"
                      disabled={busy || signing}
                      fullWidth
                      slotProps={{
                        input: {
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                aria-label={show ? '隐藏密码' : '显示密码'}
                                onClick={() => setShow(!show)}
                              >
                                {show ? <VisibilityOffOutlined /> : <VisibilityOutlined />}
                              </IconButton>
                            </InputAdornment>
                          ),
                        },
                      }}
                    />
                  </>
                )}
                <Button
                  type="submit"
                  fullWidth
                  variant="contained"
                  disabled={!online || busy || signing || (study && (!username.trim() || !password))}
                >
                  {busy || signing ? '正在登录…' : study ? '登录' : '开始登录'}
                </Button>
              </>
            )}
          </>
        )}
        <FailureNote
          error={
            error ??
            (account.status === 'failed' || account.status === 'unknown' || account.status === 'signing_in'
              ? account.error
              : undefined)
          }
          context={{
            operation: '登录学习账户',
            scope: 'surface',
            credential: provider,
            resolved: account.status === 'unknown',
            input: true,
            issue: failedFlow ? 'content' : 'credentials',
            text: failedFlow
              ? account.failureKind === 'expired'
                ? '登录验证已过期，账户尚未登录'
                : '登录页面已结束，账户尚未登录'
              : undefined,
            action: failedFlow
              ? {
                  label: '开始登录',
                  run: () => {
                    if (study) document.querySelector<HTMLInputElement>('.learning-auth-card input')?.focus();
                    else void signIn();
                  },
                }
              : undefined,
          }}
        />
      </form>
    </div>
  );
}
