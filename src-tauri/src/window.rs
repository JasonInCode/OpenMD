//! 应用窗口的公共外壳:无原生装饰、标题 OpenMD、加载前端入口页。

use tauri::{Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// 建一扇应用窗口的构造器。芯片窗口(跟手的标签)与文件夹窗口都在此之上
/// 追加各自的装饰与尺寸。
pub fn app_window_builder<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: &str,
    width: f64,
    height: f64,
) -> WebviewWindowBuilder<'a, R, M> {
    WebviewWindowBuilder::new(manager, label, WebviewUrl::App("index.html".into()))
        .title("OpenMD")
        .decorations(false)
        .inner_size(width, height)
}
