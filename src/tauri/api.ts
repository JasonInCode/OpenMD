import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { WINDOW_LABEL } from "../lib/window";

export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd"];

export async function readMarkdownFile(path: string): Promise<string> {
  return invoke("read_markdown_file", { path });
}

/** Persist edited markdown content back to the file (edit mode's save). */
export async function writeMarkdownFile(path: string, content: string): Promise<void> {
  return invoke("write_markdown_file", { path, content });
}

export async function resolvePath(path: string): Promise<string> {
  return invoke("resolve_path", { path });
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke("path_exists", { path });
}

/** Allow the webview to fetch these images via the asset protocol. */
export async function allowAssets(documentPath: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  return invoke("allow_assets", { documentPath, paths });
}

export interface ImportedImage {
  /** Absolute path of the image on disk (for the asset protocol). */
  abs: string;
  /** Markdown-relative path from the document's directory, `/`-separated. */
  rel: string;
}

/**
 * Bring a picked image beside the document and return the path to reference it
 * by. An image already inside the document's directory is referenced in place;
 * anything else is copied into a `docs/` folder created next to the document.
 */
export async function importImage(
  documentPath: string,
  sourcePath: string,
): Promise<ImportedImage> {
  return invoke("import_image", { documentPath, sourcePath });
}

export async function watchFile(path: string): Promise<void> {
  return invoke("watch_file", { path });
}

export async function unwatchFile(path: string): Promise<void> {
  return invoke("unwatch_file", { path });
}

export interface FileChangedPayload {
  path: string;
}

// ---- 标签拖拽:拆分与合并 ----
/** 标签跨窗口搬运的载荷,与 Rust 侧 TabPayload 一一对应。 */
export interface TabPayload {
  path: string;
  name: string;
  content: string;
  draft: string | null;
  lastSavedAt: number;
  diskChanged: boolean;
  scrollY: number;
  error: string | null;
}

/** 新窗口启动时取走分配给自己的标签。 */
export interface PendingTab {
  tab: TabPayload;
  /** true = 这扇窗口当前还是拖拽中的芯片窗口,只渲染一枚标签。 */
  ghost: boolean;
}

export async function takePendingTab(): Promise<PendingTab | null> {
  return invoke("take_pending_tabs");
}

/**
 * 开始一次拖拽:建出跟手光标的芯片窗口,并接管跟手与落点判定。
 *
 * `grabX` / `grabY` 是抓取点在标签内的偏移(CSS 像素),`tabWidth` 是标签宽度 ——
 * 芯片窗口照着做,拖起来才像手里捏着这一枚标签。返回芯片窗口的 label。
 */
export async function beginTabDrag(
  tab: TabPayload,
  grabX: number,
  grabY: number,
  tabWidth: number,
): Promise<string> {
  return invoke("begin_tab_drag", { tab, grabX, grabY, tabWidth });
}

/**
 * 结束拖拽:落到某个窗口就合并过去,否则让芯片窗口长成独立窗口。幂等 ——
 * 源窗口与芯片窗口谁先收到 pointerup 都调它,只生效一次。
 */
export async function endTabDrag(): Promise<void> {
  return invoke("end_tab_drag");
}

export interface TabDropPayload {
  tab: TabPayload;
  /** 落点在本窗口内的横坐标(CSS 像素),插入位由本窗口自己算。 */
  x: number;
}

/** 别扇窗口拖过来的标签:按落点位置插进标签栏。 */
export function onTabDrop(handler: (payload: TabDropPayload) => void) {
  return listen<TabDropPayload>("tab-drop", (event) => handler(event.payload), {
    target: WINDOW_LABEL,
  }).catch(() => () => {});
}

/** 别扇窗口的标签正悬在本窗口上,x 是光标在本窗口内的横坐标(CSS 像素)。 */
export function onTabDragHover(handler: (payload: { x: number }) => void) {
  return listen<{ x: number }>("tab-drag-hover", (event) => handler(event.payload), {
    target: WINDOW_LABEL,
  }).catch(() => () => {});
}

/** 别扇窗口的标签离开了本窗口:撤掉插入线。 */
export function onTabDragHoverEnd(handler: () => void) {
  return listen("tab-drag-hover-end", () => handler(), { target: WINDOW_LABEL }).catch(
    () => () => {},
  );
}

/** 芯片窗口落定:该把芯片换成完整界面了。 */
export function onTabDragSettled(handler: () => void) {
  return listen("tab-drag-settled", () => handler(), { target: WINDOW_LABEL }).catch(
    () => () => {},
  );
}

export function onFileChanged(handler: (payload: FileChangedPayload) => void) {
  // 浏览器预览环境没有事件系统,降级为空监听。
  return listen<FileChangedPayload>("file-changed", (event) => handler(event.payload), {
    target: WINDOW_LABEL,
  }).catch(() => () => {});
}

/**
 * Rust 敲门前端来取队列。事件不带路径:打开请求可能早于 webview 就绪到达,
 * 而 Tauri 在没有 JS 监听器的 webview 上会静默跳过投递,只有队列里的路径是
 * 可靠的,所以回调里必须去 `getOpenedPaths` 取。
 */
export function onOpenedFiles(handler: () => void) {
  return listen("opened-files", () => handler(), { target: WINDOW_LABEL }).catch((e) => {
    void logAssoc(`listen opened-files FAILED: ${e}`);
    return () => {};
  });
}

/** 文件夹右键菜单的敲门。与 `opened-files` 同理不带路径,路径同样只认队列。 */
export function onOpenedFolders(handler: () => void) {
  return listen("opened-folders", () => handler(), { target: WINDOW_LABEL }).catch((e) => {
    void logAssoc(`listen opened-folders FAILED: ${e}`);
    return () => {};
  });
}

/** OS 在 webview 就绪前交过来的路径,按类型分开。 */
export interface OpenedPaths {
  files: string[];
  folders: string[];
}

/** 取走 Rust 侧积压的打开请求(启动时取一次,之后每次被敲门都取)。 */
export async function getOpenedPaths(): Promise<OpenedPaths> {
  return invoke("get_opened_paths");
}

/** Native open-file dialog. Returns absolute paths, or null on cancel. */
export async function openFileDialog(): Promise<string[] | null> {
  return open({
    multiple: true,
    title: "打开 Markdown 文件",
    filters: [{ name: "Markdown", extensions: MARKDOWN_EXTENSIONS }],
  });
}

/** Native folder picker for the workspace sidebar. Returns one absolute path. */
export async function openFolderDialog(): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "选择工作区文件夹",
  });
  if (Array.isArray(picked)) return picked[0] ?? null;
  return picked;
}

// ---- 文件夹工作区 ----

/**
 * 新建一扇独立窗口打开文件夹:文件夹在窗口里成为工作区。
 * 与「打开文件」不同,文件开在当前窗口,文件夹有自己的窗口。
 */
export async function openFolderWindow(path: string): Promise<void> {
  await invoke("open_folder_window", { path });
}

/** 打开文件夹时新建的窗口启动时取走分配给自己的文件夹;其它窗口返回 null。 */
export async function takePendingFolder(): Promise<string | null> {
  return invoke("take_pending_folder");
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** List one level of the workspace tree (dirs + readable docs, junk skipped). */
export async function listWorkspaceDir(path: string): Promise<WorkspaceEntry[]> {
  return invoke("list_workspace_dir", { path });
}

/** What a whole workspace holds, for the home screen's file browser. */
export interface WorkspaceFiles {
  /** Total readable text documents found under the root (bounded scan). */
  count: number;
  /** Bounded sample of those absolute paths. */
  files: string[];
}

/**
 * Every readable text document under `path`, recursively (bounded depth/count).
 * Optional by design: an app build that predates this command rejects the
 * invoke, and callers must degrade to "count unknown" rather than fail.
 */
export async function listWorkspaceFiles(path: string): Promise<WorkspaceFiles> {
  return invoke("list_workspace_files", { path });
}

export interface WikiResolution {
  path: string | null;
  content: string | null;
  section: string | null;
  matched_by: string;
}

/** Resolve `[[target]]` / `![[target]]` against the workspace root. */
export async function resolveWikiTarget(
  root: string,
  fromPath: string,
  target: string,
): Promise<WikiResolution> {
  return invoke("resolve_wiki_target", { root, fromPath, target });
}

/** Whether a dropped path is a folder (→ open as workspace). */
export async function isDirectory(path: string): Promise<boolean> {
  return invoke("is_directory", { path });
}

export async function watchWorkspace(path: string): Promise<void> {
  return invoke("watch_workspace", { path });
}

export async function unwatchWorkspace(path: string): Promise<void> {
  return invoke("unwatch_workspace", { path });
}

export interface WorkspaceChangedPayload {
  root: string;
  path: string;
}

export function onWorkspaceChanged(handler: (payload: WorkspaceChangedPayload) => void) {
  return listen<WorkspaceChangedPayload>(
    "workspace-changed",
    (event) => handler(event.payload),
    { target: WINDOW_LABEL },
  ).catch(() => () => {});
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"];

/** Native single-image picker for the editor's insert/replace actions. */
export async function openImageDialog(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title: "选择图片",
    filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }],
  });
  if (Array.isArray(picked)) return picked[0] ?? null;
  return picked;
}

// ---- 用其他程序打开(扫描系统里能打开 Markdown 的程序) ----

export interface EditorApp {
  /** 显示名(FriendlyAppName / FriendlyTypeName,兑底 exe 文件名)。 */
  name: string;
  /** 解析出的真实 exe 路径。 */
  exe: string;
  /** exe 图标的 PNG data URL;提取失败为 null(前端回退通用图标)。 */
  icon: string | null;
  /** 系统关联了 .md(或用户最近用它打开过),菜单里排在前面。 */
  recommended: boolean;
}

/** 扫描系统里能打开 Markdown 的程序(.md 关联 + 全部已注册应用)。 */
export async function detectEditors(): Promise<EditorApp[]> {
  return invoke("detect_editors");
}

/** 用选中的程序打开文件。 */
export async function openFileWith(exe: string, path: string): Promise<void> {
  return invoke("open_file_with", { exe, path });
}

// ---- 运行时资源管理器集成(HKCU 注册表:文件关联 + 文件夹右键菜单) ----

export async function isMdAssociated(): Promise<boolean> {
  return invoke("is_md_associated");
}

export async function registerMdAssociation(): Promise<void> {
  return invoke("register_md_association");
}

export async function unregisterMdAssociation(): Promise<void> {
  return invoke("unregister_md_association");
}

/** Whether the folder context menu verb still points at this executable. */
export async function isFolderVerbRegistered(): Promise<boolean> {
  return invoke("is_folder_verb_registered");
}

export async function registerFolderVerb(): Promise<void> {
  return invoke("register_folder_verb");
}

export async function unregisterFolderVerb(): Promise<void> {
  return invoke("unregister_folder_verb");
}

/** 诊断日志(排查双击 .md 打不开) */
export async function logAssoc(message: string): Promise<void> {
  return invoke("log_assoc", { message });
}

