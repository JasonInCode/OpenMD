import { onTabDragHover, onTabDragHoverEnd } from "../tauri/api";
/**
 * 别的窗口拖标签过来时,本窗口要做的事:把自己的标签栏量一下,得出插入位。
 *
 * 落点判定整个在 Rust 侧做(它才有全局光标与各窗口矩形),本窗口只负责按给到
 * 的横坐标算出"插在第几个标签之前"和"插入线画在哪"。
 */

export interface Insertion {
  /** 插到第几个标签之前;末尾即 tabs.length。 */
  index: number;
  /** 插入线在标签栏内容坐标系里的横坐标(CSS 像素)。 */
  x: number;
}

/**
 * 按光标横坐标算插入位:落在某个标签左半边就插它前面,否则往后排;
 * 都在右边就追加到末尾。没有标签栏(窗口停在首页)时返回 null。
 */
export function measureInsertion(clientX: number): Insertion | null {
  const strip = document.querySelector<HTMLElement>("[data-tab-strip]");
  if (!strip) return null;
  // 标签栏可以横向滚动:光标给的是窗口坐标,标签位置量的是视口坐标,
  // 两者都要换算到同一套内容坐标(内容原点 = 视口原点 - scrollLeft)。
  const stripLeft = strip.getBoundingClientRect().left - strip.scrollLeft;
  const contentX = clientX - stripLeft;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
  let index = tabs.length;
  let x = tabs.length
    ? tabs[tabs.length - 1].getBoundingClientRect().right - stripLeft
    : 0;
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    const left = rect.left - stripLeft;
    if (contentX < left + rect.width / 2) {
      index = i;
      x = left;
      break;
    }
  }
  return { index, x };
}

/**
 * 监听别扇窗口的拖拽悬停,把插入线画在标签栏里。返回取消监听的函数。
 *
 * 组件自己订阅而不是挂在 store 上:插入线是纯渲染状态,不参与标签数据流。
 */
export function watchTabDropHover(onChange: (insertion: Insertion | null) => void): () => void {
  const offHover = onTabDragHover(({ x }) => onChange(measureInsertion(x)));
  const offEnd = onTabDragHoverEnd(() => onChange(null));
  return () => {
    offHover.then((fn) => fn()).catch(() => {});
    offEnd.then((fn) => fn()).catch(() => {});
  };
}
