rust_i18n::i18n!("locales", fallback = "zh");

mod commands;
mod editors;
mod file_assoc;
mod i18n;
mod pkg;
mod qq_group;
mod stats;
mod tray;
mod updater;
mod watcher;

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 敲门间隔:漏掉一次事件投递时,打开请求最多多等这么久。
const NOTIFY_INTERVAL: Duration = Duration::from_millis(250);
/// 敲门次数上限(约 5 分钟)。走到这里说明前端已经取不到了,停手把线程还回去;
/// 缓冲里未取走的请求留给下一次打开请求重新触发。
const NOTIFY_MAX_TICKS: u32 = 1200;

struct OpenedFilesState {
    paths: Vec<String>,
    /// 通知线程是否已在跑,全局最多一个。
    notifying: bool,
}

/// OS「打开方式」传来的文件路径队列。前端用 [`get_opened_files`] 取走为止
/// 一直保留:请求可能早于 webview 就绪到达,也可能碰上 JS 监听器缺失,两种
/// 情况都不能丢。
struct OpenedFiles {
    state: Mutex<OpenedFilesState>,
}

impl OpenedFiles {
    fn new(paths: Vec<String>) -> Self {
        Self {
            state: Mutex::new(OpenedFilesState {
                paths,
                notifying: false,
            }),
        }
    }

    /// 入队。返回 true 表示还没有通知线程在跑,调用方需要启动一个。
    fn push(&self, paths: Vec<String>) -> bool {
        let mut state = self.state.lock().unwrap();
        state.paths.extend(paths);
        Self::start_notifying(&mut state)
    }

    /// 队列里已有请求却没有通知线程时补一个(启动 argv 走这里)。返回是否新建。
    fn resume_notifying(&self) -> bool {
        Self::start_notifying(&mut self.state.lock().unwrap())
    }

    fn start_notifying(state: &mut OpenedFilesState) -> bool {
        if state.notifying {
            return false;
        }
        state.notifying = true;
        true
    }

    /// 前端是否还有没取走的请求。
    fn has_pending(&self) -> bool {
        !self.state.lock().unwrap().paths.is_empty()
    }

    /// 取走全部待处理路径;取空即消费完成,重复调用返回空列表。
    fn drain(&self) -> Vec<String> {
        std::mem::take(&mut self.state.lock().unwrap().paths)
    }

    /// 通知线程退出前调用。返回 true 表示退出瞬间又来了新请求,调用方得接着敲。
    fn stop_notifying(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        state.notifying = false;
        !state.paths.is_empty()
    }
}

/// 诊断日志:追加到 app_data_dir/assoc-debug.log
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

/// 前端取走队列里积压的打开请求。这是唯一的投递通道:打开请求可能早于 webview
/// 就绪到达,也可能碰上监听器缺失,而 Tauri 在没有 JS 监听器的 webview 上会
/// 静默跳过事件投递(`emit` 照样返回 `Ok`),所以路径只能留在队列里等取。
#[tauri::command]
fn get_opened_files(state: tauri::State<'_, OpenedFiles>, app: AppHandle) -> Vec<String> {
    let result = state.drain();
    debug_log(&app, &format!("get_opened_files drained: {result:?}"));
    result
}

/// 敲一下门,叫前端来取队列。事件本身不带路径——它只是一声提醒,丢不丢都不影响
/// 请求最终被取到。
fn notify_opened_files(app: &AppHandle) {
    if let Err(e) = app.emit("opened-files", ()) {
        debug_log(app, &format!("notify opened-files FAILED: {e}"));
    }
}

/// 通知线程的一轮:队列非空就接着敲,前端已取空则看退出瞬间有没有新请求。
/// 返回 false 表示线程可以退出。
fn notify_tick(state: &OpenedFiles) -> bool {
    if state.has_pending() {
        true
    } else {
        state.stop_notifying()
    }
}

/// 队列非空期间反复敲门,直到前端取空。调用方须已把 `notifying` 置位。
///
/// 事件投递本身没有送达保证(webview 未就绪、页面重载、监听注册失败都会让 Tauri
/// 静默丢弃),这条线程兜住漏掉的事件:双击最坏只多等一个敲门的间隔,而不是
/// 永远打不开。
fn spawn_opened_files_notifier(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        for _ in 0..NOTIFY_MAX_TICKS {
            std::thread::sleep(NOTIFY_INTERVAL);
            let Some(state) = app.try_state::<OpenedFiles>() else {
                return;
            };
            if !notify_tick(&state) {
                return;
            }
            notify_opened_files(&app);
        }
        // 敲门到期:必须把 `notifying` 还回去,否则之后的打开请求再也起不了线程。
        if let Some(state) = app.try_state::<OpenedFiles>() {
            state.stop_notifying();
        }
        debug_log(&app, "opened-files notifier gave up: frontend never drained the queue");
    });
}

/// 把 OS 传来的路径排进队列,并让前端尽快来取。
fn push_opened_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        debug_log(app, "push_opened_files: paths EMPTY, skipped");
        return;
    }
    debug_log(app, &format!("push_opened_files queued: {paths:?}"));
    if let Some(state) = app.try_state::<OpenedFiles>() {
        if state.push(paths) {
            spawn_opened_files_notifier(app);
        }
    }
    // 不等敲门周期,当场先敲一次。
    notify_opened_files(app);
}

/// Extract markdown file paths from process argv (Windows "Open With" hands
/// the file as argv[1]). Only existing files with a markdown extension pass.
fn collect_md_args<I: Iterator<Item = String>>(args: I) -> Vec<String> {
    args.skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            if Path::new(&a).is_absolute() {
                a
            } else {
                // Dragging a file onto the exe can hand a bare relative name.
                std::env::current_dir()
                    .map(|d| d.join(&a).to_string_lossy().into_owned())
                    .unwrap_or(a)
            }
        })
        .filter(|a| {
            Path::new(a)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    matches!(
                        e.to_ascii_lowercase().as_str(),
                        "md" | "markdown" | "mdown" | "mkd"
                    )
                })
                .unwrap_or(false)
        })
        .filter(|a| Path::new(a).is_file())
        .collect()
}

/// macOS:把 Launch Services 传来的 `file://` URL 转成本地路径,只保留
/// 存在的 Markdown 文件(过滤规则与 [`collect_md_args`] 一致)。
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn collect_md_urls(urls: Vec<tauri::Url>) -> Vec<String> {
    urls.into_iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|a| {
            Path::new(a)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    matches!(
                        e.to_ascii_lowercase().as_str(),
                        "md" | "markdown" | "mdown" | "mkd"
                    )
                })
                .unwrap_or(false)
        })
        .filter(|a| Path::new(a).is_file())
        .collect()
}

/// 隐藏主窗口到系统托盘(前端关闭询问对话框选择"隐藏到托盘"时调用)。
#[tauri::command]
fn hide_to_tray(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// 真正退出程序(托盘菜单"退出"与前端关闭询问对话框选择"退出"共用)。
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 前端 LanguageSync 启动后会同步语言;默认中文,保证托盘菜单等原生 UI 首帧即为中文。
    rust_i18n::set_locale("zh");

    let md_args = collect_md_args(std::env::args());

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
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (e.g. "Open With" while running) forwards its
            // files here instead of starting a new process.
            debug_log(app, &format!("single_instance argv: {argv:?}"));
            let paths = collect_md_args(argv.into_iter());
            debug_log(app, &format!("single_instance filtered: {paths:?}"));
            push_opened_files(app, paths);
            // 若窗口在托盘里,第二实例唤起时顺便显示主窗口
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(watcher::WatcherState::default())
        .manage(OpenedFiles::new(md_args))
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
            get_opened_files,
            hide_to_tray,
            quit_app,
            i18n::set_language,
            commands::log_assoc,
            updater::download_update,
            updater::install_update,
            updater::cancel_download,
            updater::reset_download_cancel,
            updater::delete_download_file,
            file_assoc::is_md_associated,
            file_assoc::register_md_association,
            file_assoc::unregister_md_association,
            qq_group::get_qq_groups,
            qq_group::get_qq_group_icon,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // macOS 惯例:点红灯只是关掉窗口,应用继续驻留,由 Dock/托盘唤回。
                // Windows/Linux 保持原行为:交给前端弹出询问对话框
                // (隐藏到托盘 还是 退出)。
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(target_os = "macos"))]
                {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .setup(|app| {
            // 首次启动上报统计(版本 + 操作系统,仅一次)
            stats::check_and_send_statistics(app);

            // 系统托盘
            tray::create_tray(app.handle())?;

            // 启动参数里的文件同样只在队列里:前端启动时取一次,取不到就靠敲门重试。
            if app
                .try_state::<OpenedFiles>()
                .is_some_and(|state| state.resume_notifying())
            {
                spawn_opened_files_notifier(app.handle());
            }

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS 的"用 OpenMD 打开"不是命令行参数,而是 Launch Services
            // 投递的 `RunEvent::Opened`。双击 .md / 拖到 Dock 图标都走这里,
            // 并且可能在 webview 就绪之前到达,所以同样走缓冲 + 事件通知。
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths = collect_md_urls(urls);
                debug_log(app, &format!("RunEvent::Opened paths: {paths:?}"));
                push_opened_files(app, paths);
                tray::show_main_window(app);
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod opened_files_tests {
    use super::{notify_tick, OpenedFiles};

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn drain_takes_everything_once() {
        let queue = OpenedFiles::new(paths(&["a.md"]));
        assert!(queue.has_pending());
        assert_eq!(queue.drain(), paths(&["a.md"]));
        assert!(!queue.has_pending());
        assert_eq!(queue.drain(), Vec::<String>::new());
    }

    #[test]
    fn pushes_accumulate_until_drained() {
        let queue = OpenedFiles::new(Vec::new());
        assert!(queue.push(paths(&["a.md"])));
        // 已有通知线程在跑,后续 push 不再新建。
        assert!(!queue.push(paths(&["b.md", "c.md"])));
        assert_eq!(queue.drain(), paths(&["a.md", "b.md", "c.md"]));
    }

    #[test]
    fn a_push_racing_with_notifier_exit_is_not_lost() {
        let queue = OpenedFiles::new(Vec::new());
        assert!(queue.push(paths(&["a.md"])));
        // 前端取空队列,通知线程下一轮会认为自己可以退出。
        assert_eq!(queue.drain(), paths(&["a.md"]));
        assert!(!queue.has_pending());
        // 线程退出前的那一瞬又来了新请求:此时 notifying 仍为 true,不会再新建线程,
        // 全靠 stop_notifying 的复查把它捞回来。
        assert!(!queue.push(paths(&["b.md"])));
        assert!(queue.stop_notifying());
        assert_eq!(queue.drain(), paths(&["b.md"]));
    }

    #[test]
    fn a_tick_keeps_knocking_until_the_frontend_drained() {
        let queue = OpenedFiles::new(Vec::new());
        assert!(queue.push(paths(&["a.md"])));
        assert!(notify_tick(&queue));
        assert_eq!(queue.drain(), paths(&["a.md"]));
        // 前端取空且退出瞬间没有新请求:线程退出并把 notifying 还回去。
        assert!(!notify_tick(&queue));
        // 之后的打开请求能重新起线程。
        assert!(queue.push(paths(&["b.md"])));
    }

    #[test]
    fn resume_notifying_covers_startup_argv() {
        let queue = OpenedFiles::new(paths(&["a.md"]));
        assert!(queue.has_pending());
        assert!(queue.resume_notifying());
        assert!(!queue.resume_notifying());
        assert!(queue.stop_notifying());
    }
}
