/// <reference types="vite/client" />
import { projectOperations, snapshotNewer, requireAcceptedReceipt, type PendingOperation, operationId } from './product-operations';
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
import { foregroundRequest } from './foreground-request';
import type { AudioChannels } from './audio-output';
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
  const [pendingOperations,setPendingOperations]=useState<PendingOperation[]>([]);
  const state=projectOperations(authoritative,pendingOperations);
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
  latest.current = authoritative;
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
            current.workspace.tabs.some(t => t.id === w.activeTabId && t.kind !== 'start') &&
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
        setPendingOperations(entries=>entries.map(entry=>{const receipt=next.operationReceipts?.find(receipt=>receipt.operationId===entry.operationId && receipt.operationGeneration===entry.operationGeneration);return receipt?{...entry,receipt}:entry;}));
        media.trickleIce = next.viewer.trickleIce === true;
        if (generation.current !== next.endpointGeneration) {
          media.observeEndpointGeneration(next.endpointGeneration);
          generation.current = next.endpointGeneration;
        }
        setState((previous) =>
          snapshotNewer(next,previous)
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
    const source=latest.current;if(!source?.operationGeneration)throw new Error('正在同步产品状态');
    if(Object.values(command).some(value=>typeof value==='string'&&value.startsWith('pending-')))throw new Error('此操作正在等待确认');
    if(pendingOperations.length>=64)throw new Error('待确认操作过多，请等待同步');
    const operation:PendingOperation={operationId:operationId(),operationGeneration:source.operationGeneration,action:command};
    setPendingOperations(entries=>[...entries,operation]);
    let receipt: OperationReceipt;
    try {receipt=await media.productAction(operation);} catch (failure) {
      if((failure as {operationSent?:boolean}).operationSent===false){setPendingOperations(entries=>entries.filter(entry=>entry.operationId!==operation.operationId));throw failure;}
      try {receipt=await connection.current!.request('operation.status',{operationId:operation.operationId,operationGeneration:operation.operationGeneration});}
      catch {receipt={operationId:operation.operationId,operationGeneration:operation.operationGeneration,status:'unknown' as const,error:'操作结果未知，请等待连接恢复后核对工作区'};}
    }
    setPendingOperations(entries=>entries.map(entry=>entry.operationId===operation.operationId?{...entry,receipt}:entry));
    return requireAcceptedReceipt(receipt);
  };
  const report = (e: unknown) => setError(errorMessage(e));
  const saveAudio = (channels:AudioChannels) => {
    if(audioPending.current || statusRef.current!=='online')return;
    audioPending.current=true;setAudioSaving(true);setAudioError('');
    void action({type:'settings.update',settings:{audioChannels:channels}}).catch(()=>setAudioError('声音设置未保存，请重试')).finally(()=>{audioPending.current=false;setAudioSaving(false);});
  };
  useEffect(()=>{if(state)media.audio.setChannels(state.workspace.settings.audioChannels);},[state?.workspace.settings.audioChannels,media]);
  const loadRegistration = useCallback(() => connection.current!.request("admin.get", {}), []);
  const saveRegistration = useCallback((serverCredential: string) =>
    connection.current!.request("admin.setRegistrationCredential", { serverCredential }), []);
  const fileRpc = media.files;
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
  const foreground = !settings && !admin && !(pending && !pending.awaiting) ? foregroundRequest(state,width) : null;
  const fileRequest = foreground?.kind==='file' ? state.fileRequests.find(request=>request.id===foreground.id) : undefined;
  return (
    <main className="viewer-shell">
      {pendingOperations.length>0 && <Alert severity="info" sx={{position:'absolute',top:88,left:'50%',transform:'translateX(-50%)',zIndex:1190}} action={pendingOperations.some(entry=>entry.receipt?.status==='unknown')?<Button onClick={()=>setPendingOperations(entries=>entries.filter(entry=>entry.receipt?.status!=='unknown'))}>以当前工作区为准</Button>:undefined}>{pendingOperations.length} 个操作{pendingOperations.some(entry=>entry.receipt?.status==='unknown')?'结果未知，请核对工作区':'正在同步'}{media.diagnostics.channel!=='已连接'?'，等待数据通道连接':''}</Alert>}
      {media.audio.state === 'blocked' && (workspace.settings.audioChannels?.left !== false || workspace.settings.audioChannels?.right !== false) && <Button variant="contained" onClick={() => media.audio.resume()} sx={{ position: 'absolute', top: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 1200 }}>点击开启声音</Button>}
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
              audioSaving={audioSaving} audioError={audioError} saveAudio={saveAudio}
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
      <PageDialogs state={state} action={action} activeId={foreground?.kind==='page'?foreground.id:null} />
      {fileRequest && <FileChooserDialog key={fileRequest.id} request={fileRequest} online={status==='online'} rpc={fileRpc} />}
      {state.user.isAdmin && <AdminDialog
        open={admin}
        online={status === "online"}
        onClose={() => setAdmin(false)}
        load={loadRegistration}
        save={saveRegistration}
      />}
      <SettingsDialog
        online={status === "online"}
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
