import { beforeEach, describe, expect, it, vi } from "vitest";

/** Tauri 的替身:目录列举与目录监听的返回值由测试决定。 */
const mocks = vi.hoisted(() => ({
  listWorkspaceDir: vi.fn<(path: string) => Promise<unknown[]>>(() => Promise.resolve([])),
  listWorkspaceFiles: vi.fn<(path: string) => Promise<{ files: string[] }>>(() =>
    Promise.resolve({ files: [] }),
  ),
  watchWorkspace: vi.fn<(path: string) => Promise<void>>(() => Promise.resolve()),
  unwatchWorkspace: vi.fn<(path: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("../tauri/api", () => ({
  listWorkspaceDir: (path: string) => mocks.listWorkspaceDir(path),
  listWorkspaceFiles: (path: string) => mocks.listWorkspaceFiles(path),
  watchWorkspace: (path: string) => mocks.watchWorkspace(path),
  unwatchWorkspace: (path: string) => mocks.unwatchWorkspace(path),
}));

// 窗口标签在真实 Tauri 里要从当前窗口取,jsdom 里给个假的就行。
vi.mock("../lib/window", () => ({
  WINDOW_LABEL: "main",
  IS_MAIN_WINDOW: true,
  closeWindow: () => {},
}));

// 升级前的工作区记忆还留在 localStorage 里:共享的文档窗口不该把它读回来。
localStorage.setItem(
  "openmd-workspace",
  JSON.stringify({ root: "/docs", expanded: ["/docs", "/docs/sub"] }),
);

// workspace 在模块顶层就把「是否跑在 Tauri 里」读成了常量,必须先打上标志再导入。
vi.stubGlobal("__TAURI_INTERNALS__", {});

const { useWorkspace } = await import("./workspace");

// 导入那一刻的状态:窗口启动时它认不认上次打开过的文件夹。
const rootAtStartup = useWorkspace.getState().root;

describe("工作区只属于打开文件夹的那扇窗口", () => {
  beforeEach(() => {
    useWorkspace.setState({ root: null, expanded: new Set(), children: new Map() });
    mocks.listWorkspaceDir.mockReset();
    mocks.listWorkspaceFiles.mockReset();
    mocks.watchWorkspace.mockReset();
    mocks.unwatchWorkspace.mockReset();
  });

  it("共享的文档窗口启动时不带上次打开过的文件夹", () => {
    expect(rootAtStartup).toBeNull();
  });

  it("文件夹窗口打开目录后,目录树才就位", async () => {
    mocks.listWorkspaceDir.mockResolvedValue([
      { name: "a.md", path: "/docs/a.md", is_dir: false },
    ]);
    mocks.listWorkspaceFiles.mockResolvedValue({ files: ["/docs/a.md"] });

    const { count, firstDoc } = await useWorkspace.getState().openFolder("/docs");

    const state = useWorkspace.getState();
    expect(state.root).toBe("/docs");
    expect(state.expanded.has("/docs")).toBe(true);
    expect(state.children.get("/docs")).toHaveLength(1);
    expect(count).toBe(1);
    expect(firstDoc).toBe("/docs/a.md");
    expect(mocks.watchWorkspace).toHaveBeenCalledWith("/docs");
  });
});
