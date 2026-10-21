mod commands;
mod editors;
mod file_assoc;
mod stats;
mod tab_drag;
mod tray;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 主窗口的 label。系统级入口(文件关联打开、第二实例转发)统一投给它:
/// 其余窗口是拖标签拆出来的,不该被"双击 .md"这类全局动作劫持。
const MAIN_WINDOW: &str = "main";
/// 由 OS 投递的待打开路径:文件关联与文件夹右键菜单都把路径作为裸参数传进来。
/// 这类路径可能早于 webview 就绪到达,因此先缓冲,等前端启动时一次性取走。
/// 按类型分开是因为前端对两者的处理完全不同:文件开成文档标签,文件夹开成工作区。
#[derive(Default)]
pub struct OpenedPaths {
    pub files: Mutex<Vec<String>>,
    pub folders: Mutex<Vec<String>>,
}

/// 启动时一次性取走已缓冲的路径。之后前端改为监听事件。
#[derive(serde::Serialize)]
pub struct OpenedPathsSnapshot {
    pub files: Vec<String>,
    pub folders: Vec<String>,
}

/// 诊断日志:追加到 app_data_dir/assoc-debug.log(排查"双击 .md 打不开"用)
pub fn debug_log(app: &AppHandle, msg: &str) {
    use std::io::Write;
    let Some(dir) = app.path().app_data_dir().ok() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("assoc-debug.log"))
    else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "[{ts}] {msg}");
}

/// 取走全部已缓冲的路径。前端只在启动时调一次,之后靠事件。
#[tauri::command]
fn get_opened_paths(state: tauri::State<'_, OpenedPaths>, app: AppHandle) -> OpenedPathsSnapshot {
    let snapshot = OpenedPathsSnapshot {
        files: drain(&state.files),
        folders: drain(&state.folders),
    };
    debug_log(
        &app,
        &format!(
            "get_opened_paths drained: files={:?} folders={:?}",
            snapshot.files, snapshot.folders
        ),
    );
    snapshot
}

fn drain(paths: &Mutex<Vec<String>>) -> Vec<String> {
    let mut buffered = paths.lock().unwrap();
    std::mem::take(&mut *buffered)
}

/// 缓冲路径并通知前端。一律先缓冲(哪怕 webview 看起来已就绪)才能消除竞态:
/// 早于监听器注册到达的路径,由启动时的 [`get_opened_paths`] 取走。
fn push_opened_paths(app: &AppHandle, files: Vec<String>, folders: Vec<String>) {
    if let Some(state) = app.try_state::<OpenedPaths>() {
        if !files.is_empty() {
            if let Ok(mut buffered) = state.files.lock() {
                buffered.extend(files.clone());
            }
        }
        if !folders.is_empty() {
            if let Ok(mut buffered) = state.folders.lock() {
                buffered.extend(folders.clone());
            }
        }
    }
    if !files.is_empty() {
        emit_opened(app, "opened-files");
    }
    if !folders.is_empty() {
        emit_opened(app, "opened-folders");
    }
}

/// 敲主窗口的门。事件不带路径:Tauri 在没有 JS 监听器的 webview 上会静默
/// 跳过投递(仍返回 Ok),所以路径只留在 [`OpenedPaths`] 队列里,前端每次被
/// 敲门都去 [`get_opened_paths`] 取。丢失一次敲门最多晚一个敲门周期。
/// 只投主窗口:其余窗口是拖标签拆出来的,不该被"双击 .md"这类全局动作劫持。
fn emit_opened(app: &AppHandle, event: &str) {
    match app.emit_to(MAIN_WINDOW, event, ()) {
        Ok(_) => debug_log(app, &format!("emitted {event} OK")),
        Err(e) => debug_log(app, &format!("emitted {event} FAILED: {e}")),
    }
}

/// 是否是 OpenMD 能读的文档:必须是现存的常规文件,且扩展名在白名单内。
fn is_markdown_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                matches!(
                    e.to_ascii_lowercase().as_str(),
                    "md" | "markdown" | "mdown" | "mkd"
                )
            })
            .unwrap_or(false)
}

/// 从 argv 里分拣出要打开的文件与文件夹。两类入口都不带类型标记——文件关联传
/// `"exe" "%1"`,文件夹右键菜单传的也是同一个形状——所以只能按路径本身判断:
/// 目录进 folders,现存的 Markdown 文件进 files,其余(flag、未知扩展名、不存在的
/// 路径)一律丢弃。
fn collect_open_args<I: Iterator<Item = String>>(args: I) -> (Vec<String>, Vec<String>) {
    let mut files = Vec::new();
    let mut folders = Vec::new();
    for arg in args.skip(1).filter(|a| !a.starts_with('-')) {
        let path = if Path::new(&arg).is_absolute() {
            PathBuf::from(arg)
        } else {
            // 把文件拖到 exe 上时有时只给一个裸文件名。
            std::env::current_dir()
                .map(|dir| dir.join(&arg))
                .unwrap_or_else(|_| PathBuf::from(&arg))
        };
        if path.is_dir() {
            folders.push(path.to_string_lossy().into_owned());
        } else if is_markdown_file(&path) {
            files.push(path.to_string_lossy().into_owned());
        }
    }
    (files, folders)
}

/// 隐藏窗口到系统托盘(前端关闭询问对话框选择"隐藏到托盘"时调用)。
#[tauri::command]
fn hide_to_tray(window: WebviewWindow) {
    let _ = window.hide();
}

/// 真正退出程序(托盘菜单"退出"与前端关闭询问对话框选择"退出"共用)。
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let (initial_files, initial_folders) = collect_open_args(std::env::args());

    tauri::Builder::default()
        // 窗口状态插件默认会恢复上次保存的 decorations 标记,导致
        // tauri.conf.json 里的 decorations:false 失效;排除该字段。
        // 同时排除 VISIBLE:从托盘隐藏后退出,下次启动不应保持隐藏。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                // 只有主窗口会在下次启动时被恢复;拖标签拆出来的窗口下次并不
                // 存在,记它们的位置只会在状态文件里堆垃圾(芯片窗口的尺寸
                // 还会是一枚小标签的大小)。
                .with_filter(|label| label == MAIN_WINDOW)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (e.g. "Open With" while running) forwards its
            // files here instead of starting a new process.
            debug_log(app, &format!("single_instance argv: {argv:?}"));
            let (files, folders) = collect_open_args(argv.into_iter());
            push_opened_paths(app, files, folders);
            // 若窗口在托盘里,第二实例唤起时顺便显示主窗口
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(watcher::WatcherState::default())
        .manage(tab_drag::TabDragState::default())
        .manage(OpenedPaths {
            files: Mutex::new(initial_files),
            folders: Mutex::new(initial_folders),
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_markdown_file,
            commands::write_markdown_file,
            commands::resolve_path,
            commands::path_exists,
            commands::is_directory,
            commands::list_workspace_dir,
            commands::list_workspace_files,
            commands::resolve_wiki_target,
            commands::import_image,
            commands::allow_assets,
            editors::detect_editors,
            editors::open_file_with,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::stop_watching,
            watcher::watch_workspace,
            watcher::unwatch_workspace,
            get_opened_paths,
            hide_to_tray,
            quit_app,
            tab_drag::begin_tab_drag,
            tab_drag::end_tab_drag,
            tab_drag::take_pending_tabs,
            commands::log_assoc,
            file_assoc::is_md_associated,
            file_assoc::register_md_association,
            file_assoc::unregister_md_association,
            file_assoc::is_folder_verb_registered,
            file_assoc::register_folder_verb,
            file_assoc::unregister_folder_verb,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                // 窗口没了,它名下的文件监听与工作区监听一并销掉。
                watcher::release_window(window.app_handle(), window.label());
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() != MAIN_WINDOW {
                    // 拆分出来的窗口点 X 就是关掉它。前端先做未保存检查,确认后
                    // 用 destroy() 真关 —— 再调 close() 会回到这里,自激。
                    let _ = window.emit("close-requested", ());
                } else {
                    // 拦截所有关闭请求(点 X / Alt+F4):交给前端弹出询问对话框
                    // (隐藏到托盘 还是 退出)。
                    let _ = window.emit("close-requested", ());
                }
            }
            _ => {}
        })
        .setup(|app| {
            // 首次启动上报统计(版本 + 操作系统,仅一次)
            stats::check_and_send_statistics(app);

            // 系统托盘
            tray::create_tray(app.handle())?;

            // 窗口以 visible:false 隐藏创建,先恢复上次的位置/尺寸再显示,
            // 避免出现"先在屏幕中央、再跳到上次位置"的闪烁。
            use tauri_plugin_window_state::WindowExt;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.restore_state(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                );
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{collect_open_args, is_markdown_file};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// 每次调用给一个独立目录:测试跑在不同线程上,靠计数器保证目录互不相同。
    fn scratch(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openmd-args-{}-{}-{}",
            prefix,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn argv(rest: &[&str]) -> Vec<String> {
        std::iter::once("openmd.exe".to_string())
            .chain(rest.iter().map(|s| s.to_string()))
            .collect()
    }

    #[test]
    fn open_args_split_documents_from_folders() {
        let dir = scratch("split");
        let folder = dir.join("notes");
        fs::create_dir_all(&folder).unwrap();
        let doc = dir.join("a.md");
        fs::write(&doc, "x").unwrap();
        let doc_arg = doc.to_string_lossy().into_owned();
        let folder_arg = folder.to_string_lossy().into_owned();

        let (files, folders) = collect_open_args(argv(&[&doc_arg, &folder_arg]).into_iter());

        assert_eq!(files, vec![doc_arg]);
        assert_eq!(folders, vec![folder_arg]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_args_drop_flags_unknown_files_and_missing_paths() {
        let dir = scratch("drop");
        let png = dir.join("pic.png");
        fs::write(&png, "x").unwrap();
        let missing = dir.join("gone.md");
        let png_arg = png.to_string_lossy().into_owned();
        let missing_arg = missing.to_string_lossy().into_owned();

        let (files, folders) = collect_open_args(argv(&["--flag", &png_arg, &missing_arg]).into_iter());

        assert!(files.is_empty(), "未知扩展名与不存在的路径都不该被打开");
        assert!(folders.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn markdown_detection_ignores_extension_case() {
        let dir = scratch("case");
        let upper = dir.join("A.MD");
        fs::write(&upper, "x").unwrap();
        assert!(is_markdown_file(&upper));
        fs::remove_dir_all(&dir).ok();
    }
}
