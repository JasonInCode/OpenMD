import { getCurrentWindow } from "@tauri-apps/api/window";
import { IN_TAURI } from "../utils/platform";

/**
 * 当前窗口的 label。主窗口是 tauri.conf.json 里声明的 `main`,其余 label 由
 * Rust 侧拖标签时生成(`tab-win-N`)。浏览器预览环境没有窗口概念,一律当主窗口。
 */
export const WINDOW_LABEL = IN_TAURI ? getCurrentWindow().label : "main";

/**
 * 主窗口是应用的锚:标签关光后停在首页。其余窗口是拖标签拖出来的,标签关光
 * 就该跟着关掉 —— 否则会留下一扇点不掉的空壳窗口。
 */
export const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

/**
 * 真正关掉当前窗口。走 `destroy()` 而不是 `close()`:Rust 侧在 CloseRequested
 * 里拦了一道(主窗口要问"隐藏到托盘还是退出",拆分窗口要问"未保存怎么处置"),
 * 再调 `close()` 会再触发一次,自激。
 */
export function closeWindow(): void {
  if (!IN_TAURI) return;
  void getCurrentWindow()
    .destroy()
    .catch((e) => console.error("关闭窗口失败:", e));
}
