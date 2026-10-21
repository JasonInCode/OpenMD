import { useSettings } from "../stores/settings";
import { useTabs } from "../stores/tabs";

/**
 * Open Markdown files that did not come from the workspace tree.
 *
 * Standalone documents should show their table of contents in the sidebar.
 * Files opened from the tree keep using `openPath` directly so that clicking a
 * nested file does not replace the current workspace.
 */
export async function openStandaloneFiles(paths: readonly string[]): Promise<void> {
  const files = paths.filter(Boolean);
  if (files.length === 0) return;

  const settings = useSettings.getState();
  // 单篇文档没有工作区树可看,目录栏是唯一的导航,打开时确保它在。
  if (!settings.tocOpen) settings.toggleToc();

  for (const path of files) {
    await useTabs.getState().openPath(path);
  }
}
