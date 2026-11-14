/// <reference types="vite/client" />
import { CssBaseline, ThemeProvider } from '@mui/material';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteKitError } from '../shared/errors';
import { AuthView } from './app/product-dialogs';
import { WorkspaceView } from './app/workspace-view';
import { BlankScreen, RevealScreen } from './auth/lock-screen';
import { SurfaceState } from './failures';
import { useIdentitySession } from './auth/identity-session';
import { selectProductReceiveProfile } from './media/receive-profile';
import { LocalSelection } from './selection/local-selection';
import { useViewerTheme } from './theme/theme';
import './style.css';
import './theme/mui.css';
import './theme/tokens.css';
// Automation hooks exist only in dev builds; Vite drops this branch from production.
if (import.meta.env.DEV) void import('./test-hooks');
function App() {
  const theme = useViewerTheme();
  const { user, setUser, notice, setNotice, connectionError, logout } = useIdentitySession();
  useEffect(() => {
    void selectProductReceiveProfile(RTCRtpReceiver.getCapabilities?.('video')?.codecs);
  }, []);
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
