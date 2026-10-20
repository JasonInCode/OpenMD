import type { PointerEvent as ReactPointerEvent } from "react";
import { beginTabDrag, endTabDrag, type TabPayload } from "../tauri/api";
import { useTabs, type Tab } from "../stores/tabs";

/**
 * 把标签拖出当前窗口生成独立窗口(或拖回别的窗口合并)。
 *
 * 拖拽循环本身在 Rust 侧(它才有全局光标与各窗口矩形),前端只负责三件事:
 * 判定"这是一次拖拽而不是点选"、按下瞬间告诉 Rust 抓取点在哪、松手时结算。
 */

/** 超过这个位移才算拖拽,否则只是点选标签。 */
const DRAG_THRESHOLD = 8;

interface Pressed {
  tab: Tab;
  startX: number;
  startY: number;
  /** 抓取点在标签内的偏移(CSS 像素)。 */
  grabX: number;
  grabY: number;
  width: number;
}

let pressed: Pressed | null = null;
let dragging = false;

/** 标签被按下:记下抓取点,位移越过阈值才升级成拖拽。 */
export function startPress(tab: Tab, e: ReactPointerEvent<HTMLElement>): void {
  if (e.button !== 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  pressed = {
    tab,
    startX: e.clientX,
    startY: e.clientY,
    grabX: e.clientX - rect.left,
    grabY: e.clientY - rect.top,
    width: rect.width,
  };
}

export function trackDrag(e: ReactPointerEvent<HTMLElement>): void {
  if (dragging || !pressed) return;
  if (Math.hypot(e.clientX - pressed.startX, e.clientY - pressed.startY) < DRAG_THRESHOLD) {
    return;
  }
  const { tab, grabX, grabY, width } = pressed;
  pressed = null;
  dragging = true;
  // 收尾监听先挂上再 await:用户松手可能比建窗的 IPC 往返还快,挂晚了这一场
  // 拖拽就没有人结算了。
  window.addEventListener("pointerup", settle, { once: true });
  window.addEventListener("pointercancel", settle, { once: true });
  void beginDrag(tab, grabX, grabY, width);
}

/**
 * 芯片窗口的兜底收尾:指针捕获万一在某个平台上没生效,松手事件会落到芯片窗口
 * 上。同一个命令是幂等的,谁先到谁算数,不会重复结算。
 */
export function watchChipDrag(): () => void {
  window.addEventListener("pointerup", settle);
  window.addEventListener("pointerdown", settle);
  return () => {
    window.removeEventListener("pointerup", settle);
    window.removeEventListener("pointerdown", settle);
  };
}

async function beginDrag(tab: Tab, grabX: number, grabY: number, width: number): Promise<void> {
  try {
    await beginTabDrag(toPayload(tab), grabX, grabY, width);
    // 芯片窗口接住了这个标签,本窗口就别再留着了(拖回原窗口 = 合并回来)。
    useTabs.getState().removeTab(tab.id);
  } catch (e) {
    console.error("拆分标签失败:", e);
  }
}

function settle(): void {
  window.removeEventListener("pointercancel", settle);
  if (!dragging) return;
  dragging = false;
  void endTabDrag();
}

function toPayload(tab: Tab): TabPayload {
  const { id: _id, ...rest } = tab;
  return rest;
}
