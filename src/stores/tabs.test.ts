import { describe, expect, it, vi } from "vitest";

// jsdom 里没有 Tauri 的 invoke,文件监听只会打一串无意义的报错。
vi.mock("../tauri/api", () => ({
  watchFile: async () => {},
  unwatchFile: async () => {},
}));

import { useConfirm } from "./confirm";
import { isDirty, useTabs, type TransferTab } from "./tabs";

function payload(name: string, overrides: Partial<TransferTab> = {}): TransferTab {
  return {
    path: `/docs/${name}`,
    name,
    content: `# ${name}`,
    draft: null,
    lastSavedAt: 0,
    diskChanged: false,
    scrollY: 0,
    error: null,
    ...overrides,
  };
}

function reset(...tabs: TransferTab[]) {
  useTabs.setState({ tabs: [], activeId: "" });
  for (const tab of tabs) useTabs.getState().insertTab(tab);
}

describe("标签的插入与排序", () => {
  it("标签可以整个搬到本窗口,并保留未保存的草稿", () => {
    reset();
    useTabs.getState().insertTab(payload("a.md", { draft: "# 改过还没存", scrollY: 420 }));

    const [tab] = useTabs.getState().tabs;
    expect(tab.name).toBe("a.md");
    expect(tab.draft).toBe("# 改过还没存");
    expect(isDirty(tab)).toBe(true);
    expect(tab.scrollY).toBe(420);
    expect(useTabs.getState().activeId).toBe(tab.id);
  });

  it("落到指定插入位,并落在那个位置上", () => {
    reset(payload("a.md"), payload("c.md"));
    useTabs.getState().insertTab(payload("b.md"), 1);

    expect(useTabs.getState().tabs.map((t) => t.name)).toEqual(["a.md", "b.md", "c.md"]);
    const inserted = useTabs.getState().tabs[1];
    expect(useTabs.getState().activeId).toBe(inserted.id);
  });

  it("插入位越界时贴到两端,不会插丢", () => {
    reset(payload("a.md"), payload("b.md"));
    useTabs.getState().insertTab(payload("head.md"), -5);
    useTabs.getState().insertTab(payload("tail.md"), 99);

    expect(useTabs.getState().tabs.map((t) => t.name)).toEqual([
      "head.md",
      "a.md",
      "b.md",
      "tail.md",
    ]);
  });

  it("本窗口内拖拽排序:先摘后插,索引按摘掉之后的列表算", () => {
    reset(payload("a.md"), payload("b.md"), payload("c.md"));
    const [a, b, c] = useTabs.getState().tabs;

    // a 拖到 b 前面
    useTabs.getState().moveTab(a.id, 1);
    expect(useTabs.getState().tabs.map((t) => t.name)).toEqual(["b.md", "a.md", "c.md"]);

    useTabs.getState().moveTab(c.id, 0);
    expect(useTabs.getState().tabs.map((t) => t.name)).toEqual(["c.md", "b.md", "a.md"]);
    expect([a, b, c].map((t) => t.id).sort()).toEqual(
      useTabs.getState()
        .tabs.map((t) => t.id)
        .sort(),
    );
  });

  it("排序一个不存在的标签不会动列表", () => {
    reset(payload("a.md"));
    useTabs.getState().moveTab("nope", 0);
    expect(useTabs.getState().tabs.map((t) => t.name)).toEqual(["a.md"]);
  });
});

describe("关标签", () => {
  it("关掉当前标签后激活项落在接替它位置的那个标签上", () => {
    reset(payload("a.md"), payload("b.md"), payload("c.md"));
    const [, b, c] = useTabs.getState().tabs;
    useTabs.getState().setActive(b.id);

    useTabs.getState().closeTab(b.id);

    const state = useTabs.getState();
    expect(state.tabs.map((t) => t.name)).toEqual(["a.md", "c.md"]);
    expect(state.activeId).toBe(c.id);
  });

  it("关掉最后一个标签时激活项落在新的末尾,而不是越界", () => {
    reset(payload("a.md"), payload("b.md"));
    const [, b] = useTabs.getState().tabs;
    useTabs.getState().setActive(b.id);

    useTabs.getState().closeTab(b.id);

    const state = useTabs.getState();
    expect(state.tabs.map((t) => t.name)).toEqual(["a.md"]);
    expect(state.activeId).toBe(state.tabs[0].id);
  });

  it("关掉最后一个标签后回到首页(标签为空)", () => {
    reset(payload("only.md"));
    useTabs.getState().closeTab(useTabs.getState().tabs[0].id);

    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().activeId).toBe("");
  });

  it("激活一个已经不存在的标签不会把激活链停在空档上", () => {
    reset(payload("a.md"), payload("b.md"));
    const [a] = useTabs.getState().tabs;

    useTabs.getState().removeTab(a.id);
    useTabs.getState().setActive(a.id);

    expect(useTabs.getState().activeId).toBe(useTabs.getState().tabs[0].id);
  });

  it("拖出标签是静默摘除,不走未保存询问", () => {
    reset(payload("a.md", { draft: "还没存" }));
    const [tab] = useTabs.getState().tabs;

    let asked = false;
    useConfirm.setState({ resolve: () => { asked = true; } });
    useTabs.getState().removeTab(tab.id);
    useConfirm.setState({ resolve: null });

    expect(useTabs.getState().tabs).toEqual([]);
    expect(asked).toBe(false);
  });
});

describe("关窗口前的未保存确认", () => {
  it("没有未保存修改时直接放行", async () => {
    reset(payload("a.md"), payload("b.md"));
    await expect(useTabs.getState().confirmCloseAll()).resolves.toBe(true);
  });

  it("用户选取消就不关,标签原样留着", async () => {
    reset(payload("a.md", { draft: "还没存" }));
    const tab = useTabs.getState().tabs[0];

    const closing = useTabs.getState().confirmCloseAll();
    useConfirm.getState().settleUnsaved("cancel");

    await expect(closing).resolves.toBe(false);
    expect(useTabs.getState().tabs[0].id).toBe(tab.id);
    expect(isDirty(useTabs.getState().tabs[0])).toBe(true);
  });

  it("用户选不保存时草稿留在标签上,由关窗口这一步一起带走", async () => {
    reset(payload("a.md", { draft: "还没存" }));

    const closing = useTabs.getState().confirmCloseAll();
    useConfirm.getState().settleUnsaved("discard");

    await expect(closing).resolves.toBe(true);
    // 询问只负责"要不要存",真正清空随窗口销毁发生。
    expect(useTabs.getState().tabs).toHaveLength(1);
  });
});
