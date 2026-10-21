//! 打开文件夹用的独立窗口:一个文件夹一扇窗口,文件夹在窗口里成为工作区。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::window::app_window_builder;

/// 新窗口相对来源窗口的比例:新窗口开在来源窗口正中,留出边缘能看见来源窗口。
const WINDOW_SCALE: f64 = 0.6;
/// 独立窗口的最小尺寸(CSS 像素),与主窗口一致。
const WINDOW_MIN_WIDTH: f64 = 640.0;
const WINDOW_MIN_HEIGHT: f64 = 480.0;

/// 待打开的文件夹:窗口 label → 文件夹路径。新窗口启动时取走分配给自己的那份。
#[derive(Default)]
pub struct FolderWindows {
    pending: Mutex<HashMap<String, String>>,
    seq: AtomicU64,
}

/// 打开一扇新的文件夹窗口:文件夹在窗口里成为工作区。
///
/// 必须是 `async`:同步命令跑在 WebView2 的 IPC 回调里(就是 UI 线程),而
/// 建窗在同步命令里会死锁(Tauri 的 Known issues,wry#583)。
#[tauri::command]
pub async fn open_folder_window(
    app: AppHandle,
    state: tauri::State<'_, FolderWindows>,
    window: WebviewWindow,
    path: String,
) -> Result<(), String> {
    let label = format!(
        "folder-win-{}",
        state.seq.fetch_add(1, Ordering::Relaxed) + 1
    );
    // 先缓冲再建窗:新页面 mount 时随时可能来取,反过来的话这个文件夹就丢了。
    state
        .pending
        .lock()
        .map_err(|_| "文件夹缓冲不可用".to_string())?
        .insert(label.clone(), path);
    if let Err(e) = build_window(&app, &label, &window) {
        state.pending.lock().ok().and_then(|mut p| p.remove(&label));
        return Err(e);
    }
    Ok(())
}

/// 新窗口启动时取走分配给自己的文件夹;不是文件夹窗口则没有。
#[tauri::command]
pub fn take_pending_folder(
    state: tauri::State<'_, FolderWindows>,
    window: WebviewWindow,
) -> Option<String> {
    let label = window.label().to_string();
    state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&label))
}

/// 建一扇文件夹窗口:尺寸取来源窗口的六成,落在来源窗口正中。
fn build_window(
    app: &AppHandle,
    label: &str,
    source: &WebviewWindow,
) -> Result<WebviewWindow, String> {
    let scale = source.scale_factor().map_err(|e| e.to_string())?.max(0.01);
    let source_size = source
        .outer_size()
        .map_err(|e| e.to_string())
        .unwrap_or(PhysicalSize {
            width: 1200,
            height: 800,
        });
    let min = PhysicalSize {
        width: (WINDOW_MIN_WIDTH * scale).round() as u32,
        height: (WINDOW_MIN_HEIGHT * scale).round() as u32,
    };
    let size = PhysicalSize {
        width: ((source_size.width as f64 * WINDOW_SCALE).round() as u32).max(min.width),
        height: ((source_size.height as f64 * WINDOW_SCALE).round() as u32).max(min.height),
    };
    // 位置:与来源窗口同心(物理像素算完再换回逻辑像素)。
    let position = source
        .outer_position()
        .map(|p| {
            PhysicalPosition::new(
                p.x + (source_size.width as i32 - size.width as i32) / 2,
                p.y + (source_size.height as i32 - size.height as i32) / 2,
            )
        })
        .unwrap_or(PhysicalPosition::new(0, 0));

    let window = app_window_builder(
        app,
        label,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
    .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
    .position(position.x as f64 / scale, position.y as f64 / scale)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(window)
}
