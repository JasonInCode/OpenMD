/**
 * 目录栏跟随选中条目的滚动计算。
 *
 * 语义:选中条目已经在目录可视区内就不动;否则只滚动刚好让它露出的距离
 * (mkdocs-material 的 toc.follow、VS Code 大纲的 minimal reveal 同款)。
 */

/** 几何输入,坐标与 getBoundingClientRect 同系(视口坐标)。 */
export interface FollowGeometry {
  /** 目录滚动容器可视区上边界。 */
  viewTop: number;
  /** 目录滚动容器可视区下边界。 */
  viewBottom: number;
  /** 选中条目上边界。 */
  itemTop: number;
  /** 选中条目下边界。 */
  itemBottom: number;
  /** 容器当前 scrollTop。 */
  scrollTop: number;
  /** 容器 scrollTop 上限(scrollHeight - clientHeight)。 */
  maxScrollTop: number;
}

/** 返回新的 scrollTop;选中条目已可见时返回 null。 */
export function minimalFollowScrollTop(g: FollowGeometry): number | null {
  let next: number;
  if (g.itemTop < g.viewTop) {
    next = g.scrollTop - (g.viewTop - g.itemTop);
  } else if (g.itemBottom > g.viewBottom) {
    next = g.scrollTop + (g.itemBottom - g.viewBottom);
  } else {
    return null;
  }
  next = Math.min(Math.max(next, 0), Math.max(g.maxScrollTop, 0));
  return Math.abs(next - g.scrollTop) < 1 ? null : next;
}

/** 按 id 找目录条目(条目上带 data-toc-id)。 */
export function findTocItem(container: HTMLElement, id: string): HTMLElement | null {
  const items = container.querySelectorAll<HTMLElement>("[data-toc-id]");
  for (const item of Array.from(items)) {
    if (item.dataset.tocId === id) return item;
  }
  return null;
}

/**
 * 把选中条目滚进目录可视区,返回实际写入的 scrollTop;
 * 条目不可见或找不到条目时返回 null。
 */
export function followTocItem(container: HTMLElement, item: HTMLElement | null): number | null {
  if (!item) return null;
  const view = container.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  // 可视区取内容区(去掉容器自身的 padding):条目贴到内容区边缘即算完整可见。
  const style = getComputedStyle(container);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padBottom = Number.parseFloat(style.paddingBottom) || 0;
  const viewTop = view.top + container.clientTop + padTop;
  const viewBottom = viewTop + Math.max(container.clientHeight - padTop - padBottom, 0);
  const next = minimalFollowScrollTop({
    viewTop,
    viewBottom,
    itemTop: rect.top,
    itemBottom: rect.bottom,
    scrollTop: container.scrollTop,
    maxScrollTop: container.scrollHeight - container.clientHeight,
  });
  if (next === null) return null;
  container.scrollTop = next;
  return next;
}
