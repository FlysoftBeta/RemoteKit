/// <reference types="vite/client" />
import './theme/tokens.css';
import './theme/mui.css';
import { WorkspaceView } from './app/workspace-view';
import { formatError } from './util/format-error';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProductUser } from '../shared/product';
import { BlankScreen, RevealScreen } from './auth/lock-screen';
import { selectProductReceiveProfile } from './media/receive-profile';
import { AuthView } from './app/product-dialogs';
import './style.css';
import { request } from './control/http-request';
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
    [notice, setNotice] = useState('');
  useEffect(() => {
    void selectProductReceiveProfile(RTCRtpReceiver.getCapabilities?.('video')?.codecs);

    void request<{ user: ProductUser }>('/api/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);
  const logout = () => {
    setUser(null);
    void request('/api/auth/logout', {}).catch((e) => setNotice(formatError(e)));
  };
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {user === undefined ? (
        <BlankScreen />
      ) : user ? (
        <WorkspaceView
          key={user.id}
          logout={logout}
          expired={() => {
            setUser(null);
            setNotice('登录已过期，请重新登录');
          }}
        />
      ) : (
        <RevealScreen>
          {(close) => (
            <AuthView
              close={close}
              notice={notice}
              onLogin={(next) => {
                setNotice('');
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
