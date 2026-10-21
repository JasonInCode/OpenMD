import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSearch } from "../stores/search";
import {
  closeSearch,
  collectMatches,
  registerSearchRoot,
  setSearchQuery,
  stepSearchMatch,
} from "./documentSearch";

function makeRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function texts(matches: ReturnType<typeof collectMatches>): string[] {
  return matches.map((m) => m.parts.map((p) => p.node.nodeValue?.slice(p.start, p.end)).join(""));
}

describe("collectMatches", () => {
  it("找出全部命中且不区分大小写", () => {
    const root = makeRoot("<p>Foo foo FOO</p>");
    expect(texts(collectMatches(root, "foo"))).toEqual(["Foo", "foo", "FOO"]);
  });

  it("空查询没有命中", () => {
    expect(collectMatches(makeRoot("<p>abc</p>"), "")).toEqual([]);
  });

  it("跳过脚本、样式与按钮里的文字", () => {
    const root = makeRoot("<p>abc</p><script>abc</script><style>abc</style><button>abc</button>");
    expect(collectMatches(root, "abc").length).toBe(1);
  });

  it("不跨段落匹配", () => {
    const root = makeRoot("<p><strong>ab</strong></p><p>cd</p>");
    expect(collectMatches(root, "abcd").length).toBe(0);
  });

  it("跨行内标签匹配", () => {
    const root = makeRoot("<p><strong>ab</strong>cd</p>");
    expect(texts(collectMatches(root, "abcd"))).toEqual(["abcd"]);
  });

  it("跨代码高亮的标签匹配", () => {
    const root = makeRoot("<pre><code><span>def</span> <span>main</span>()</code></pre>");
    expect(texts(collectMatches(root, "def main"))).toEqual(["def main"]);
  });
});

describe("搜索状态", () => {
  beforeEach(() => {
    useSearch.setState({ open: false, query: "", matches: [], index: -1 });
    registerSearchRoot(null);
  });

  it("输入查询词后报出命中数,还不预选命中", () => {
    registerSearchRoot(makeRoot("<p>abc abc abc</p>"));
    setSearchQuery("abc");
    expect(useSearch.getState().matches.length).toBe(3);
    expect(useSearch.getState().index).toBe(-1);
  });

  it("没有命中时清掉命中数", () => {
    registerSearchRoot(makeRoot("<p>abc</p>"));
    setSearchQuery("xyz");
    expect(useSearch.getState().matches.length).toBe(0);
    expect(useSearch.getState().index).toBe(-1);
  });

  it("跳转会在命中之间循环", () => {
    registerSearchRoot(makeRoot("<p>abc abc</p>"));
    setSearchQuery("abc");
    stepSearchMatch(1);
    expect(useSearch.getState().index).toBe(0);
    stepSearchMatch(1);
    expect(useSearch.getState().index).toBe(1);
    stepSearchMatch(1);
    expect(useSearch.getState().index).toBe(0);
    stepSearchMatch(-1);
    expect(useSearch.getState().index).toBe(1);
  });

  it("反向跳转在没预选时落到最后一处", () => {
    registerSearchRoot(makeRoot("<p>abc abc</p>"));
    setSearchQuery("abc");
    stepSearchMatch(-1);
    expect(useSearch.getState().index).toBe(1);
  });

  it("换文档后重置选中位置", () => {
    registerSearchRoot(makeRoot("<p>abc abc</p>"));
    setSearchQuery("abc");
    stepSearchMatch(1);
    expect(useSearch.getState().index).toBe(0);
    registerSearchRoot(makeRoot("<p>abc</p>"));
    expect(useSearch.getState().index).toBe(-1);
  });

  it("收起时清掉查询词与命中", () => {
    registerSearchRoot(makeRoot("<p>abc</p>"));
    setSearchQuery("abc");
    closeSearch();
    expect(useSearch.getState().open).toBe(false);
    expect(useSearch.getState().query).toBe("");
    expect(useSearch.getState().matches.length).toBe(0);
  });
});

describe("高亮注册", () => {
  it("用 CSS Custom Highlight API 注册命中区间", async () => {
    vi.resetModules();
    const registry = new Map<string, { ranges: Range[]; priority: number }>();
    class FakeHighlight {
      priority = 0;
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    (globalThis as unknown as { CSS: unknown }).CSS = {
      highlights: {
        set: (name: string, hl: FakeHighlight) => registry.set(name, hl),
        delete: (name: string) => registry.delete(name),
      },
    };
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;

    const mod = await import("./documentSearch");
    const root = makeRoot("<p>abc abc</p>");
    mod.registerSearchRoot(root);
    mod.setSearchQuery("abc");
    mod.stepSearchMatch(1);

    const all = registry.get("md-find");
    expect(all?.ranges.length).toBe(2);
    expect(all?.ranges[0].toString()).toBe("abc");
    const current = registry.get("md-find-current");
    expect(current?.ranges.length).toBe(1);
    expect(current?.priority).toBe(1);

    mod.closeSearch();
    expect(registry.size).toBe(0);
    delete (globalThis as unknown as { CSS?: unknown }).CSS;
    delete (globalThis as unknown as { Highlight?: unknown }).Highlight;
  });
});
