import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Divider,
  IconButton,
  InputBase,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Add,
  ArrowBack,
  ArrowForward,
  Close,
  Language,
  MoreVert,
  Refresh,
  Stop,
  ViewColumn,
  Tab as TabIcon,
  Check,
  OpenInNew,
  BedtimeOutlined,
} from "@mui/icons-material";
import type {
  ProductState,
  ProductTab,
  ProductWindow,
} from "../shared/product";
import { RemoteTransport } from "./transport";
import { RemoteViewport } from "./remote-viewport";
import type { Action } from "./product-dialogs";
export function Tool({
  title,
  children,
  onClick,
  disabled,
  className,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip title={title}>
      <span className="tool-wrap">
        <IconButton
          className={className}
          aria-label={title}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}
export function WindowFrame({
  win,
  state,
  transport,
  action,
  online,
  onSettings,
  onLogout,
  report,
  onGeometry,
  focusAddress,
  visible,
}: {
  win: ProductWindow;
  state: ProductState;
  transport: RemoteTransport;
  action: Action;
  online: boolean;
  onSettings: () => void;
  onLogout: () => void;
  report: (error: unknown) => void;
  onGeometry: (id: string, width: number, height: number) => void;
  focusAddress: string | null;
  visible: boolean;
}) {
  const tabs = state.workspace.tabs.filter((t) => t.windowId === win.id),
    active = tabs.find((t) => t.id === win.activeTabId),
    focused = state.workspace.activeWindowId === win.id;
  const [address, setAddress] = useState(active?.url ?? ""),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState<HTMLElement | null>(null),
    [switcher, setSwitcher] = useState<HTMLElement | null>(null),
    [tabMenu, setTabMenu] = useState<{
      anchor: HTMLElement;
      tab: ProductTab;
    } | null>(null),
    [siteBusy, setSiteBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    content = useRef<HTMLDivElement>(null),
    strip = useRef<HTMLDivElement>(null);
  const addressDirty = useRef(false),
    previousTab = useRef(active?.id);
  const run = (command: Parameters<Action>[0]) => {
    if (!online) return;
    setBusy(true);
    void action(command)
      .catch(report)
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (previousTab.current !== active?.id) addressDirty.current = false;
    previousTab.current = active?.id;
    if (!addressDirty.current)
      setAddress(active?.pendingUrl ?? active?.url ?? "");
  }, [active?.id, active?.url, active?.pendingUrl]);
  useEffect(() => {
    if (focusAddress === win.id) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusAddress]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        focused &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "l"
      ) {
        event.preventDefault();
        event.stopPropagation();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [focused]);
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (active?.url === "about:blank") input.current?.focus();
  }, [active?.id]);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      onGeometry(
        win.id,
        Math.max(1, Math.round(rect.width)),
        Math.max(1, Math.round(rect.height)),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.visualViewport?.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [win.id, onGeometry]);
  let origin = "";
  try {
    const parsed = new URL(active?.url ?? "");
    if (parsed.protocol === "http:" || parsed.protocol === "https:")
      origin = parsed.origin;
  } catch {}
  const activate = () => {
    if (!focused && online)
      void action({ type: "window.activate", windowId: win.id }).catch(report);
  };
  const navigate = () => {
    if (!address.trim()) return;
    addressDirty.current = false;
    if (active)
      run({ type: "tab.navigate", tabId: active.id, url: address.trim() });
    else run({ type: "tab.create", windowId: win.id, url: address.trim() });
  };
  return (
    <section
      className={`window-frame ${focused ? "focused-window" : ""}`}
      style={{ flexGrow: win.weight, display: visible ? undefined : "none" }}
      aria-label={`浏览器窗口 ${state.workspace.windows.indexOf(win) + 1}`}
      onPointerDownCapture={activate}
    >
      <div className="tab-bar">
        <div
          className="tab-strip"
          role="tablist"
          aria-label="标签页"
          ref={strip}
        >
          {tabs.map((tab, index) => (
            <div
              className={`browser-tab ${active?.id === tab.id ? "selected-tab" : ""}`}
              key={tab.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ anchor: e.currentTarget, tab });
              }}
            >
              <button
                type="button"
                className="tab-select"
                role="tab"
                tabIndex={active?.id === tab.id ? 0 : -1}
                aria-selected={active?.id === tab.id}
                onClick={() => run({ type: "tab.activate", tabId: tab.id })}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    const next =
                      (index +
                        (e.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
                    (
                      strip.current?.querySelectorAll(".tab-select")[
                        next
                      ] as HTMLElement
                    )?.focus();
                  }
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    run({ type: "tab.activate", tabId: tab.id });
                  }
                }}
              >
                {tab.loading ? (
                  <CircularProgress size={13} />
                ) : tab.residency && tab.residency !== "live" ? (
                  <BedtimeOutlined fontSize="inherit" />
                ) : (
                  <Language fontSize="inherit" />
                )}
                <span>{tab.title || "新标签页"}{state.pageDialogs?.some(d => d.tabId === tab.id) && <span aria-label="页面等待处理对话框"> ●</span>}</span>
              </button>
              <IconButton
                className="tab-close"
                size="small"
                aria-label={`关闭 ${tab.title || "标签页"}`}
                disabled={!online}
                onClick={() => run({ type: "tab.close", tabId: tab.id })}
              >
                <Close fontSize="inherit" />
              </IconButton>
            </div>
          ))}
        </div>
        <Tool
          title="新建标签页"
          disabled={!online || busy}
          onClick={() => run({ type: "tab.create", windowId: win.id })}
        >
          <Add fontSize="small" />
        </Tool>
        <Tool
          title={`切换窗口，共 ${state.workspace.windows.length} 个`}
          onClick={(e) => setSwitcher(e.currentTarget)}
        >
          <ViewColumn fontSize="small" />
        </Tool>
        <Tool
          title="标签页操作"
          disabled={!active}
          onClick={(e) =>
            active && setTabMenu({ anchor: e.currentTarget, tab: active })
          }
        >
          <TabIcon fontSize="small" />
        </Tool>
      </div>
      <div className="navigation-bar">
        <Tool
          title="后退"
          disabled={!online || !active || !active.canGoBack}
          onClick={() =>
            active &&
            run({ type: "tab.command", tabId: active.id, command: "back" })
          }
        >
          <ArrowBack fontSize="small" />
        </Tool>
        <Tool
          title="前进"
          className="forward-button"
          disabled={!online || !active || !active.canGoForward}
          onClick={() =>
            active &&
            run({ type: "tab.command", tabId: active.id, command: "forward" })
          }
        >
          <ArrowForward fontSize="small" />
        </Tool>
        <Tool
          title={active?.loading ? "停止加载" : "刷新"}
          disabled={!online || !active}
          onClick={() =>
            active &&
            run({
              type: "tab.command",
              tabId: active.id,
              command: active.loading ? "stop" : "reload",
            })
          }
        >
          {active?.loading ? (
            <Stop fontSize="small" />
          ) : (
            <Refresh fontSize="small" />
          )}
        </Tool>
        <Box
          component="form"
          className="address-form"
          onSubmit={(e) => {
            e.preventDefault();
            navigate();
            input.current?.blur();
          }}
        >
          <Language fontSize="small" />
          <InputBase
            inputRef={input}
            fullWidth
            placeholder="输入网址"
            inputProps={{
              "aria-label": "网址",
              autoComplete: "off",
              spellCheck: false,
            }}
            value={address}
            disabled={!online}
            onChange={(e) => {
              addressDirty.current = true;
              setAddress(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                addressDirty.current = false;
                setAddress(active?.url ?? "");
                input.current?.blur();
              }
            }}
          />
        </Box>
        <Tool title="更多" onClick={(e) => setMenu(e.currentTarget)}>
          <MoreVert fontSize="small" />
        </Tool>
      </div>
      <div className="window-content" ref={content}>
        {active ? (
          <>
            <RemoteViewport
              key={active.id}
              transport={transport}
              viewId={active.webviewId}
              overlay={state.workspace.settings.showStats ?? false}
              onFocus={activate}
            />
            {active.popup?.status === "pending" ? (
              <div className="page-overlay" role="status">
                正在创建页面…
              </div>
            ) : active.popup?.status === "failed" ? (
              <div className="page-overlay" role="alert">
                {active.popup.error || "未能打开此页面"}
              </div>
            ) : (
              (active.restoring ||
                (active.residency && active.residency !== "live")) && (
                <div className="page-overlay" role="status">
                  正在恢复页面…
                </div>
              )
            )}
          </>
        ) : (
          <div className="workspace-empty">
            <Typography variant="h6">打开一个网页</Typography>
            <Button
              disabled={!online || busy}
              onClick={() => run({ type: "tab.create", windowId: win.id })}
            >
              新建标签页
            </Button>
          </div>
        )}
      </div>
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          disabled={!online}
          onClick={() => {
            setMenu(null);
            run({ type: "tab.create", windowId: win.id });
          }}
        >
          新建标签页
        </MenuItem>
        <MenuItem
          disabled={!online}
          onClick={() => {
            setMenu(null);
            run({ type: "window.create" });
          }}
        >
          新建窗口
        </MenuItem>
        <MenuItem
          disabled={!online || !active?.canGoForward}
          onClick={() => {
            setMenu(null);
            active &&
              run({
                type: "tab.command",
                tabId: active.id,
                command: "forward",
              });
          }}
        >
          前进
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={!online}
          onClick={() => {
            setMenu(null);
            run({
              type: "window.layout",
              mode:
                state.workspace.layoutMode === "focused"
                  ? "side-by-side"
                  : "focused",
            });
          }}
        >
          {state.workspace.layoutMode === "focused"
            ? "并排显示"
            : "只显示此窗口"}
        </MenuItem>
        <MenuItem
          disabled={!online}
          onClick={() => {
            setMenu(null);
            run({ type: "window.close", windowId: win.id });
          }}
        >
          关闭此窗口
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={
            !online || !origin || siteBusy || !state.integrations.siteUa
          }
          onClick={() => {
            setSiteBusy(true);
            void action({
              type: "site.set",
              origin,
              tabletUa: !state.workspace.sites[origin]?.tabletUa,
              tabId: active?.id,
            })
              .then((result) => {
                if ((result as { application?: unknown }).application)
                  report(new Error("设置已保存，下次加载生效"));
              })
              .catch(report)
              .finally(() => setSiteBusy(false));
          }}
        >
          <Checkbox
            size="small"
            checked={!!state.workspace.sites[origin]?.tabletUa}
            tabIndex={-1}
            disableRipple
          />
          <div>
            <Typography>使用平板版网站</Typography>
            <Typography variant="caption" color="text.secondary">
              {origin || "打开网站后可设置"}
            </Typography>
          </div>
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            setMenu(null);
            onSettings();
          }}
        >
          设置
        </MenuItem>
        <Divider />
        <MenuItem disabled>{state.user.username}</MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(null);
            onLogout();
          }}
        >
          退出登录
        </MenuItem>
      </Menu>
      <Menu
        anchorEl={switcher}
        open={!!switcher}
        onClose={() => setSwitcher(null)}
      >
        {state.workspace.windows.map((w, index) => (
          <MenuItem
            key={w.id}
            disabled={!online}
            aria-label={`切换到窗口 ${index + 1}`}
            onClick={() => {
              setSwitcher(null);
              run({ type: "window.activate", windowId: w.id });
            }}
          >
            {w.id === win.id ? (
              <Check fontSize="small" />
            ) : (
              <span className="menu-icon-space" />
            )}
            <span>
              {index + 1} ·{" "}
              {state.workspace.tabs.find((t) => t.id === w.activeTabId)
                ?.title || "新窗口"}
            </span>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          disabled={!online}
          onClick={() => {
            setSwitcher(null);
            run({ type: "window.create" });
          }}
        >
          新建窗口
        </MenuItem>
        <MenuItem
          disabled={!online}
          onClick={() => {
            setSwitcher(null);
            run({
              type: "window.layout",
              mode:
                state.workspace.layoutMode === "focused"
                  ? "side-by-side"
                  : "focused",
            });
          }}
        >
          {state.workspace.layoutMode === "focused"
            ? "并排显示"
            : "只显示此窗口"}
        </MenuItem>
      </Menu>
      <Menu
        anchorEl={tabMenu?.anchor}
        open={!!tabMenu}
        onClose={() => setTabMenu(null)}
      >
        <MenuItem
          disabled={!online}
          onClick={() => {
            if (tabMenu) run({ type: "window.create", url: tabMenu.tab.url });
            setTabMenu(null);
          }}
        >
          <OpenInNew fontSize="small" /> 在新窗口打开
        </MenuItem>
        {state.workspace.windows
          .filter((w) => w.id !== win.id)
          .map((w) => (
            <MenuItem
              key={w.id}
              disabled={!online}
              onClick={() => {
                if (tabMenu)
                  run({
                    type: "tab.move",
                    tabId: tabMenu.tab.id,
                    windowId: w.id,
                  });
                setTabMenu(null);
              }}
            >
              移到窗口 {state.workspace.windows.indexOf(w) + 1}
            </MenuItem>
          ))}
      </Menu>
    </section>
  );
}
export function WindowDivider({
  before,
  after,
  windows,
  action,
  report,
}: {
  before: ProductWindow;
  after: ProductWindow;
  windows: ProductWindow[];
  action: Action;
  report: (error: unknown) => void;
}) {
  const drag = useRef<{
    x: number;
    width: number;
    before: number;
    after: number;
  } | null>(null);
  const divider = useRef<HTMLDivElement>(null);
  const clampRatio = (ratio: number, width?: number) => {
    const available =
      width ??
      ((divider.current?.previousElementSibling as HTMLElement)?.offsetWidth ??
        0) +
        ((divider.current?.nextElementSibling as HTMLElement)?.offsetWidth ??
          0);
    const minimum = Math.min(0.5, 360 / Math.max(1, available));
    return Math.max(minimum, Math.min(1 - minimum, ratio));
  };
  const change = (ratio: number) => {
    const sum = before.weight + after.weight,
      next = clampRatio(ratio);
    void action({
      type: "window.layout",
      mode: "side-by-side",
      weights: windows.map((w) => ({
        windowId: w.id,
        weight:
          w.id === before.id
            ? sum * next
            : w.id === after.id
              ? sum * (1 - next)
              : w.weight,
      })),
    }).catch(report);
  };
  return (
    <div
      className="window-divider"
      ref={divider}
      role="separator"
      tabIndex={0}
      aria-label="调整窗口宽度"
      aria-orientation="vertical"
      aria-valuenow={Math.round(
        (before.weight / (before.weight + after.weight)) * 100,
      )}
      aria-valuemin={15}
      aria-valuemax={85}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          change(
            before.weight / (before.weight + after.weight) +
              (e.key === "ArrowLeft" ? -0.05 : 0.05),
          );
        }
      }}
      onPointerDown={(e) => {
        const previous = e.currentTarget.previousElementSibling as HTMLElement,
          next = e.currentTarget.nextElementSibling as HTMLElement;
        drag.current = {
          x: e.clientX,
          width: previous.offsetWidth + next.offsetWidth,
          before: before.weight,
          after: after.weight,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current) return;
        const ratio = clampRatio(
          current.before / (current.before + current.after) +
            (e.clientX - current.x) / current.width,
          current.width,
        );
        (e.currentTarget.previousElementSibling as HTMLElement).style.flexGrow =
          String((current.before + current.after) * ratio);
        (e.currentTarget.nextElementSibling as HTMLElement).style.flexGrow =
          String((current.before + current.after) * (1 - ratio));
      }}
      onPointerUp={(e) => {
        const current = drag.current;
        if (current)
          change(
            current.before / (current.before + current.after) +
              (e.clientX - current.x) / current.width,
          );
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
}
