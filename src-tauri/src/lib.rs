mod commands;
mod editors;
mod file_assoc;
mod folder_window;
mod single_instance;
mod stats;
mod tab_drag;
mod watcher;
mod window;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 主窗口的 label。系统级入口(文件关联打开、第二实例转发)统一投给它:
/// 其余窗口是拖标签拆出来的或打开文件夹新建的,不该被"双击 .md"这类全局
/// 动作劫持。
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

/// 敲窗口的门。事件不带路径:Tauri 在没有 JS 监听器的 webview 上会静默
/// 跳过投递(仍返回 Ok),所以路径只留在 [`OpenedPaths`] 队列里,前端每次被
/// 敲门都去 [`get_opened_paths`] 取。丢失一次敲门最多晚一个敲门周期。
fn emit_opened(app: &AppHandle, event: &str) {
    let result = match front_window(app) {
        Some(window) => app.emit_to(window.label(), event, ()),
        None => app.emit(event, ()),
    };
    match result {
        Ok(_) => debug_log(app, &format!("emitted {event} OK")),
        Err(e) => debug_log(app, &format!("emitted {event} FAILED: {e}")),
    }
}

/// 落到前面的窗口:优先主窗口;主窗口已关而应用还活着时,取当前聚焦的那扇,
/// 再退而取任意一扇还开着的 —— 不然转发的文件没人接,用户根本看不到。
fn front_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        return Some(window);
    }
    let windows = app.webview_windows();
    windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| windows.values().next())
        .cloned()
}

/// 把应用显示到前面(第二实例转发文件时使用)。
fn show_main_window(app: &AppHandle) {
    if let Some(window) = front_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
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

/// 命令行里要打开的东西。
#[derive(Default)]
struct OpenArgs {
    files: Vec<String>,
    folders: Vec<String>,
    /// 被丢弃的路径与原因:路径不存在,或不是可读的 Markdown 文档。
    dropped: Vec<(String, &'static str)>,
}

/// 从 argv 里分拣出要打开的文件与文件夹。两类入口都不带类型标记——文件关联传
/// `"exe" "%1"`,文件夹右键菜单传的也是同一个形状——所以只能按路径本身判断:
/// 目录进 folders,现存的 Markdown 文件进 files,其余(flag、未知扩展名、不存在的
/// 路径)一律丢弃。丢弃的路径连同原因一并返回:它是"点了没反应"的唯一线索。
fn collect_open_args<I: Iterator<Item = String>>(args: I) -> OpenArgs {
    let mut out = OpenArgs::default();
    for arg in args.skip(1).filter(|a| !a.starts_with('-')) {
        let path = if Path::new(&arg).is_absolute() {
            PathBuf::from(&arg)
        } else {
            // 把文件拖到 exe 上时有时只给一个裸文件名。
            std::env::current_dir()
                .map(|dir| dir.join(&arg))
                .unwrap_or_else(|_| PathBuf::from(&arg))
        };
        if path.is_dir() {
            out.folders.push(path.to_string_lossy().into_owned());
        } else if is_markdown_file(&path) {
            out.files.push(path.to_string_lossy().into_owned());
        } else if path.exists() {
            out.dropped.push((arg, "不是可读的 Markdown 文档"));
        } else {
            out.dropped.push((arg, "路径不存在"));
        }
    }
    out
}

pub fn run() {
    let OpenArgs {
        files: initial_files,
        folders: initial_folders,
        dropped,
    } = collect_open_args(std::env::args());

    tauri::Builder::default()
        // 窗口状态插件默认会恢复上次保存的 decorations 标记,导致
        // tauri.conf.json 里的 decorations:false 失效;排除该字段。
        // 同时排除 VISIBLE:窗口以 visible:false 创建,由 setup 显式 show(),
        // 免得先在屏幕中央闪一下再跳到上次位置。
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
        .plugin(single_instance::plugin(|app, argv| {
            debug_log(app, &format!("single_instance argv: {argv:?}"));
            let open = collect_open_args(argv.into_iter());
            for (path, reason) in &open.dropped {
                debug_log(app, &format!("转发参数丢弃: {path} ({reason})"));
            }
            push_opened_paths(app, open.files, open.folders);
            // 第二实例唤起时顺便把主窗口显示到前面
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(watcher::WatcherState::default())
        .manage(tab_drag::TabDragState::default())
        .manage(folder_window::FolderWindows::default())
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
            folder_window::open_folder_window,
            folder_window::take_pending_folder,
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
                // 拦截关闭请求(点 X / Alt+F4):交给前端先逐个问未保存修改,
                // 确认后前端 destroy() 本窗口 —— 再调 close() 会回到这里,自激。
                // 主窗口关掉后应用继续运行(还有别的窗口开着时),最后一个窗口
                // 关闭时 Tauri 自己结束进程。
                api.prevent_close();
                // 只投给正在关的这扇窗口:窗口上的 emit 是广播,那样关掉任一
                // 窗口会把别的窗口也一起关掉。
                let _ = window.emit_to(window.label(), "close-requested", ());
            }
            _ => {}
        })
        .setup(move |app| {
            // 冷启动也要记命令行:它和转发一样是系统投递路径的出处,不记就无从查起。
            debug_log(
                app.handle(),
                &format!("启动 argv: {:?}", std::env::args().collect::<Vec<String>>()),
            );
            for (path, reason) in &dropped {
                debug_log(app.handle(), &format!("启动参数丢弃: {path} ({reason})"));
            }
            // 首次启动上报统计(版本 + 操作系统,仅一次)
            stats::check_and_send_statistics(app);

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

        let open = collect_open_args(argv(&[&doc_arg, &folder_arg]).into_iter());

        assert_eq!(open.files, vec![doc_arg]);
        assert_eq!(open.folders, vec![folder_arg]);
        assert!(open.dropped.is_empty());
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

        let open = collect_open_args(argv(&["--flag", &png_arg, &missing_arg]).into_iter());

        assert!(open.files.is_empty(), "未知扩展名与不存在的路径都不该被打开");
        assert!(open.folders.is_empty());
        // 丢弃的路径要带原因留下来,不然"点了没反应"无从查起。
        assert_eq!(open.dropped.len(), 2);
        assert!(open.dropped.iter().any(|(p, r)| p == &png_arg && *r == "不是可读的 Markdown 文档"));
        assert!(open.dropped.iter().any(|(p, r)| p == &missing_arg && *r == "路径不存在"));
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
