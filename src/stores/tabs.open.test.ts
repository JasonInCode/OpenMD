import { beforeEach, describe, expect, it, vi } from "vitest";

/** Tauri 的替身:存在性检查、文件读取、提示框的结果都由测试决定。 */
const mocks = vi.hoisted(() => ({
  pathExists: vi.fn<(path: string) => Promise<boolean>>(),
  readMarkdownFile: vi.fn<(path: string) => Promise<string>>(),
  message: vi.fn<(text: string, options?: unknown) => Promise<string>>(),
}));

vi.mock("../tauri/api", () => ({
  pathExists: (path: string) => mocks.pathExists(path),
  readMarkdownFile: (path: string) => mocks.readMarkdownFile(path),
  allowAssets: async () => [],
  writeMarkdownFile: async () => {},
  watchFile: async () => {},
  unwatchFile: async () => {},
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: async () => true,
  message: (text: string, options?: unknown) => mocks.message(text, options),
}));

vi.mock("../renderer/pipeline", () => ({
  renderFull: () => ({ assetPaths: [] }),
  dirnameOf: (path: string) => path,
}));

// 窗口标签在真实 Tauri 里要从当前窗口取,jsdom 里给个假的就行。
vi.mock("../lib/window", () => ({
  WINDOW_LABEL: "main",
  IS_MAIN_WINDOW: true,
  closeWindow: () => {},
}));

// tabs 在模块顶层就把「是否跑在 Tauri 里」读成了常量,必须先打上标志再导入。
vi.stubGlobal("__TAURI_INTERNALS__", {});

const { useTabs } = await import("./tabs");
const { useRecent } = await import("./recent");

describe("打开文件前的存在性检查", () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeId: "" });
    useRecent.setState({ files: [], removed: [] });
    mocks.pathExists.mockReset();
    mocks.readMarkdownFile.mockReset();
    mocks.message.mockReset();
  });

  it("文件还在才建标签,内容从磁盘读进来", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readMarkdownFile.mockResolvedValue("# 内容");

    await useTabs.getState().openPath("/docs/a.md");

    const state = useTabs.getState();
    expect(state.tabs.map((t) => t.name)).toEqual(["a.md"]);
    expect(state.tabs[0].content).toBe("# 内容");
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("文件已经不在磁盘上:不建标签,改弹原生提示框", async () => {
    mocks.pathExists.mockResolvedValue(false);

    await useTabs.getState().openPath("/docs/gone.md");

    expect(useTabs.getState().tabs).toHaveLength(0);
    expect(mocks.message).toHaveBeenCalledTimes(1);
    expect(mocks.message.mock.calls[0][0]).toContain("gone.md");
  });

  it("文件已不在磁盘上:已经开着的标签原样留着", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readMarkdownFile.mockResolvedValue("# 内容");
    await useTabs.getState().openPath("/docs/a.md");

    mocks.pathExists.mockResolvedValue(false);
    await useTabs.getState().openPath("/docs/a.md");

    const state = useTabs.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].content).toBe("# 内容");
    expect(state.tabs[0].error).toBeNull();
    expect(mocks.message).toHaveBeenCalledTimes(1);
  });

  it("文件已不在磁盘上:失效条目从「最近打开」里清掉", async () => {
    useRecent.setState({
      files: [
        { path: "/docs/gone.md", name: "gone.md", ts: Date.now() },
        { path: "/docs/keep.md", name: "keep.md", ts: Date.now() },
      ],
    });
    mocks.pathExists.mockResolvedValue(false);

    await useTabs.getState().openPath("/docs/gone.md");

    expect(useRecent.getState().files.map((f) => f.path)).toEqual(["/docs/keep.md"]);
  });

  it("文件回到磁盘上后:再打开还能自动回到「最近打开」", async () => {
    useRecent.setState({
      files: [{ path: "/docs/back.md", name: "back.md", ts: Date.now() }],
    });
    mocks.pathExists.mockResolvedValue(false);
    await useTabs.getState().openPath("/docs/back.md");
    expect(useRecent.getState().files).toHaveLength(0);

    mocks.pathExists.mockResolvedValue(true);
    mocks.readMarkdownFile.mockResolvedValue("# 内容");
    await useTabs.getState().openPath("/docs/back.md");

    expect(useRecent.getState().files.map((f) => f.path)).toEqual(["/docs/back.md"]);
  });
});
