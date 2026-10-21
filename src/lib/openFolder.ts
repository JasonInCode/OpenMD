import { useTabs } from "../stores/tabs";
import { useWorkspace } from "../stores/workspace";
import { openFolderWindow } from "../tauri/api";

/**
 * 在当前窗口把文件夹开成工作区,并直接进它的第一篇文档。
 *
 * 只有「打开文件夹时新建的那扇窗口」走这里:那扇窗口就是为这个文件夹而生的。
 * 用户主动打开文件夹时一律走 [`openFolderInNewWindow`]。
 */
export async function openFolderAsWorkspace(path: string): Promise<void> {
  if (!path) return;
  const { firstDoc } = await useWorkspace.getState().openFolder(path);
  if (firstDoc) await useTabs.getState().openPath(firstDoc);
}

/**
 * 新建一扇独立窗口打开文件夹:文件夹在窗口里成为工作区。
 *
 * 文件开在当前窗口,文件夹有自己的窗口 —— 两类内容的生命周期互不打扰:
 * 关掉文件夹窗口不影响正在读的文档,反之亦然。
 */
export async function openFolderInNewWindow(path: string): Promise<void> {
  if (!path) return;
  await openFolderWindow(path);
}
