/// <reference types="vite/client" />
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  Button,
  CircularProgress,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  ThemeProvider,
  Typography,
  createTheme,
} from "@mui/material";
import type {
  ProductState,
  ProductUser,
  ViewerViewport,
} from "../shared/product";
import { ControlConnection, type ConnectionStatus } from "./control-connection";
import { RemoteTransport } from "./transport";
import { selectProductReceiveProfile } from './receive-profile';
import { request } from "./types";
import {
  AuthView,
  PageDialogs,
  SettingsDialog,
  errorMessage,
  type Action,
} from "./product-dialogs";
import { WindowFrame, WindowDivider } from "./window-frame";
import { AdminDialog } from "./admin-dialog";
import "./style.css";
const theme = createTheme({
  palette: {
    primary: { main: "#245DB5" },
    background: { default: "#F2F4F7", paper: "#FFFFFF" },
    text: { primary: "#1F2937", secondary: "#5F6B7A" },
    divider: "#DDE2E8",
  },
  typography: {
    fontFamily: "Segoe UI, Microsoft YaHei, sans-serif",
    fontSize: 14,
  },
  shape: { borderRadius: 8 },
  components: {
    MuiIconButton: { defaultProps: { size: "small" } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiDialog: { defaultProps: { transitionDuration: 150 } },
  },
});
function Workspace({
  logout,
  expired,
}: {
  logout: () => void;
  expired: () => void;
}) {
  const [state, setState] = useState<ProductState | null>(null),
    [status, setStatus] = useState<ConnectionStatus>("connecting"),
    [error, setError] = useState(""),
    [viewportNotice, setViewportNotice] = useState(""),
    [settings, setSettings] = useState(false),
    [admin, setAdmin] = useState(false),
    [, updateMedia] = useState(0),
    [focusAddress, setFocusAddress] = useState<string | null>(null),
    [width, setWidth] = useState(window.innerWidth);
  const transport = useRef<RemoteTransport | null>(null);
  if (!transport.current) transport.current = new RemoteTransport();
  const media = transport.current;
  const connection = useRef<ControlConnection | null>(null),
    geometry = useRef(new Map<string, { width: number; height: number }>()),
    viewportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    latest = useRef(state),
    statusRef = useRef(status),
    generation = useRef<number | undefined>(undefined),
    viewportRequest = useRef(0),
    viewportFailure = useRef("");
  latest.current = state;
  statusRef.current = status;
  const sendViewport = useCallback(() => {
    clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(() => {
      const current = latest.current;
      if (!current || statusRef.current !== "online") return;
      const all =
        current.workspace.layoutMode === "side-by-side" &&
        window.innerWidth >=
          Math.max(720, current.workspace.windows.length * 365 - 5);
      const params: ViewerViewport = {
        devicePixelRatio: window.devicePixelRatio || 1,
        windows: current.workspace.windows.map((w) => ({
          windowId: w.id,
          width:
            geometry.current.get(w.id)?.width ?? Math.max(1, window.innerWidth),
          height:
            geometry.current.get(w.id)?.height ??
            Math.max(1, window.innerHeight - 88),
          visible:
            document.visibilityState !== "hidden" &&
            (all || w.id === current.workspace.activeWindowId),
        })),
      };
      const request = ++viewportRequest.current;
      void connection.current?.request("viewport", params).then(() => {
        if (request !== viewportRequest.current) return;
        viewportFailure.current = ""; setViewportNotice("");
      }).catch((failure) => {
        if (request !== viewportRequest.current || statusRef.current !== "online") return;
        const notice = /minimum DPR|atlas|显示区域|窗口显示区域|resource|budget/i.test(errorMessage(failure))
          ? "当前画面尺寸超出可用范围，已保留原尺寸；请缩小窗口后重试。"
          : "暂时无法更新画面尺寸，请稍后重试。";
        if (viewportFailure.current === notice) return;
        viewportFailure.current = notice; setViewportNotice(notice);
      });
    }, 100);
  }, []);
  const onGeometry = useCallback(
    (id: string, w: number, h: number) => {
      geometry.current.set(id, { width: w, height: h });
      sendViewport();
    },
    [sendViewport],
  );
  useEffect(() => {
    let active = true,
      started = false;
    const socket = new ControlConnection(
      (next) => {
        if (!active) return;
        media.trickleIce = next.viewer.trickleIce === true;
        if (generation.current !== next.endpointGeneration) {
          media.observeEndpointGeneration(next.endpointGeneration);
          generation.current = next.endpointGeneration;
        }
        setState((previous) =>
          !previous || next.workspace.revision >= previous.workspace.revision
            ? next
            : previous,
        );
        if (
          !started ||
          (statusRef.current !== "online" &&
            ["未连接", "连接失败"].includes(media.diagnostics.connection))
        ) {
          started = true;
          void media.connect();
        }
      },
      (next) => {
        if (!active) return;
        setStatus(next);
        if (next === "revoked" || next === "expired") {
          media.disconnect();
          setState(null);
        }
        if (next === "expired") expired();
      },
      signal => media.receiveServerSignal(signal),
    );
    connection.current = socket;
    media.setControlRpc((method, params) =>
      socket.request(method, params as never),
    );
    const unsubscribe = media.subscribe(() => updateMedia((v) => v + 1));
    socket.connect();
    const resize = () => {
      setWidth(window.innerWidth);
      sendViewport();
    };
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", sendViewport);
    return () => {
      active = false;
      viewportRequest.current++;
      clearTimeout(viewportTimer.current);
      media.disconnect();
      socket.close();
      unsubscribe();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", sendViewport);
    };
  }, [media]);
  useEffect(sendViewport, [
    state?.workspace.activeWindowId,
    state?.workspace.windows.length,
    state?.workspace.layoutMode,
    status,
    width,
    sendViewport,
  ]);
  const action: Action = async (command) => {
    const result = await connection.current!.request("action", command);
    setState((previous) =>
      !previous ||
      result.state.workspace.revision >= previous.workspace.revision
        ? result.state
        : previous,
    );
    if (command.type === "window.create")
      setFocusAddress(result.state.workspace.activeWindowId);
    return result;
  };
  const report = (e: unknown) => setError(errorMessage(e));
  const loadRegistration = useCallback(() => connection.current!.request("admin.get", {}), []);
  const saveRegistration = useCallback((serverCredential: string) =>
    connection.current!.request("admin.setRegistrationCredential", { serverCredential }), []);
  if (status === "revoked")
    return (
      <main className="workspace-empty">
        <Typography variant="h6">浏览器已在另一处打开</Typography>
        <Typography color="text.secondary">此处连接已停止。</Typography>
        <Button onClick={() => location.reload()}>在此处继续</Button>
        <Button color="inherit" onClick={logout}>
          退出登录
        </Button>
      </main>
    );
  if (!state)
    return (
      <main className="workspace-empty">
        {status === "failed" ? (
          <>
            <Typography>暂时无法连接</Typography>
            <Button onClick={() => connection.current?.restart()}>重试</Button>
            <Button color="inherit" onClick={logout}>
              退出登录
            </Button>
          </>
        ) : (
          <>
            <CircularProgress size={24} />
            <Typography>正在准备浏览器…</Typography>
          </>
        )}
      </main>
    );
  const workspace = state.workspace,
    sideBySide =
      workspace.layoutMode === "side-by-side" &&
      width >= Math.max(720, workspace.windows.length * 365 - 5),
    windows = workspace.windows,
    pending = workspace.pendingClose;
  return (
    <main className="viewer-shell">
      {status !== "online" && (
        <Alert
          severity="warning"
          action={
            status === "failed" && (
              <Button
                color="inherit"
                size="small"
                onClick={() => connection.current?.restart()}
              >
                重试
              </Button>
            )
          }
        >
          {status === "failed" ? "暂时无法连接" : "正在恢复连接…"}
        </Alert>
      )}
      {(error || viewportNotice || state.endpointError) && (
        <Alert severity="warning" onClose={() => { setError(""); setViewportNotice(""); }}
          sx={!error && (viewportNotice || state.quality.resourceLimitation) ? { position: "absolute", top: 8, left: 12, right: 12, zIndex: 1400 } : undefined}>
          {error || viewportNotice || (state.quality.resourceLimitation ? "当前画面尺寸超出可用范围，请缩小窗口或关闭部分窗口。" : state.endpointError)}
        </Alert>
      )}
      <div className={`window-workspace ${sideBySide ? "side-by-side" : ""}`}>
        {windows.map((w, index) => (
          <React.Fragment key={w.id}>
            {sideBySide && index > 0 && (
              <WindowDivider
                before={windows[index - 1]}
                after={w}
                windows={workspace.windows}
                action={action}
                report={report}
              />
            )}
            <WindowFrame
              win={w}
              state={state}
              transport={media}
              action={action}
              online={status === "online"}
              onSettings={() => setSettings(true)}
              onAdmin={() => setAdmin(true)}
              onLogout={logout}
              report={report}
              onGeometry={onGeometry}
              focusAddress={focusAddress}
              visible={sideBySide || w.id === workspace.activeWindowId}
            />
          </React.Fragment>
        ))}
        {windows.length === 0 && (
          <div className="workspace-empty">
            <Typography variant="h6">开始浏览</Typography>
            <Button
              variant="contained"
              disabled={status !== "online"}
              onClick={() =>
                void action({ type: "window.create" }).catch(report)
              }
            >
              新建窗口
            </Button>
            <Button color="inherit" onClick={logout}>
              退出登录
            </Button>
            {state.user.isAdmin && <Button disabled={status !== "online"} onClick={() => setAdmin(true)}>管理员面板</Button>}
          </div>
        )}
      </div>
      <PageDialogs state={state} action={action} />
      {state.user.isAdmin && <AdminDialog
        open={admin}
        online={status === "online"}
        onClose={() => setAdmin(false)}
        load={loadRegistration}
        save={saveRegistration}
      />}
      <SettingsDialog
        state={state}
        open={settings}
        onClose={() => setSettings(false)}
        action={action}
        logout={logout}
      />
      <Dialog
        open={!!pending && !pending.awaiting}
        onClose={() =>
          pending &&
          void action({
            type: "tab.close",
            tabId: pending.id,
            requestId: pending.requestId,
            cancel: true,
          }).catch(report)
        }
      >
        <DialogTitle>离开此页面？</DialogTitle>
        <DialogContent>此页面可能有未保存的内容。</DialogContent>
        <DialogActions>
          <Button
            autoFocus
            onClick={() =>
              pending &&
              void action({
                type: "tab.close",
                tabId: pending.id,
                requestId: pending.requestId,
                cancel: true,
              }).catch(report)
            }
          >
            保留页面
          </Button>
          <Button
            onClick={() =>
              pending &&
              void action({
                type: "tab.close",
                tabId: pending.id,
                requestId: pending.requestId,
                confirm: true,
              }).catch(report)
            }
          >
            离开
          </Button>
        </DialogActions>
      </Dialog>
    </main>
  );
}
function App() {
  const [user, setUser] = useState<ProductUser | null | undefined>(undefined),
    [notice, setNotice] = useState("");
  useEffect(() => {
    void selectProductReceiveProfile(navigator.userAgent, RTCRtpReceiver.getCapabilities?.('video')?.codecs);
    try {
      localStorage.removeItem("remotekit.receive-profile");
    } catch {}
    void request<{ user: ProductUser }>("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);
  const logout = () => {
    setUser(null);
    void request("/api/auth/logout", {}).catch((e) =>
      setNotice(errorMessage(e)),
    );
  };
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {notice && (
        <Alert severity="warning" onClose={() => setNotice("")}>
          {notice}
        </Alert>
      )}
      {user === undefined ? (
        <div className="workspace-empty">
          <CircularProgress size={24} />
        </div>
      ) : user ? (
        <Workspace
          key={user.id}
          logout={logout}
          expired={() => {
            setUser(null);
            setNotice("登录已过期，请重新登录");
          }}
        />
      ) : (
        <AuthView
          onLogin={(next) => {
            setNotice("");
            setUser(next);
          }}
        />
      )}
    </ThemeProvider>
  );
}
if (location.pathname === "/automation" || location.pathname === "/diagnostics")
  void import("./automation-entry").then((m) =>
    m.mountAutomation(document.getElementById("root")!, {
      diagnostics: location.pathname === "/diagnostics",
    }),
  );
else {
  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);
  import.meta.hot?.dispose(() => root.unmount());
}
