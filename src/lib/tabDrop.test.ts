import { afterEach, describe, expect, it } from "vitest";

import { measureInsertion } from "./tabDrop";

/**
 * jsdom 不做布局,getBoundingClientRect 全是 0。这里按给定坐标桩出来:
 * 标签栏左边缘 0,每个标签宽 100,依次排开。
 */
function mountStrip(widths: number[]): void {
  document.body.innerHTML = `<div data-tab-strip></div>`;
  const strip = document.querySelector("[data-tab-strip]") as HTMLElement;
  let cursor = 0;
  widths.forEach((width, i) => {
    const tab = document.createElement("div");
    tab.dataset.tabId = `tab-${i}`;
    strip.appendChild(tab);
    // 闭包捕获当次的左边缘:cursor 是会继续变的,不能直接引用。
    // 浏览器里标签随横向滚动一起平移,桩也要跟着减 scrollLeft。
    const at = cursor;
    tab.getBoundingClientRect = () => ({
      left: at - strip.scrollLeft,
      right: at + width - strip.scrollLeft,
      width,
      top: 0,
      bottom: 30,
    }) as DOMRect;
    cursor += width;
  });
  strip.scrollLeft = 0;
  strip.getBoundingClientRect = () =>
    ({ left: 0, right: cursor, width: cursor, top: 0, bottom: 30 }) as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("拖进来的标签插在哪", () => {
  it("落在某个标签左半边就插它前面", () => {
    mountStrip([100, 100, 100]);
    expect(measureInsertion(10)).toEqual({ index: 0, x: 0 });
    expect(measureInsertion(120)).toEqual({ index: 1, x: 100 });
  });

  it("落在某个标签右半边就排它后面(中线归后一个)", () => {
    mountStrip([100, 100, 100]);
    expect(measureInsertion(150)).toEqual({ index: 2, x: 200 });
    expect(measureInsertion(299)).toEqual({ index: 3, x: 300 });
  });

  it("全在右边就追加到末尾,插入线落在最后一个标签的右边缘", () => {
    mountStrip([100, 100]);
    expect(measureInsertion(1000)).toEqual({ index: 2, x: 200 });
  });

  it("标签栏横向滚动后,插入线跟着内容走而不是视口", () => {
    mountStrip([100, 100, 100]);
    const strip = document.querySelector("[data-tab-strip]") as HTMLElement;
    strip.scrollLeft = 120;

    // 视口 x=0 是内容 x=120:第一个标签的右半边,所以排在它后面,插入线在内容 x=100。
    expect(measureInsertion(0)).toEqual({ index: 1, x: 100 });
    // 视口 x=100 是内容 x=220:最后一个标签的左半边,插到它前面。
    expect(measureInsertion(100)).toEqual({ index: 2, x: 200 });
  });

  it("没有标签栏(窗口停在首页)时没有插入位,落点退回追加", () => {
    document.body.innerHTML = "";
    expect(measureInsertion(120)).toBeNull();
  });

  it("标签栏里一个标签都没有时,插入位就是 0", () => {
    mountStrip([]);
    expect(measureInsertion(120)).toEqual({ index: 0, x: 0 });
  });
});
