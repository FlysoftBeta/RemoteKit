/// <reference types="vite/client" />
import { WorkspaceView } from './app/workspace-view';
import { formatError } from './format-error';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ProductUser } from '../shared/product';
import { BlankScreen, RevealScreen } from './lock-screen';
import { selectProductReceiveProfile } from './media/receive-profile';
import { AuthView } from './product-dialogs';
import './style.css';
import { request } from './types';
const theme = createTheme({
  palette: {
    primary: { main: '#245DB5' },
    background: { default: '#F2F4F7', paper: '#FFFFFF' },
    text: { primary: '#1F2937', secondary: '#5F6B7A' },
    divider: '#DDE2E8',
  },
  typography: {
    fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
    fontSize: 14,
  },
  shape: { borderRadius: 8 },
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
    void selectProductReceiveProfile(navigator.userAgent, RTCRtpReceiver.getCapabilities?.('video')?.codecs);

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
