use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Which files are watched, and how many of them share each parent directory.
///
/// Pure bookkeeping, kept apart from `notify` so the reference-count rules are
/// unit-testable: a directory starts being watched when its first file is
/// added and stops when its last file is removed.
///
/// The unit of counting is (window, file), not just file: the same document
/// can be open in two windows, and whoever closes their tab first must not cut
/// the other window off from disk-change refreshes.
#[derive(Default)]
pub struct WatchSet {
    files: HashSet<(String, PathBuf)>,
    dirs: HashMap<PathBuf, usize>,
}

impl WatchSet {
    /// Add a file for one window. Returns the parent directory if it must now
    /// start being watched (this is its first file). Adding the same file for
    /// the same window twice is a no-op.
    pub fn add(&mut self, window: &str, file: PathBuf) -> Option<PathBuf> {
        let dir = file.parent()?.to_path_buf();
        if !self.files.insert((window.to_string(), file)) {
            return None;
        }
        let count = self.dirs.entry(dir.clone()).or_insert(0);
        *count += 1;
        (*count == 1).then_some(dir)
    }

    /// Remove one window's interest in a file. Returns the parent directory if
    /// it can now stop being watched (this was its last reference). Removing an
    /// unknown pair is a no-op.
    pub fn remove(&mut self, window: &str, file: &Path) -> Option<PathBuf> {
        if !self.files.remove(&(window.to_string(), file.to_path_buf())) {
            return None;
        }
        let dir = file.parent()?.to_path_buf();
        match self.dirs.get_mut(&dir) {
            Some(count) if *count > 1 => {
                *count -= 1;
                None
            }
            Some(_) => {
                self.dirs.remove(&dir);
                Some(dir)
            }
            None => None,
        }
    }

    /// Every window watching `file`, each paired with the path its own frontend
    /// handed us — the value we emit back, so it round-trips exactly per window.
    pub fn watchers(&self, file: &Path) -> Vec<(String, PathBuf)> {
        self.files
            .iter()
            .filter(|(_, watched)| watched == file)
            .map(|(window, watched)| (window.clone(), watched.clone()))
            .collect()
    }

    /// Drop every file one window was watching; returns the directories that
    /// lost their last reference. Used when the window itself goes away.
    pub fn remove_window(&mut self, window: &str) -> Vec<PathBuf> {
        let dropped: Vec<PathBuf> = self
            .files
            .iter()
            .filter(|(label, _)| label == window)
            .map(|(_, file)| file.clone())
            .collect();
        let mut released = Vec::new();
        for file in dropped {
            if let Some(dir) = self.remove(window, &file) {
                released.push(dir);
            }
        }
        released
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn clear(&mut self) {
        self.files.clear();
        self.dirs.clear();
    }
}

type FsDebouncer = Debouncer<notify::RecommendedWatcher>;

/// One debouncer for the whole app, created on the first watched file and
/// dropped when the last one goes, watching each parent directory once no
/// matter how many open tabs live in it. Watching the directory rather than
/// the file survives atomic saves (write temp + rename), which is how most
/// editors save.
pub struct WatcherState {
    debouncer: Mutex<Option<FsDebouncer>>,
    set: Arc<Mutex<WatchSet>>,
    /// 每个窗口的工作区目录递归监听(侧栏目录树)。与上面的逐文件 `set` 相互
    /// 独立:打开的标签走自己的 `file-changed`,这里的走 `workspace-changed`。
    /// 按窗口分开,否则一个窗口打开文件夹会顶掉另一个窗口正在监听的根目录。
    workspace: Mutex<HashMap<String, (PathBuf, FsDebouncer)>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            debouncer: Mutex::new(None),
            set: Arc::new(Mutex::new(WatchSet::default())),
            workspace: Mutex::new(HashMap::new()),
        }
    }
}

fn make_debouncer(app: &AppHandle, set: Arc<Mutex<WatchSet>>) -> Result<FsDebouncer, String> {
    let app_handle = app.clone();
    new_debouncer(
        Duration::from_millis(500),
        move |res: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| match res {
            Ok(events) => {
                for event in events {
                    if event.kind != DebouncedEventKind::Any {
                        continue;
                    }
                    // Only files an open tab asked for; everything else in the
                    // directory is noise. Each window that asked gets its own
                    // event, with the path spelling it used.
                    let hits = set.lock().ok().map(|s| s.watchers(&event.path));
                    for (window, path) in hits.unwrap_or_default() {
                        let _ = app_handle.emit_to(
                            &window,
                            "file-changed",
                            serde_json::json!({ "path": path.to_string_lossy() }),
                        );
                    }
                }
            }
            Err(e) => eprintln!("Watch error: {:?}", e),
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))
}

/// Start delivering `file-changed` events for `path`. Safe to call for a file
/// that is already watched.
#[tauri::command]
pub fn watch_file(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let label = window.label().to_string();
    let mut debouncer = state.debouncer.lock().map_err(|e| e.to_string())?;
    let file = PathBuf::from(&path);
    let new_dir = state
        .set
        .lock()
        .map_err(|e| e.to_string())?
        .add(&label, file.clone());
    if let Some(dir) = new_dir {
        if debouncer.is_none() {
            *debouncer = Some(make_debouncer(&app, Arc::clone(&state.set))?);
        }
        let result = debouncer
            .as_mut()
            .expect("debouncer was just created")
            .watcher()
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch directory: {}", e));
        if result.is_err() {
            // Roll the bookkeeping back so a retry starts clean.
            if let Ok(mut set) = state.set.lock() {
                set.remove(&label, &file);
            }
            result?;
        }
    }
    Ok(())
}

/// Stop delivering events for `path`; the directory watch goes when its last
/// file does, and the debouncer (a thread plus OS handles) goes with the last
/// directory.
#[tauri::command]
pub fn unwatch_file(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let label = window.label().to_string();
    let mut debouncer = state.debouncer.lock().map_err(|e| e.to_string())?;
    let (gone_dir, empty) = {
        let mut set = state.set.lock().map_err(|e| e.to_string())?;
        let gone = set.remove(&label, Path::new(&path));
        (gone, set.is_empty())
    };
    if let (Some(dir), Some(d)) = (gone_dir, debouncer.as_mut()) {
        let _ = d.watcher().unwatch(&dir);
    }
    if empty {
        *debouncer = None;
    }
    Ok(())
}

/// Drop every watch. Used at shutdown of the frontend listener.
#[tauri::command]
pub fn stop_watching(app: AppHandle) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut debouncer = state.debouncer.lock().map_err(|e| e.to_string())?;
    state.set.lock().map_err(|e| e.to_string())?.clear();
    *debouncer = None;
    Ok(())
}

// ---- 工作区(文件夹工作区侧栏的整棵递归监听) ----

/// Whether a change is interesting for the workspace tree: under the root and
/// either a readable text document or a directory / extension-less path.
/// Directory *creates* answer `is_dir`, but *removes* no longer do — the
/// extension-less fallback keeps folder deletions visible. Pure so it can be
/// tested without an app handle.
pub(crate) fn workspace_event_relevant(root: &Path, path: &Path) -> bool {
    if !path.starts_with(root) {
        return false;
    }
    if path.is_dir() || path.extension().is_none() {
        return true;
    }
    crate::commands::has_allowed_extension(path)
}

fn make_workspace_debouncer(
    root: PathBuf,
    label: String,
    app: &AppHandle,
) -> Result<FsDebouncer, String> {
    let app_handle = app.clone();
    new_debouncer(
        Duration::from_millis(500),
        move |res: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| match res {
            Ok(events) => {
                for event in events {
                    if event.kind != DebouncedEventKind::Any {
                        continue;
                    }
                    if workspace_event_relevant(&root, &event.path) {
                        let _ = app_handle.emit_to(
                            &label,
                            "workspace-changed",
                            serde_json::json!({
                                "root": root.to_string_lossy(),
                                "path": event.path.to_string_lossy(),
                            }),
                        );
                    }
                }
            }
            Err(e) => eprintln!("Workspace watch error: {:?}", e),
        },
    )
    .map_err(|e| format!("Failed to create workspace watcher: {}", e))
}

/// Start delivering `workspace-changed` events to this window for everything
/// under `path` (recursive). One workspace per window — watching a new root
/// replaces that window's old watch; re-watching the same root is a no-op.
#[tauri::command]
pub fn watch_workspace(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let label = window.label().to_string();
    let mut slot = state.workspace.lock().map_err(|e| e.to_string())?;
    let root = PathBuf::from(&path);
    if let Some((existing, _)) = slot.get(&label) {
        if *existing == root {
            return Ok(());
        }
    }
    let mut debouncer = make_workspace_debouncer(root.clone(), label.clone(), &app)?;
    debouncer
        .watcher()
        .watch(&root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch workspace: {}", e))?;
    slot.insert(label, (root, debouncer));
    Ok(())
}

/// Stop this window's workspace watch (workspace closed / replaced). No-op when
/// a different root is watched, so a stale late call can't kill a live watch.
#[tauri::command]
pub fn unwatch_workspace(app: AppHandle, window: WebviewWindow, path: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut slot = state.workspace.lock().map_err(|e| e.to_string())?;
    if let Some((existing, _)) = slot.get(window.label()) {
        if *existing == PathBuf::from(&path) {
            // Debouncer dropped → unwatch + its thread released.
            slot.remove(window.label());
        }
    }
    Ok(())
}

/// 窗口没了(关掉或被销毁)时把它名下的监听一次性销掉。标签与工作区的账都是
/// 按窗口记的,窗口没了账就得销,不然目录监听会一直挂着空转。
pub fn release_window(app: &AppHandle, label: &str) {
    let state = app.state::<WatcherState>();
    let Ok(mut debouncer) = state.debouncer.lock() else { return };
    let (gone_dirs, empty) = {
        let Ok(mut set) = state.set.lock() else { return };
        let gone_dirs = set.remove_window(label);
        let empty = set.is_empty();
        (gone_dirs, empty)
    };
    if let Some(d) = debouncer.as_mut() {
        for dir in gone_dirs {
            let _ = d.watcher().unwatch(&dir);
        }
    }
    if empty {
        *debouncer = None;
    }
    // 必须以语句结尾:作为 tail expression 时 MutexGuard 的析构会晚于 state,
    // 借用不成立(与业务无关,纯粹是临时量的生命周期)。
    if let Ok(mut slot) = state.workspace.lock() {
        slot.remove(label);
    };
}

#[cfg(test)]
mod tests {
    use super::{WatchSet, workspace_event_relevant};
    use std::path::{Path, PathBuf};

    // 用 POSIX 绝对路径而不是字面量 "C:\\docs\\a.md"：Windows 路径在 Unix 上
    // 没有分隔符，`Path::parent()` 会返回 `Some("")`，断言必然失败。WatchSet
    // 的逻辑只依赖 parent()/相等比较，与平台无关，所以这些用例本身就应当是
    // 平台中立的。
    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn first_file_in_a_directory_starts_the_watch_and_the_last_stops_it() {
        let mut set = WatchSet::default();
        assert_eq!(set.add("main", p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add("main", p("/docs/b.md")), None, "second file in the same dir reuses the watch");
        assert_eq!(set.remove("main", Path::new("/docs/a.md")), None, "one file still needs the dir");
        assert_eq!(set.remove("main", Path::new("/docs/b.md")), Some(p("/docs")));
        assert!(set.is_empty());
    }

    #[test]
    fn directories_are_counted_independently() {
        let mut set = WatchSet::default();
        assert_eq!(set.add("main", p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add("main", p("/notes/n.md")), Some(p("/notes")));
        assert_eq!(set.remove("main", Path::new("/docs/a.md")), Some(p("/docs")));
        assert!(!set.is_empty());
        assert!(!set.watchers(Path::new("/notes/n.md")).is_empty());
    }

    #[test]
    fn adding_twice_and_removing_the_unknown_are_no_ops() {
        let mut set = WatchSet::default();
        assert_eq!(set.add("main", p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add("main", p("/docs/a.md")), None);
        // Still exactly one reference: removing it releases the directory.
        assert_eq!(set.remove("main", Path::new("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.remove("main", Path::new("/docs/never.md")), None);
        assert_eq!(set.remove("main", Path::new("/docs/a.md")), None);
    }

    #[test]
    fn only_watched_files_match_and_each_window_gets_its_own_path() {
        let mut set = WatchSet::default();
        set.add("main", p("/docs/a.md"));
        set.add("main", p("/docs/other.md"));

        let watchers = set.watchers(Path::new("/docs/a.md"));
        assert_eq!(watchers, vec![("main".to_string(), p("/docs/a.md"))]);
        assert!(set.watchers(Path::new("/docs/sibling.md")).is_empty(), "a sibling's change is noise");
        set.clear();
        assert!(set.is_empty());
        assert!(set.watchers(Path::new("/docs/a.md")).is_empty());
    }

    #[test]
    fn one_window_closing_a_file_leaves_the_other_window_watching() {
        // 同一个文档在两个窗口里打开:先关标签的那个不能把另一个窗口的
        // 磁盘变更刷新一起关掉。
        let mut set = WatchSet::default();
        assert_eq!(set.add("main", p("/docs/a.md")), Some(p("/docs")));
        assert_eq!(set.add("tab-win-1", p("/docs/a.md")), None, "目录已被另一个窗口监听着");

        assert_eq!(set.remove("main", Path::new("/docs/a.md")), None, "另一个窗口还要这个目录");
        assert_eq!(
            set.watchers(Path::new("/docs/a.md")),
            vec![("tab-win-1".to_string(), p("/docs/a.md"))]
        );

        assert_eq!(set.remove("tab-win-1", Path::new("/docs/a.md")), Some(p("/docs")));
        assert!(set.is_empty());
    }

    #[test]
    fn a_closing_window_takes_all_its_watches_with_it() {
        let mut set = WatchSet::default();
        set.add("main", p("/docs/a.md"));
        set.add("tab-win-1", p("/docs/a.md"));
        set.add("tab-win-1", p("/notes/b.md"));

        let released = set.remove_window("tab-win-1");

        // /notes 归零可以停,/docs 还有主窗口看着。
        assert_eq!(released, vec![p("/notes")]);
        assert_eq!(
            set.watchers(Path::new("/docs/a.md")),
            vec![("main".to_string(), p("/docs/a.md"))]
        );
        assert!(set.watchers(Path::new("/notes/b.md")).is_empty());
        assert!(!set.is_empty());

        assert_eq!(set.remove_window("main"), vec![p("/docs")]);
        assert!(set.is_empty());
    }

    #[test]
    fn workspace_events_are_bounded_to_documents_and_dirs_under_the_root() {
        let root = Path::new("/ws");
        for hit in [
            "/ws/a.md",
            "/ws/deep/nested/a.markdown",
            "/ws/notes.txt",
            "/ws/sub",      // 无扩展名:目录创建/删除都靠它进树
            "/ws/a.MD",     // 扩展名大小写不敏感
            "/ws",          // root 自身事件 → 整树刷新,无害
            "/ws/Makefile", // 无扩展名文件改动也会刷新树,幂等无害
        ] {
            assert!(workspace_event_relevant(root, Path::new(hit)), "{hit} should be relevant");
        }
        for miss in [
            "/ws/pic.png",
            "/ws/script.exe",
            "/ws2/a.md", // 前缀同串但不是同一目录
            "/other/a.md",
        ] {
            assert!(!workspace_event_relevant(root, Path::new(miss)), "{miss} should be noise");
        }
    }

    #[test]
    fn the_workspace_prefix_boundary_is_component_wise() {
        // "/ws2" must not count as inside "/ws", while "/ws/sub" must.
        assert!(!workspace_event_relevant(Path::new("/ws"), Path::new("/ws2/sub/a.md")));
        assert!(workspace_event_relevant(Path::new("/ws"), Path::new("/ws/sub/a.md")));
    }
}
