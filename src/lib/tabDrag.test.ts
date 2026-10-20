import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "../stores/tabs";

// tabDrag 模块内嵌 beginTabDrag / endTabDrag 调到 Tauri 后端。chip 窗口里
// pointerup 是不是真送出 endTabDrag 就是这次回归守住的事,所以测试里把它桩了;
// 重点是验证事件 → 后端调用的连线,不在 IPC 本身。
vi.mock("../tauri/api", () => ({
  beginTabDrag: vi.fn(async () => "tab-win-test"),
  endTabDrag: vi.fn(async () => {}),
  watchFile: vi.fn(async () => {}),
  unwatchFile: vi.fn(async () => {}),
}));

const tabsMockState = { tabs: [] as Tab[] };
vi.mock("../stores/tabs", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    useTabs: {
      getState: () => ({
        removeTab: (id: string) => {
          tabsMockState.tabs = tabsMockState.tabs.filter((t) => t.id !== id);
        },
        tabs: tabsMockState.tabs,
      }),
    },
  };
});

interface PointerEventTargetMock {
  setPointerCapture: (id: number) => void;
  releasePointerCapture: (id: number) => void;
  getBoundingClientRect: () => DOMRect;
  _captureCalls: Array<{ id: number }>;
}

/**
 * jsdom 不实现 setPointerCapture,所以用一个最小 fake:把调用记录下来,验证
 * 拖拽开始时确实绑回 tab DOM。行为(后续事件落到同一元素)是浏览器原生的,
 * 这里不重造。
 */
function makeTargetWithFakeCapture(): PointerEventTargetMock {
  const node = document.createElement("div");
  const captureCalls: Array<{ id: number }> = [];
  Object.defineProperty(node, "setPointerCapture", {
    value: (id: number) => {
      captureCalls.push({ id });
    },
  });
  Object.defineProperty(node, "releasePointerCapture", {
    value: () => {},
  });
  Object.defineProperty(node, "getBoundingClientRect", {
    value: () =>
      ({
        left: 100,
        top: 50,
        right: 300,
        bottom: 82,
        width: 200,
        height: 32,
        x: 100,
        y: 50,
        toJSON() {},
      }) as DOMRect,
  });
  document.body.appendChild(node);
  const target = node as unknown as PointerEventTargetMock;
  target._captureCalls = captureCalls;
  return target;
}

/** 装一个 currentTarget 指向指定 DOM 节点的 PointerEvent。jsdom 没有现成的。 */
function makePointerEvent(target: PointerEventTargetMock, init: {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
}): PointerEvent {
  const event = new PointerEvent("pointerdown", {
    pointerId: init.pointerId ?? 1,
    clientX: init.clientX ?? 150,
    clientY: init.clientY ?? 60,
    button: init.button ?? 0,
    bubbles: true,
  });
  Object.defineProperty(event, "currentTarget", {
    value: target as unknown as EventTarget,
    configurable: true,
  });
  Object.defineProperty(event, "pointerId", {
    value: init.pointerId ?? 1,
    configurable: true,
  });
  Object.defineProperty(event, "clientX", {
    value: init.clientX ?? 150,
    configurable: true,
  });
  Object.defineProperty(event, "clientY", {
    value: init.clientY ?? 60,
    configurable: true,
  });
  return event;
}

function makeTab(id: string): Tab {
  return {
    id,
    path: `/docs/${id}.md`,
    name: `${id}.md`,
    content: "",
    draft: null,
    lastSavedAt: 0,
    diskChanged: false,
    scrollY: 0,
    error: null,
  };
}

let tabDragModule: typeof import("./tabDrag");

beforeEach(async () => {
  vi.clearAllMocks();
  tabsMockState.tabs = [makeTab("a")];
  document.body.innerHTML = "";
  // 重置模块级 pressed / dragging 状态:tabDrag 内部用模块变量记录当前按下的
  // 标签,上一组测试残留会让阈值检查误判,清掉模块缓存后每个用例都是冷启动。
  vi.resetModules();
  tabDragModule = await import("./tabDrag");
});

afterEach(() => {
  // 把所有 watchChipDrag 注册的 window 监听干掉,防止跨测试叠加。
  window.removeEventListener("pointerup", () => {});
  window.removeEventListener("pointerdown", () => {});
});

describe("按下标签", () => {
  it("用 setPointerCapture 把指针绑回 tab DOM", () => {
    const target = makeTargetWithFakeCapture();
    const event = makePointerEvent(target, { pointerId: 7, clientX: 150, clientY: 60 });
    tabDragModule.startPress(
      tabsMockState.tabs[0],
      event as unknown as React.PointerEvent<HTMLElement>,
    );
    expect(target._captureCalls).toEqual([{ id: 7 }]);
  });

  it("右键按下不进入拖拽流程,也不会绑指针捕获", () => {
    const target = makeTargetWithFakeCapture();
    const event = makePointerEvent(target, { pointerId: 7, button: 2 });
    tabDragModule.startPress(
      tabsMockState.tabs[0],
      event as unknown as React.PointerEvent<HTMLElement>,
    );
    expect(target._captureCalls).toEqual([]);
  });
});

describe("芯片窗口的兜底收尾", () => {
  it("松手事件直接调一次 endTabDrag,不依赖本窗口 dragging 标志", async () => {
    const cleanup = tabDragModule.watchChipDrag();
    const endTabDrag = (await import("../tauri/api")).endTabDrag as ReturnType<typeof vi.fn>;
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await Promise.resolve();
    expect(endTabDrag).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("清理函数卸下监听,后续松手不再调后端", async () => {
    const cleanup = tabDragModule.watchChipDrag();
    cleanup();
    const endTabDrag = (await import("../tauri/api")).endTabDrag as ReturnType<typeof vi.fn>;
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await Promise.resolve();
    expect(endTabDrag).not.toHaveBeenCalled();
  });
});
