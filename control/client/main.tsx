/// <reference types="vite/client" />
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteKitError } from '../shared/errors';
import type { ProductUser } from '../shared/product';
import { AuthView } from './app/product-dialogs';
import { WorkspaceView } from './app/workspace-view';
import { BlankScreen, RevealScreen } from './auth/lock-screen';
import { request } from './control/http-request';
import { failureError, SurfaceState } from './failures';
import { recover } from './failures/recovery';
import { selectProductReceiveProfile } from './media/receive-profile';
import { LocalSelection } from './selection/local-selection';
import './style.css';
import './theme/mui.css';
import './theme/tokens.css';
// Automation hooks exist only in dev builds; Vite drops this branch from production.
if (import.meta.env.DEV) void import('./test-hooks');
const tokens = getComputedStyle(document.documentElement);
const token = (name: string) => tokens.getPropertyValue(`--${name}`).trim();
const theme = createTheme({
  palette: {
    primary: { main: token('primary') },
    background: { default: token('surface-background'), paper: token('surface') },
    text: { primary: token('text-primary'), secondary: token('text-secondary') },
    divider: token('border'),
  },
  typography: {
    fontFamily: token('font-family'),
    fontSize: 14,
  },
  shape: { borderRadius: Number.parseFloat(token('radius-md')) },
  components: {
    MuiIconButton: { defaultProps: { size: 'small' } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiDialog: { defaultProps: { transitionDuration: 150 } },
  },
});
function App() {
  const [user, setUser] = useState<ProductUser | null | undefined>(undefined),
    [notice, setNotice] = useState<RemoteKitError>(),
    [connectionError, setConnectionError] = useState<RemoteKitError | undefined>();
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => {
    void selectProductReceiveProfile(RTCRtpReceiver.getCapabilities?.('video')?.codecs);

    const abort = new AbortController();
    void recover(() => request<{ user: ProductUser }>('/api/auth/me'), abort.signal, setConnectionError).then(
      (result) => {
        setConnectionError(undefined);
        setUser(result.user);
      },
      (error) => {
        if (error.code === 'unauthenticated') {
          setConnectionError(undefined);
          setUser(null);
        }
      },
    );
    return () => abort.abort();
  }, []);
  const logout = () => {
    setUser(null);
    void recover(() => request('/api/auth/logout', {}), lifetime.current.signal, setNotice).then(
      () => setNotice(undefined),
      (error) => setNotice(failureError(error)),
    );
  };
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LocalSelection />
      {connectionError ? (
        <main className="auth-page">
          <div className="auth-form">
            <SurfaceState
              error={connectionError}
              context={{ operation: '连接服务', scope: 'full-screen', connection: true }}
            />
          </div>
        </main>
      ) : user === undefined ? (
        <BlankScreen />
      ) : user ? (
        <WorkspaceView
          key={user.id}
          logout={logout}
          expired={() => {
            setUser(null);
            setNotice(new RemoteKitError('unauthenticated', '登录已过期'));
          }}
        />
      ) : (
        <RevealScreen>
          {(close) => (
            <AuthView
              close={close}
              notice={notice}
              onLogin={(next) => {
                setNotice(undefined);
                setUser(next);
              }}
            />
          )}
        </RevealScreen>
      )}
    </ThemeProvider>
  );
}
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
import.meta.hot?.dispose(() => root.unmount());
