import { create } from "zustand";
import {
  listWorkspaceDir,
  listWorkspaceFiles,
  unwatchWorkspace,
  watchWorkspace,
  type WorkspaceEntry,
} from "../tauri/api";

/** True when running inside the Tauri webview (false in a plain browser). */
const IN_TAURI = "__TAURI_INTERNALS__" in window;

/**
 * 工作区 = 某个文件夹在一扇窗口里的目录树。
 *
 * 文件夹有自己的窗口,所以工作区既不跨窗口也不跨启动记忆:每扇窗口的目录树
 * 只来自它自己打开的那个文件夹,共用的文档窗口永远没有目录树。
 */
interface WorkspaceState {
  /** 工作区根目录;null = 未打开。 */
  root: string | null;
  /** 展开的目录集合(含根)。 */
  expanded: Set<string>;
  /** 已加载目录的子项缓存(path → entries)。 */
  children: Map<string, WorkspaceEntry[]>;
  /**
   * 打开文件夹为工作区(重复打开同一目录不会重建监听;换目录会替换旧监听)。
   * 返回根目录下的文档清单摘要,调用方据此决定是否"立刻预览第一篇"。
   */
  openFolder: (path: string) => Promise<{ count: number; firstDoc: string | null }>;
  /** 展开/收起一个目录(子项懒加载)。 */
  toggleDir: (path: string) => Promise<void>;
  /** 根目录挂上后确保它的子项已加载。 */
  ensureLoaded: (path: string) => Promise<void>;
  /** workspace-changed 事件入口:合并突发事件后重拉所有展开目录。 */
  refresh: (path: string) => void;
}

/**
 * 递归列一遍工作区里的文档(有上限)。除了给头部计数,还用来决定"打开文件夹后
 * 直接进哪篇文档"。属于可失败的可选信息:老后端没有 `list_workspace_files`
 * 时回落空列表,绝不让它影响打开文件夹本身。
 */
async function listWorkspaceDocs(path: string): Promise<string[]> {
  try {
    const { files } = await listWorkspaceFiles(path);
    return files;
  } catch (e) {
    console.error("list_workspace_files failed:", path, e);
    return [];
  }
}

// workspace-changed 在一次外部保存里会连发多条,拖尾 150ms 合并成一轮重拉。
let refreshTimer: number | null = null;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  expanded: new Set(),
  children: new Map(),

  openFolder: async (path) => {
    // 重复打开同一目录时不重建监听:监听重建会把已展开的子目录清掉。
    if (get().root !== path) {
      const prev = get().root;
      if (prev && IN_TAURI) {
        await unwatchWorkspace(prev).catch(() => {});
      }
      const expanded = new Set([path]);
      set({ root: path, expanded, children: new Map() });
      if (IN_TAURI) {
        watchWorkspace(path).catch((e) => console.error("watch_workspace failed:", e));
      }
    }
    await get().ensureLoaded(path);
    // 文档清单既当计数,又用来挑"打开文件夹后立刻预览"的那篇。
    const docs = await listWorkspaceDocs(path);
    // 有 Markdown 文档就打开第一篇(递归结果里目录树自然序的第一个),让调用方
    // 能把用户直接送进预览页;一篇都没有时停在侧栏空态,不制造空白预览页。
    return { count: docs.length, firstDoc: docs[0] ?? null };
  },

  toggleDir: async (path) => {
    const expanded = new Set(get().expanded);
    if (expanded.has(path)) {
      expanded.delete(path);
      set({ expanded });
      return;
    }
    expanded.add(path);
    set({ expanded });
    await get().ensureLoaded(path);
  },

  ensureLoaded: async (path) => {
    if (!IN_TAURI || get().children.has(path)) return;
    try {
      const entries = await listWorkspaceDir(path);
      set((s) => ({ children: new Map(s.children).set(path, entries) }));
    } catch (e) {
      // 目录可能已被删除或无权限:树里保持收起,下一轮 refresh 会清掉
      console.error("list_workspace_dir failed:", path, e);
    }
  },

  refresh: (changedPath) => {
    void changedPath;
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(async () => {
      refreshTimer = null;
      const { root, expanded } = get();
      if (!root) return;
      for (const dir of expanded) {
        try {
          const entries = await listWorkspaceDir(dir);
          set((s) => ({ children: new Map(s.children).set(dir, entries) }));
        } catch {
          // 目录已消失:收起并清缓存,树自然少一项
          set((s) => {
            const next = new Set(s.expanded);
            next.delete(dir);
            const children = new Map(s.children);
            children.delete(dir);
            return { expanded: next, children };
          });
        }
      }
    }, 150);
  },
}));
