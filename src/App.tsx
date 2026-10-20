import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Flex, Box } from "@chakra-ui/react";
import { TitleBar } from "./components/TitleBar";
import { TabBar } from "./components/TabBar";
import { Sidebar } from "./components/Sidebar";
import { MarkdownView } from "./components/MarkdownView";
import { EmptyState } from "./components/EmptyState";
import { StatusBar } from "./components/StatusBar";
import { UpdatePopup } from "./components/UpdatePopup";
import { TabGhost } from "./components/TabGhost";
import { AppBackground } from "./components/AppBackground";
import { CloseDialog } from "./components/CloseDialog";
import { UnsavedDialog } from "./components/UnsavedDialog";
import { useTabs } from "./stores/tabs";
import { useSettings } from "./stores/settings";
import { useWorkspace } from "./stores/workspace";
import { useUpdate } from "./stores/update";
import { IS_STORE_BUILD } from "./lib/build-flags";
import { openStandaloneFiles } from "./lib/openStandaloneFiles";
import { IS_MAIN_WINDOW, closeWindow } from "./lib/window";
import { measureInsertion } from "./lib/tabDrop";
import { watchChipDrag } from "./lib/tabDrag";
import { openFolderAsWorkspace } from "./lib/openFolderAsWorkspace";
import { viewInAnimation } from "./theme/theme";
import {
  getOpenedPaths,
  isDirectory,
  logAssoc,
  MARKDOWN_EXTENSIONS,
  onFileChanged,
  onOpenedFiles,
  onTabDragSettled,
  onTabDrop,
  onOpenedFolders,
  onWorkspaceChanged,
  openFileDialog,
  openFolderDialog,
  takePendingTab,
} from "./tauri/api";

/** True when running inside the Tauri webview (false in a plain browser). */
const inTauri = "__TAURI_INTERNALS__" in window;

function isMarkdownPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTENSIONS.includes(ext);
}

/**
 * 取走 Rust 侧积压的打开请求并打开。前端是队列的唯一消费者:事件只是敲门声,
 * 真正的路径一律从 `getOpenedPaths` 取,所以漏掉一次事件最多晚一个敲门周期。
 * 文件开成文档标签,文件夹开成工作区——与拖拽入口走同一套处理。
 */
async function drainOpenedPaths(): Promise<void> {
  if (!inTauri) return;
  const buffered = await getOpenedPaths().catch((e) => {
    void logAssoc(`getOpenedPaths FAILED: ${e}`);
    return { files: [], folders: [] };
  });
  if (buffered.files.length === 0 && buffered.folders.length === 0) return;
  void logAssoc(`drained ${buffered.files.length} files, ${buffered.folders.length} folders`);
  await openStandaloneFiles(buffered.files);
  for (const folder of buffered.folders) await openFolderAsWorkspace(folder);
}

export default function App() {
  const { t } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const refreshPath = useTabs((s) => s.refreshPath);
  const { tocOpen, backgroundImage, editMode } = useSettings();
  const [openError, setOpenError] = useState<string | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  // 托盘"检查更新"的结果提示(已是最新/失败);发现新版本时直接弹更新弹窗
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  // 顶部提示条(编辑模式切换等):与底部 notice 相互独立,3 秒自动消失。
  // phase 用于播退场动画(closing → 动画播完再卸载)。
  const [topNotice, setTopNotice] = useState<{ text: string; phase: "open" | "closing" } | null>(null);
  const topNoticeTimerRef = useRef<number | null>(null);
  const topNoticeExitTimerRef = useRef<number | null>(null);
  const restoredRef = useRef(false);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // 启动自动检查更新(GitCode release,带令牌认证);发现新版本时右下角弹更新弹窗。
  // 商店版(MSIX)更新由商店接管,不做任何应用内更新。
  useEffect(() => {
    if (!inTauri || IS_STORE_BUILD) return;
    const timer = window.setTimeout(() => {
      void useUpdate.getState().check();
    }, 1500);
    // 下载进度事件 → store
    const unlisten = listen<{ progress: number }>("update-download-progress", (e) => {
      useUpdate.getState().setProgress(e.payload.progress);
    });
    return () => {
      window.clearTimeout(timer);
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 托盘事件:关闭询问(点 X 被 Rust 拦截)与"检查更新"菜单项。
  useEffect(() => {
    if (!inTauri) return;
    const unlistenClose = listen("close-requested", () => {
      // 拆分出来的窗口点 X 就是关掉它:先把未保存修改逐个问清楚,用户取消就留着。
      if (!IS_MAIN_WINDOW) {
        void useTabs
          .getState()
          .confirmCloseAll()
          .then((ok) => {
            if (ok) closeWindow();
          });
        return;
      }
      const action = useSettings.getState().closeAction;
      if (action === "tray") {
        void invoke("hide_to_tray").catch(() => {});
      } else if (action === "exit") {
        void invoke("quit_app").catch(() => {});
      } else {
        setCloseDialogOpen(true);
      }
    });
    const unlistenTrayCheck = listen("tray-check-update", () => {
      // 商店版托盘菜单不含此项;双保险避免商店外更新入口。
      if (IS_STORE_BUILD) return;
      void useUpdate.getState().check().then((result) => {
        if (result === "latest") showNotice(t("shell.upToDate"));
        else if (result === "error") showNotice(t("shell.updateCheckFailed"));
        // available 时更新弹窗自动弹出,无需额外提示
      });
    });
    return () => {
      unlistenClose.then((fn) => fn()).catch(() => {});
      unlistenTrayCheck.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 底部居中提示条(3 秒自动消失)
  const showNotice = (text: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 3000);
  };

  // 顶部提示条(3 秒自动消失):先播入场动画,收起时切 closing 播退场动画再卸载。
  const showTopNotice = (text: string) => {
    if (topNoticeTimerRef.current !== null) window.clearTimeout(topNoticeTimerRef.current);
    if (topNoticeExitTimerRef.current !== null) window.clearTimeout(topNoticeExitTimerRef.current);
    setTopNotice({ text, phase: "open" });
    topNoticeTimerRef.current = window.setTimeout(() => {
      topNoticeTimerRef.current = null;
      setTopNotice((n) => (n ? { ...n, phase: "closing" } : n));
      topNoticeExitTimerRef.current = window.setTimeout(() => {
        topNoticeExitTimerRef.current = null;
        setTopNotice(null);
      }, 160);
    }, 3000);
  };

  // 编辑模式开关 → 顶部提示。按钮点击与 Ctrl+E 快捷键都会走到这里。
  // 首次挂载不提示(避免恢复持久化的 editMode 时误弹);首页(无文档)也不提示。
  const prevEditModeRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevEditModeRef.current;
    prevEditModeRef.current = editMode;
    if (prev === null || prev === editMode || !activeTab?.path) return;
    showTopNotice(editMode ? t("shell.editModeOn") : t("shell.editModeOff"));
  }, [editMode, activeTab?.path, t]);

  // 启动固定停留在首页(不自动恢复上次会话);只处理系统"打开方式"
  // /拖拽缓冲的文件请求。在纯浏览器环境(开发预览)不处理。
  // startupReady:启动排水(打开关联文件)完成前不渲染首页,避免闪一下主页。
  const [startupReady, setStartupReady] = useState(!inTauri);
  // 芯片窗口:这扇窗口此刻只是一枚跟手的标签,落定后才展开成完整界面。
  const [ghost, setGhost] = useState(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    (async () => {
      if (inTauri) {
        // 拖标签拆出来的窗口:标签在建窗时就分配好了,先取回来。
        const pending = await takePendingTab().catch(() => null);
        if (pending) {
          useTabs.getState().insertTab(pending.tab);
          setGhost(pending.ghost);
        }
        // 系统"打开方式"的缓冲只有主窗口该排空:新窗口排空了会把待打开的文件抢走。
        if (IS_MAIN_WINDOW) await drainOpenedPaths();
      }
      setStartupReady(true);
    })();
  }, []);

  // OS file watchers → refresh the tab that owns the file. Per-path 100ms
  // coalescing (editors fire several events per save) plus a suppression
  // window after our own save — the tab already holds that content.
  useEffect(() => {
    if (!inTauri) return;
    const pending = new Map<string, number>();
    const OWN_SAVE_SUPPRESSION_MS = 1500;
    const COALESCE_MS = 100;
    const unlistenFileChanged = onFileChanged(({ path }) => {
      const prev = pending.get(path);
      if (prev) window.clearTimeout(prev);
      pending.set(
        path,
        window.setTimeout(() => {
          pending.delete(path);
          const tab = useTabs.getState().tabs.find((t) => t.path === path);
          if (tab?.lastSavedAt && Date.now() - tab.lastSavedAt < OWN_SAVE_SUPPRESSION_MS) return;
          void refreshPath(path);
        }, COALESCE_MS),
      );
    });
    const unlistenOpened = onOpenedFiles(() => {
      void drainOpenedPaths();
    });
    // 资源管理器里右键文件夹「Open with OpenMD」:打开为工作区。
    const unlistenFolders = onOpenedFolders(() => {
      void drainOpenedPaths();
    });
    // 工作区目录树的外部变更(store 内部有拖尾合并,重拉展开目录)
    const unlistenWorkspace = onWorkspaceChanged(({ path }) => {
      useWorkspace.getState().refresh(path);
    });
    return () => {
      unlistenFileChanged.then((fn) => fn());
      unlistenOpened.then((fn) => fn());
      unlistenFolders.then((fn) => fn());
      unlistenWorkspace.then((fn) => fn());
    };
  }, [refreshPath]);

  // 全局禁用 WebView2 默认右键菜单;内容区的自定义菜单在 MarkdownView 里,
  // 内容区之外右键静默无菜单。
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Drag & drop onto the window: .md files open as tabs, folders open as
  // the workspace tree.
  useEffect(() => {
    if (!inTauri) return;
    const promise = getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const markdownPaths: string[] = [];
          for (const p of event.payload.paths) {
            if (isMarkdownPath(p)) {
              markdownPaths.push(p);
              continue;
            }
            void isDirectory(p)
              .then((isDir) => {
                if (isDir) void useWorkspace.getState().openFolder(p);
              })
              .catch(() => {});
          }
          if (markdownPaths.length > 0) void openStandaloneFiles(markdownPaths);
        }
      })
      .catch((e) => {
        console.error("drag-drop init failed:", e);
        return () => {};
      });
    return () => {
      promise.then((fn) => fn());
    };
  }, []);

  // 别的窗口把标签拖到本窗口:按落点位置插进标签栏(插入位由本窗口的标签栏量)。
  useEffect(() => {
    if (!inTauri) return;
    const unlisten = onTabDrop(({ tab, x }) => {
      useTabs.getState().insertTab(tab, measureInsertion(x)?.index);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 芯片窗口落定:换成完整界面。
  useEffect(() => {
    if (!inTauri) return;
    const unlisten = onTabDragSettled(() => setGhost(false));
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // 芯片窗口的兜底收尾:松手事件万一落到它身上(指针捕获在个别平台可能丢),
  // 也把这一场拖拽结算掉。同一个命令幂等,不会重复结算。
  useEffect(() => {
    if (!ghost) return;
    return watchChipDrag();
  }, [ghost]);

  // 设置跨窗口实时同步:各窗口共用一份 localStorage,但 zustand 不会自动收
  // storage 事件,一个窗口改了字号/主题,其他窗口得自己跟上。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "openmd-settings" || !e.newValue) return;
      const incoming = (JSON.parse(e.newValue) as { state?: Record<string, unknown> }).state;
      if (!incoming) return;
      const current = useSettings.getState() as unknown as Record<string, unknown>;
      // 值全一样就别写回:persist 每次 setState 都落盘,不挡住相等状态就会
      // A 写 → B 应用 → B 写 → A 应用 无限对敲。
      if (Object.entries(incoming).every(([key, value]) => current[key] === value)) return;
      useSettings.setState(incoming);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Window title follows the active tab.
  useEffect(() => {
    if (!inTauri) return;
    const name = activeTab?.path ? activeTab.name : "OpenMD";
    getCurrentWindow()
      .setTitle(name === "OpenMD" ? "OpenMD" : `${name} - OpenMD`)
      .catch(() => {});
  }, [activeTab]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const state = useTabs.getState();
      const key = e.key.toLowerCase();

      if (key === "o") {
        e.preventDefault();
        if (e.shiftKey) {
          // Ctrl+Shift+O:选择文件夹打开为工作区
          openFolderDialog()
            .then((p) => {
              if (p) void useWorkspace.getState().openFolder(p);
            })
            .catch((err) => setOpenError(String(err)));
        } else {
          openFileDialog()
            .then((paths) => {
              void openStandaloneFiles(paths ?? []);
            })
            .catch((err) => setOpenError(String(err)));
        }
      } else if (key === "w") {
        if (state.activeId) {
          e.preventDefault();
          void state.requestCloseTab(state.activeId);
        }
      } else if (key === "s") {
        e.preventDefault();
        void state.saveTab(state.activeId);
      } else if (key === "e") {
        e.preventDefault();
        useSettings.getState().toggleEditMode();
      } else if (key === "tab") {
        e.preventDefault();
        const idx = state.tabs.findIndex((t) => t.id === state.activeId);
        const next = e.shiftKey
          ? state.tabs[(idx - 1 + state.tabs.length) % state.tabs.length]
          : state.tabs[(idx + 1) % state.tabs.length];
        if (next) state.setActive(next.id);
      } else if (key === "b") {
        e.preventDefault();
        useSettings.getState().toggleToc();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        const { fontSize, setFontSize } = useSettings.getState();
        setFontSize(fontSize + 1);
      } else if (e.key === "-") {
        e.preventDefault();
        const { fontSize, setFontSize } = useSettings.getState();
        setFontSize(fontSize - 1);
      } else if (e.key === "0") {
        e.preventDefault();
        useSettings.getState().setFontSize(17);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showSidebar = tocOpen && activeTab !== undefined;
  // 一个标签都没有 = 首页:整页留白,只显示居中文字 Logo。
  const isHome = tabs.length === 0;
  // 启动排水未完成前只渲染空白底色(正在打开关联文件),避免首页闪现。

  return (
    <Flex
      direction="column"
      h="100vh"
      className="app-shell"
      // 有自定义背景图时让出底色,露出底层的模糊图片;无背景时保持原来的画布色。
      bg={backgroundImage ? "transparent" : "bg.canvas"}
      color="fg"
    >
      <AppBackground />
      {!startupReady ? (
        <Box flex={1} bg="bg" />
      ) : ghost ? (
        <TabGhost />
      ) : isHome ? (
        <EmptyState />
      ) : (
        <Flex direction="column" flex={1} minH={0} {...viewInAnimation}>
          <TitleBar onOpenError={setOpenError} />
          <TabBar />
          <Flex flex={1} minH={0} position="relative">
            {activeTab && <Sidebar open={showSidebar} />}
            {activeTab && <MarkdownView key={activeTab.id} tab={activeTab} />}
            {/* 提示条落在内容区顶部居中(不压 Tab 栏):data-placement=bottom 让
                slide-fade-in/out 表现为「自上滑入 / 向上滑出」。 */}
            {topNotice && (
              <Flex
                data-placement="bottom"
                position="absolute"
                top="12px"
                left="50%"
                transform="translateX(-50%)"
                animationStyle={topNotice.phase === "open" ? "slide-fade-in" : "slide-fade-out"}
                animationDuration={topNotice.phase === "open" ? "fast" : "faster"}
                animationFillMode="both"
                bg="fg"
                color="bg"
                px={4}
                py={2}
                borderRadius="md"
                fontSize="xs"
                boxShadow="lg"
                zIndex={100}
                pointerEvents="none"
              >
                {topNotice.text}
              </Flex>
            )}
          </Flex>
          <StatusBar />
        </Flex>
      )}
      {notice && (
        <Flex
          position="fixed"
          bottom="36px"
          left="50%"
          transform="translateX(-50%)"
          bg="fg"
          color="bg"
          px={4}
          py={2}
          borderRadius="md"
          fontSize="xs"
          boxShadow="lg"
          zIndex={100}
        >
          {notice}
        </Flex>
      )}
      {openError && (
        <Flex
          position="fixed"
          bottom="36px"
          left="50%"
          transform="translateX(-50%)"
          bg="red.500"
          color="white"
          px={4}
          py={2}
          borderRadius="md"
          fontSize="xs"
          cursor="pointer"
          onClick={() => setOpenError(null)}
          boxShadow="lg"
          zIndex={100}
        >
          {t("shell.openErrorClickToDismiss", { error: openError })}
        </Flex>
      )}
      <UpdatePopup />
      <CloseDialog open={closeDialogOpen} onClose={() => setCloseDialogOpen(false)} />
      <UnsavedDialog />
    </Flex>
  );
}
