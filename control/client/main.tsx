/// <reference types="vite/client" />
import { projectOperations, snapshotNewer, requireAcceptedReceipt, type PendingOperation, operationId } from './product-operations';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  Button,
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
  OperationReceipt,
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
import { FileChooserDialog } from './file-chooser-dialog';
import { FileLibraryContext, type LibraryRequest, useFileLibrary } from './file-library-state';
import { foregroundRequest } from './foreground-request';
import type { AudioChannels } from './audio-output';
import type { AuthState } from '../shared/security';
import { BlankScreen, RevealScreen } from './lock-screen';
import { UnlockView } from './unlock-view';
import { SecuritySettings } from './security-settings';
import { useAuthCamera, type AuthRequest } from './auth-camera';
import { useAutoLock } from './auth-idle';
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
  const [authoritative, setState] = useState<ProductState | null>(null),
    [status, setStatus] = useState<ConnectionStatus>("connecting"),
    [error, setError] = useState(""),
    [viewportNotice, setViewportNotice] = useState(""),
    [settings, setSettings] = useState(false),
    [admin, setAdmin] = useState(false),
    [audioSaving, setAudioSaving] = useState(false),
    [audioError, setAudioError] = useState(''),
    [, updateMedia] = useState(0),
    [focusAddress, setFocusAddress] = useState<string | null>(null),
    [width, setWidth] = useState(window.innerWidth);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [localLock, setLocalLock] = useState<string | null>(null);
  const [manualLock, setManualLock] = useState(false);
  const localLockRef = useRef<string | null>(null);
  const authRef = useRef<AuthState | null>(null);
  const [pendingOperations,setPendingOperations]=useState<PendingOperation[]>([]);
  const state=projectOperations(authoritative,pendingOperations);
  const shell = useRef<HTMLElement>(null);
  const showShell = !!state && !localLock && auth?.locked === false;
  useLayoutEffect(() => {
    const node = shell.current;
    if (!showShell || !node) return;
    const viewport = window.visualViewport;
    const position = () => {
      node.style.left = `${viewport?.offsetLeft ?? 0}px`;
      node.style.top = `${viewport?.offsetTop ?? 0}px`;
    };
    const size = () => {
      const width = viewport?.width ?? window.innerWidth;
      node.style.width = `${width}px`;
      node.style.height = `${viewport?.height ?? window.innerHeight}px`;
      setWidth(width);
      position();
    };
    size();
    viewport?.addEventListener("resize", size);
    viewport?.addEventListener("scroll", position);
    window.addEventListener("resize", size);
    return () => {
      viewport?.removeEventListener("resize", size);
      viewport?.removeEventListener("scroll", position);
      window.removeEventListener("resize", size);
    };
  }, [showShell]);
  const transport = useRef<RemoteTransport | null>(null);
  const audioPending = useRef(false);
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
  const authRequest: AuthRequest = useCallback((method, params) =>
    connection.current!.request(method, params), []);
  const clearWorkspace = useCallback(() => {
    media.setProductLocked(true);
    media.setAuthCamera();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    latest.current = null;
    viewportRequest.current++;
    clearTimeout(viewportTimer.current);
    viewportFailure.current = '';
    geometry.current.clear();
    setState(null);
    setPendingOperations([]);
    setError('');
    setViewportNotice('');
    setSettings(false);
    setAdmin(false);
    setFocusAddress(null);
    setAudioError('');
  }, [media]);
  const lock = useCallback((reason: string) => {
    if (!authRef.current || authRef.current.locked || localLockRef.current) return;
    localLockRef.current = reason;
    setLocalLock(reason);
    if (reason === 'manual') setManualLock(true);
    clearWorkspace();
    void authRequest('auth.lock', { reason }).catch(() => connection.current?.reconnect());
  }, [authRequest, clearWorkspace]);
  const idle = useAutoLock(auth, lock);
  const idleSystem = useRef(idle.system);
  idleSystem.current = idle.system;
  const [idleRearmed, setIdleRearmed] = useState(true);
  useEffect(() => {
    if (localLock === 'idle' && !idle.system) setIdleRearmed(false);
  }, [idle.system, localLock]);
  useEffect(() => {
    if (idleRearmed) return;
    const activity = () => setIdleRearmed(true);
    window.addEventListener('pointerdown', activity, true);
    window.addEventListener('keydown', activity, true);
    return () => {
      window.removeEventListener('pointerdown', activity, true);
      window.removeEventListener('keydown', activity, true);
    };
  }, [idleRearmed]);
  const onDepartureObserved = useCallback(() => setManualLock(false), []);
  const camera = useAuthCamera(media, authRequest, localLock ? null : auth, status === 'online', manualLock,
    !idle.blocked && idleRearmed && localLock !== 'idle' && localLock !== 'system', onDepartureObserved);
  const sendViewport = useCallback(() => {
    clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(() => {
      const current = latest.current;
      if (!current || authRef.current?.locked !== false || localLockRef.current || statusRef.current !== "online") return;
      const bounds = shell.current?.getBoundingClientRect();
      const width = bounds?.width ?? window.innerWidth;
      const all =
        current.workspace.layoutMode === "side-by-side" &&
        width >=
          Math.max(720, current.workspace.windows.length * 365 - 5);
      const params: ViewerViewport = {
        devicePixelRatio: window.devicePixelRatio || 1,
        windows: current.workspace.windows.map((w) => ({
          windowId: w.id,
          width:
            geometry.current.get(w.id)?.width ?? Math.max(1, Math.round(width)),
          height:
            geometry.current.get(w.id)?.height ??
            Math.max(1, Math.round(bounds?.height ?? window.innerHeight) - 88),
          visible:
            document.visibilityState !== "hidden" &&
            current.workspace.tabs.some(t => t.id === w.activeTabId && t.kind !== 'start' && t.kind !== 'files') &&
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
      const previous = geometry.current.get(id);
      if (previous?.width === w && previous.height === h) return;
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
        if (!active || authRef.current?.locked !== false || localLockRef.current) return;
        setPendingOperations(entries=>entries.map(entry=>{const receipt=next.operationReceipts?.find(receipt=>receipt.operationId===entry.operationId && receipt.operationGeneration===entry.operationGeneration);return receipt?{...entry,receipt}:entry;}));
        latest.current = next;
        if (authRef.current.peerEpoch > 0) media.setProductLocked(false);
        setState((previous) =>
          snapshotNewer(next,previous)
            ? next
            : previous,
        );
      },
      (next) => {
        if (!active) return;
        const previous = statusRef.current;
        statusRef.current = next;
        setStatus(next);
        if (next !== 'online' && previous === 'online') {
          authRef.current = null;
          setAuth(null);
          clearWorkspace();
          started = false;
          media.disconnect();
        }
        if (next === "revoked" || next === "expired") {
          media.disconnect();
          setState(null);
        }
        if (next === "expired") expired();
      },
      signal => media.receiveServerSignal(signal),
      (next) => {
        if (!active) return;
        const previous = authRef.current;
        if (previous && next.epoch < previous.epoch) return;
        if (!next.locked && localLockRef.current) return;
        if (next.locked && (!previous?.locked || next.epoch !== previous.epoch)) clearWorkspace();
        if (next.locked) {
          if (localLockRef.current === 'idle' && !idleSystem.current) setIdleRearmed(false);
          localLockRef.current = null;
          setLocalLock(null);
        } else {
          setManualLock(false);
          setIdleRearmed(true);
        }
        authRef.current = next;
        setAuth(next);
        media.observePeerAuthorization(next.peerEpoch);
        if (!next.locked && next.peerEpoch > 0 && latest.current) media.setProductLocked(false);
        media.trickleIce = next.trickleIce;
        if (generation.current !== next.endpointGeneration) {
          media.observeEndpointGeneration(next.endpointGeneration);
          generation.current = next.endpointGeneration;
        }
        if (!started) {
          started = true;
          void media.connect();
        }
      },
    );
    connection.current = socket;
    media.setControlRpc((method, params) =>
      socket.request(method, params as never),
    );
    const unsubscribe = media.subscribe(() => updateMedia((v) => v + 1));
    socket.connect();
    window.addEventListener("resize", sendViewport);
    document.addEventListener("visibilitychange", sendViewport);
    return () => {
      active = false;
      viewportRequest.current++;
      clearTimeout(viewportTimer.current);
      media.disconnect();
      socket.close();
      unsubscribe();
      window.removeEventListener("resize", sendViewport);
      document.removeEventListener("visibilitychange", sendViewport);
    };
  }, [clearWorkspace, media]);
  useEffect(sendViewport, [
    state?.workspace.revision,
    state?.workspace.activeWindowId,
    state?.workspace.windows.length,
    state?.workspace.layoutMode,
    status,
    width,
    sendViewport,
  ]);
  useEffect(()=>{if(authoritative)setPendingOperations(entries=>{const remaining=entries.filter(entry=>!entry.receipt || (['accepted','applying','unknown'].includes(entry.receipt.status) && !entry.receipt.resolved) || entry.receipt.status==='committed' && (entry.receipt.revision??Infinity)>authoritative.workspace.revision);return remaining.length===entries.length?entries:remaining;});},[authoritative,pendingOperations]);
  useEffect(()=>{const timer=setInterval(()=>{for(const entry of pendingOperations.filter(entry=>!entry.receipt || ['applying','accepted','unknown'].includes(entry.receipt.status) && !entry.receipt.resolved))void connection.current?.request('operation.status',{operationId:entry.operationId,operationGeneration:entry.operationGeneration}).then(receipt=>{if(['rejected','expired'].includes(receipt.status))setError(receipt.error??'操作未完成，请核对当前工作区');setPendingOperations(entries=>entries.map(item=>item.operationId===entry.operationId?{...item,receipt}:item));}).catch(()=>{});},2000);return()=>clearInterval(timer);},[pendingOperations]);
  useEffect(()=>{const retired=pendingOperations.find(entry=>entry.receipt?.resolved && entry.receipt.status==='unknown');if(retired)setError(retired.receipt?.error??'原页面已结束，操作执行结果未知');},[pendingOperations]);
  const action: Action = async (command) => {
    const source=latest.current;if(!source?.operationGeneration || authRef.current?.locked !== false || localLockRef.current)throw new Error('正在同步产品状态');
    if (statusRef.current !== 'online' || !media.productReady) throw new Error('正在连接浏览器，请稍后重试。');
    if(Object.values(command).some(value=>typeof value==='string'&&value.startsWith('pending-')))throw new Error('此操作正在等待确认');
    if(pendingOperations.length>=64)throw new Error('待确认操作过多，请等待同步');
    const operation:PendingOperation={operationId:operationId(),operationGeneration:source.operationGeneration,action:command};
    setPendingOperations(entries=>[...entries,operation]);
    let receipt: OperationReceipt;
    try {receipt=await media.productAction(operation);} catch (failure) {
      if((failure as {operationSent?:boolean}).operationSent===false){setPendingOperations(entries=>entries.filter(entry=>entry.operationId!==operation.operationId));throw failure;}
      if (!latest.current || authRef.current?.locked !== false || localLockRef.current) throw failure;
      try {receipt=await connection.current!.request('operation.status',{operationId:operation.operationId,operationGeneration:operation.operationGeneration});}
      catch {receipt={operationId:operation.operationId,operationGeneration:operation.operationGeneration,status:'unknown' as const,error:'操作结果未知，请等待连接恢复后核对工作区'};}
    }
    setPendingOperations(entries=>entries.map(entry=>entry.operationId===operation.operationId?{...entry,receipt}:entry));
    return requireAcceptedReceipt(receipt);
  };
  const report = (e: unknown) => {
    if (authRef.current?.locked === false && authRef.current.epoch === auth?.epoch && !localLockRef.current) setError(errorMessage(e));
  };
  const saveAudio = (channels:AudioChannels) => {
    if(audioPending.current || statusRef.current!=='online' || !media.productReady)return;
    audioPending.current=true;setAudioSaving(true);setAudioError('');
    void action({type:'settings.update',settings:{audioChannels:channels}})
      .catch(() => { if (authRef.current?.locked === false && authRef.current.epoch === auth?.epoch && !localLockRef.current) setAudioError('声音设置未保存，请重试'); })
      .finally(()=>{audioPending.current=false;setAudioSaving(false);});
  };
  useEffect(()=>{if(state)media.audio.setChannels(state.workspace.settings.audioChannels);},[state?.workspace.settings.audioChannels,media]);
  const loadRegistration = useCallback(() => connection.current!.request("admin.get", {}), []);
  const saveRegistration = useCallback((serverCredential: string) =>
    connection.current!.request("admin.setRegistrationCredential", { serverCredential }), []);
  const productReady = status === 'online' && media.productReady;
  const libraryRequest: LibraryRequest = useCallback((method, params) => connection.current!.request(method, params), []);
  const library = useFileLibrary(libraryRequest, media.files, productReady, showShell, auth?.user.id, state?.fileRequests.map(request => request.id) ?? []);
  if (localLock || auth?.locked !== false) return <RevealScreen key={`${auth?.epoch ?? 'connecting'}:${localLock ?? ''}`}>
    {close => <UnlockView auth={localLock ? null : auth} request={authRequest} camera={camera} close={close}
      retry={() => status === 'revoked' ? location.reload() : connection.current?.restart()} />}
  </RevealScreen>;
  if (!state) return <BlankScreen />;

  const workspace = state.workspace,
    sideBySide =
      workspace.layoutMode === "side-by-side" &&
      width >= Math.max(720, workspace.windows.length * 365 - 5),
    windows = workspace.windows,
    pending = workspace.pendingClose;
  const foreground = !settings && !admin && !(pending && !pending.awaiting) ? foregroundRequest(state,width) : null;
  const fileRequest = foreground?.kind==='file' ? state.fileRequests.find(request=>request.id===foreground.id) : undefined;
  return (
    <FileLibraryContext.Provider value={library}><main className="viewer-shell" ref={shell}>
      {pendingOperations.length>0 && <Alert severity="info" sx={{position:'absolute',top:88,left:'50%',transform:'translateX(-50%)',zIndex:1190}} action={pendingOperations.some(entry=>entry.receipt?.status==='unknown')?<Button onClick={()=>setPendingOperations(entries=>entries.filter(entry=>entry.receipt?.status!=='unknown'))}>以当前工作区为准</Button>:undefined}>{pendingOperations.length} 个操作{pendingOperations.some(entry=>entry.receipt?.status==='unknown')?'结果未知，请核对工作区':'正在同步'}{media.diagnostics.channel!=='已连接'?'，等待数据通道连接':''}</Alert>}
      {productReady && media.audio.state === 'blocked' && (workspace.settings.audioChannels?.left !== false || workspace.settings.audioChannels?.right !== false) && <Button variant="contained" onClick={() => media.audio.resume()} sx={{ position: 'absolute', top: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 1200 }}>点击开启声音</Button>}
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
      {status === 'online' && !productReady && (
        <Alert severity={media.diagnostics.connection === '连接失败' ? 'warning' : 'info'}
          action={media.diagnostics.connection === '连接失败' &&
            <Button color="inherit" size="small" onClick={() => void media.connect()}>重试</Button>}>
          {media.diagnostics.connection === '连接失败' ? '浏览器连接失败' : '正在连接浏览器…'}
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
                online={productReady}
                action={action}
                report={report}
              />
            )}
            <WindowFrame
              win={w}
              state={state}
              transport={media}
              action={action}
              online={productReady}
              onSettings={() => setSettings(true)}
              onAdmin={() => setAdmin(true)}
              onLogout={logout}
              report={report}
              onGeometry={onGeometry}
              focusAddress={focusAddress}
              visible={sideBySide || w.id === workspace.activeWindowId}
              audioSaving={audioSaving} audioError={audioError} saveAudio={saveAudio}
            />
          </React.Fragment>
        ))}
        {windows.length === 0 && (
          <div className="workspace-empty">
            <Typography variant="h6">开始浏览</Typography>
            <Button
              variant="contained"
              disabled={!productReady}
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
      {productReady && <PageDialogs state={state} action={action} activeId={foreground?.kind==='page'?foreground.id:null} />}
      {fileRequest && <FileChooserDialog key={fileRequest.id} request={fileRequest} transport={media}
        viewId={workspace.tabs.find(tab => tab.id === fileRequest.tabId)?.webviewId} />}
      {state.user.isAdmin && <AdminDialog
        open={admin}
        online={status === "online"}
        onClose={() => setAdmin(false)}
        load={loadRegistration}
        save={saveRegistration}
      />}
      <SettingsDialog
        online={productReady}
        state={state}
        open={settings}
        onClose={() => setSettings(false)}
        action={action}
        logout={logout}
        security={settings && <SecuritySettings auth={auth} online={status === 'online'} request={authRequest}
          camera={camera} idle={idle} lock={() => lock('manual')} />}
      />
      <Dialog
        open={productReady && !!pending && !pending.awaiting}
        onClose={() =>
          productReady && pending &&
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
    </main></FileLibraryContext.Provider>
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
      {user === undefined ? (
        <BlankScreen />
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
        <RevealScreen>{close => <AuthView close={close} notice={notice}
          onLogin={(next) => {
            setNotice("");
            setUser(next);
          }}
        />}</RevealScreen>
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
