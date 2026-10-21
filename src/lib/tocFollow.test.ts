import { describe, expect, it } from "vitest";
import { minimalFollowScrollTop } from "./tocFollow";

const base = {
  viewTop: 100,
  viewBottom: 300,
  scrollTop: 0,
  maxScrollTop: 1000,
};

describe("目录栏最小滚动", () => {
  it("选中条目已经在可视区内时不动", () => {
    expect(minimalFollowScrollTop({ ...base, itemTop: 150, itemBottom: 190 })).toBeNull();
    // 贴边也算可见:不产生多余的滚动。
    expect(minimalFollowScrollTop({ ...base, itemTop: 100, itemBottom: 130 })).toBeNull();
    expect(minimalFollowScrollTop({ ...base, itemTop: 270, itemBottom: 300 })).toBeNull();
  });

  it("选中条目在可视区上方时,向上滚到刚好露出", () => {
    // 条目上边界在可视区上方 40px:向上滚 40px 后它的上边界正好贴着上边界。
    expect(minimalFollowScrollTop({ ...base, scrollTop: 200, itemTop: 60, itemBottom: 100 })).toBe(160);
    // 只露出一半也一样对齐上边界,不做多余滚动。
    expect(minimalFollowScrollTop({ ...base, scrollTop: 200, itemTop: 40, itemBottom: 120 })).toBe(140);
  });

  it("选中条目在可视区下方时,向下滚到刚好露出", () => {
    // 条目下边界在可视区下方 25px:向下滚 25px 后它的下边界正好贴着下边界。
    expect(minimalFollowScrollTop({ ...base, itemTop: 300, itemBottom: 325 })).toBe(25);
  });

  it("不会滚出容器允许的范围", () => {
    // 已经在底部时不再往下滚。
    expect(
      minimalFollowScrollTop({
        ...base,
        scrollTop: 1000,
        maxScrollTop: 1000,
        itemTop: 300,
        itemBottom: 340,
      }),
    ).toBeNull();
    // 往上滚不会算出负的 scrollTop。
    expect(
      minimalFollowScrollTop({
        ...base,
        scrollTop: 10,
        itemTop: 0,
        itemBottom: 40,
      }),
    ).toBe(0);
  });
});
