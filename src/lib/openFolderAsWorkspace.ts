import { useTabs } from "../stores/tabs";
import { useWorkspace } from "../stores/workspace";

/**
 * Open a folder as the workspace and land the user in its first document.
 *
 * Every entry point that means "open this folder" (title bar, home page, the
 * Explorer context menu) goes through here so they behave identically: a folder
 * without any document leaves the sidebar tree empty instead of opening a blank
 * preview.
 */
export async function openFolderAsWorkspace(path: string): Promise<void> {
  if (!path) return;
  const { firstDoc } = await useWorkspace.getState().openFolder(path);
  if (firstDoc) await useTabs.getState().openPath(firstDoc);
}
