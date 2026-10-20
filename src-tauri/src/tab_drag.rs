//! 标签拆分与合并:把一个标签拖出当前窗口生成独立窗口,或拖进另一个窗口合并。
//!
//! 拖拽会话完全由这里持有。源窗口的前端只发 pointer 事件,「窗口跟手」和
//! 「落点命中测试」都由一个轮询线程完成 —— Tauri 的 DOM 拖放跨不了 webview,
//! 能跨窗口的只有系统指针捕获 + 全局光标坐标。
//!
//! 跟手的窗口(芯片窗口)先是一枚 200×32 的小标签,落定时才长成正常窗口:
//! 整扇窗口跟手会把目标窗口的标签栏整个盖住,而插入线恰恰画在那里。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

/// 跟手与落点高亮的刷新节奏。
const POLL_INTERVAL: Duration = Duration::from_millis(40);

/// 芯片窗口(跟手的标签)高度,取标签栏一行的视觉高度。
const CHIP_HEIGHT: f64 = 32.0;
const CHIP_WIDTH_MIN: f64 = 160.0;
const CHIP_WIDTH_MAX: f64 = 260.0;

/// 独立窗口的最小尺寸,与主窗口一致(CSS 像素)。
const WINDOW_MIN_WIDTH: f64 = 640.0;
const WINDOW_MIN_HEIGHT: f64 = 480.0;
/// 独立窗口相对源窗口的比例:分屏并排时要给另一半留地方。
const WINDOW_SCALE: f64 = 0.6;

/// 窗口贴到屏幕边缘时至少要留在工作区里的长度,否则拖到边缘会整个滑出去。
const EDGE_KEEP_CHIP: f64 = 120.0;

/// 拖到某个窗口要搬过去的标签内容。未保存的草稿与滚动位置都在里面,
/// 所以标签换了窗口也不会丢编辑内容。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPayload {
    pub path: String,
    pub name: String,
    pub content: String,
    pub draft: Option<String>,
    pub last_saved_at: f64,
    pub disk_changed: bool,
    pub scroll_y: f64,
    pub error: Option<String>,
}

/// 新窗口启动时取走分配给自己的标签。`ghost` 为真表示它当前还是拖拽中的
/// 芯片窗口(只渲染一枚标签),落定后前端会切成完整界面。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTab {
    pub tab: TabPayload,
    pub ghost: bool,
}

/// 一次拖拽会话里不随拖拽变化的部分,轮询线程每拍都要读,故整体用 Arc 共享。
struct DragSession {
    /// 会话自增 id:迟到的收尾不会误伤下一次拖拽。
    id: u64,
    /// 芯片窗口的 label。
    window_label: String,
    /// 发起拖拽的窗口 label。它同时也是合法落点 —— 拖回原窗口即合并回去。
    source_label: String,
    /// 光标相对芯片窗口左上角的偏移(物理像素),跟手时保持不变。
    grab: PhysicalPosition<f64>,
    /// 落成独立窗口后的尺寸与最小尺寸(物理像素)。
    settle_size: PhysicalSize<u32>,
    settle_min: PhysicalSize<u32>,
    /// 落点候选窗口及其矩形,按创建顺序从新到旧;已消失与最小化的窗口已剔除。
    targets: Vec<(String, PhysicalRect<i32, u32>)>,
}

/// 跨窗口拖拽的全部状态。
#[derive(Default)]
pub struct TabDragState {
    /// label → 拖进该窗口、还没被取走的标签。芯片窗口与落成的独立窗口共用一份。
    pending: Mutex<HashMap<String, TabPayload>>,
    /// 当前拖拽会话;None 表示没有拖拽在进行。
    session: Mutex<Option<std::sync::Arc<DragSession>>>,
    /// 光标当前悬停的落点窗口;None 表示芯片窗口之外无处可落。
    hover: Mutex<Option<String>>,
    /// 已创建过的窗口 label,按创建顺序;命中重叠时后建的窗口优先。
    created: Mutex<Vec<String>>,
    seq: AtomicU64,
}

/// 新窗口启动时取走分配给自己的标签。
#[tauri::command]
pub fn take_pending_tabs(
    state: tauri::State<'_, TabDragState>,
    window: WebviewWindow,
) -> Option<PendingTab> {
    let label = window.label();
    let tab = state
        .pending
        .lock()
        .ok()
        .and_then(|p| p.get(label).cloned())?;
    let ghost = state
        .session
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|s| s.window_label == label))
        .unwrap_or(false);
    Some(PendingTab { tab, ghost })
}

/// 开始一次标签拖拽:建出跟手的芯片窗口,并起轮询线程负责跟手与落点判定。
///
/// `grab_x` / `grab_y` 是抓取点在标签内的偏移(CSS 像素),`tab_width` 是标签宽度;
/// 芯片窗口照着做,拖起来才像"手里捏着这一枚标签"。返回芯片窗口的 label。
///
/// 必须是 `async`:同步命令跑在 WebView2 的 IPC 回调里(就是 UI 线程),而
/// WebviewWindowBuilder 建窗在同步命令里会死锁(Tauri 的 Known issues,
/// wry#583)。UI 线程一卡,芯片窗口建不出来,主窗口的窗口控制也一起失效。
#[tauri::command]
pub async fn begin_tab_drag(
    app: AppHandle,
    state: tauri::State<'_, TabDragState>,
    window: WebviewWindow,
    tab: TabPayload,
    grab_x: f64,
    grab_y: f64,
    tab_width: f64,
) -> Result<String, String> {
    // 上一次拖拽若没收尾(比如源窗口在拖拽途中被关),先按当前落点结算,
    // 否则新会话会被"已有一个会话"卡住,之后再也拖不动。
    resolve(&app, &state);

    let scale = window.scale_factor().map_err(|e| e.to_string())?.max(0.01);
    let chip_size = PhysicalSize {
        width: (tab_width.clamp(CHIP_WIDTH_MIN, CHIP_WIDTH_MAX) * scale).round() as u32,
        height: (CHIP_HEIGHT * scale).round() as u32,
    };
    let min = PhysicalSize {
        width: (WINDOW_MIN_WIDTH * scale).round() as u32,
        height: (WINDOW_MIN_HEIGHT * scale).round() as u32,
    };
    let source_size = window
        .outer_size()
        .map_err(|e| e.to_string())
        .unwrap_or(PhysicalSize {
            width: 1200,
            height: 800,
        });
    let settle_size = PhysicalSize {
        width: ((source_size.width as f64 * WINDOW_SCALE).round() as u32).max(min.width),
        height: ((source_size.height as f64 * WINDOW_SCALE).round() as u32).max(min.height),
    };

    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let grab = PhysicalPosition::new(grab_x * scale, grab_y * scale);
    let position = clamp_to_work_area(
        &window,
        PhysicalPosition::new(cursor.x - grab.x, cursor.y - grab.y),
        EDGE_KEEP_CHIP,
    );

    let label = new_label(&state);
    // 先缓冲再建窗:新页面 mount 时随时可能来取,反过来的话这一场拖拽就丢了标签。
    state
        .pending
        .lock()
        .map_err(|_| "标签缓冲不可用".to_string())?
        .insert(label.clone(), tab);
    remember_created(&state, &label);

    let source_label = window.label().to_string();
    remember_created(&state, &source_label);
    let session = std::sync::Arc::new(DragSession {
        id: state.seq.fetch_add(1, Ordering::Relaxed),
        window_label: label.clone(),
        source_label,
        grab,
        settle_size,
        settle_min: min,
        targets: collect_targets(&app, &state, &[&label, window.label()]),
    });
    // 会话必须先于 open_window 落地:新窗口的 React mount 与 build() 几乎同时
    // 发生,一旦它在 take_pending_tabs 时发现 session 还是 None,ghost 就会误报
    // 成 false,芯片窗口不会渲染跟手那一枚标签,而是把完整界面塞进 200×32 的
    // 空间里(标题栏、tab 栏、内容区全部裁掉),看上去就是纯白一条。
    *state
        .session
        .lock()
        .map_err(|_| "拖拽状态不可用".to_string())? = Some(session.clone());

    if let Err(e) = open_window(&app, &label, chip_size, position, scale, true) {
        // 建窗失败,把会话和 pending 一起回滚,不遗留脏数据。
        state.pending.lock().ok().and_then(|mut p| p.remove(&label));
        if let Ok(mut slot) = state.session.lock() {
            if matches!(slot.as_ref(), Some(current) if current.id == session.id) {
                *slot = None;
            }
        }
        return Err(e);
    }

    spawn_poller(app, session.id);
    Ok(label)
}

/// 结束拖拽:落到某个窗口就合并过去,否则让芯片窗口原地长成独立窗口。
///
/// 幂等 —— 源窗口与芯片窗口谁先收到 pointerup 都调它,只生效一次。
///
/// 与 [`begin_tab_drag`] 同理必须 `async`:`resolve` 在芯片窗口已被销毁时会
/// 重建一扇独立窗口,同样不能在 UI 线程上建。
#[tauri::command]
pub async fn end_tab_drag(
    app: AppHandle,
    state: tauri::State<'_, TabDragState>,
) -> Result<(), String> {
    resolve(&app, &state);
    Ok(())
}

/// 结算当前拖拽(有会话才做事)。指针捕获在个别平台可能丢,源窗口和芯片窗口
/// 会各调一次;会话被取走后第二次直接返回。
fn resolve(app: &AppHandle, state: &TabDragState) {
    let session = {
        let Ok(mut slot) = state.session.lock() else { return };
        match slot.take() {
            Some(s) => s,
            None => return,
        }
    };
    let hover = state.hover.lock().ok().and_then(|mut h| h.take());
    let Some(tab) = state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&session.window_label))
    else {
        crate::debug_log(app, "拖拽结算时标签已被取走,没有可投递的内容");
        return;
    };

    // 有落点:把标签投递给那个窗口,它按落点横坐标算插入位;芯片窗口随之销毁。
    if let Some(label) = hover {
        if app.get_webview_window(&label).is_some() {
            let x = local_css_x(app, &label);
            match app.emit_to(
                &label,
                "tab-drop",
                serde_json::json!({ "tab": tab, "x": x }),
            ) {
                Ok(()) => {
                    if let Some(chip) = app.get_webview_window(&session.window_label) {
                        let _ = chip.destroy();
                    }
                    if let Some(target) = app.get_webview_window(&label) {
                        let _ = target.set_focus();
                    }
                    return;
                }
                Err(e) => crate::debug_log(
                    app,
                    &format!("投递标签到 {label} 失败,改为落成独立窗口:{e}"),
                ),
            }
        }
    }
    settle(app, state, &session, tab);
}

/// 芯片窗口落定:变回一扇正常窗口(恢复可缩放与最小尺寸、取消置顶、聚焦)。
///
/// 芯片窗口若已经被销毁,就用同一份标签重新开一扇 —— 标签不会凭空消失。
fn settle(app: &AppHandle, state: &TabDragState, session: &DragSession, tab: TabPayload) {
    let Some(window) = app.get_webview_window(&session.window_label) else {
        let label = new_label(state);
        if let Ok(mut pending) = state.pending.lock() {
            pending.insert(label.clone(), tab);
        }
        remember_created(state, &label);
        let cursor = app.cursor_position().unwrap_or(PhysicalPosition::new(0.0, 0.0));
        let position = PhysicalPosition::new(cursor.x as i32 - 40, cursor.y as i32 - 16);
        if let Err(e) = open_window(app, &label, session.settle_size, position, 1.0, false) {
            crate::debug_log(app, &format!("重建独立窗口失败:{e}"));
        }
        return;
    };

    let _ = window.set_min_size(Some(session.settle_min));
    let _ = window.set_size(session.settle_size);
    let _ = window.set_resizable(true);
    let _ = window.set_always_on_top(false);
    let _ = window.set_focus();
    let _ = app.emit_to(&session.window_label, "tab-drag-settled", ());
}

/// 跟手 + 落点判定。源窗口与芯片窗口都不参与命中测试,其余窗口按创建顺序
/// 从新到旧匹配。会话被结算后本线程自然退出。
fn spawn_poller(app: AppHandle, id: u64) {
    std::thread::spawn(move || {
        let mut last_position: Option<PhysicalPosition<i32>> = None;
        loop {
            // 状态挂在 AppHandle 上,按需取,不必把整个状态搬进线程。
            let Some(state) = app.try_state::<TabDragState>() else {
                break;
            };
            let Some(session) = state.session.lock().ok().and_then(|s| s.clone()) else {
                break;
            };
            if session.id != id {
                break;
            }
            let Ok(cursor) = app.cursor_position() else { break };
            // 源窗口没了(拖到中途被关)或芯片窗口没了:这一场拖拽已经没有主人,
            // 按当前落点结算,标签不会跟着窗口一起消失。
            if app.get_webview_window(&session.source_label).is_none()
                || app.get_webview_window(&session.window_label).is_none()
            {
                resolve(&app, &state);
                break;
            }

            let position = clamp_to_work_area(
                app.get_webview_window(&session.window_label)
                    .as_ref()
                    .expect("上一行刚确认过芯片窗口还在"),
                PhysicalPosition::new(cursor.x - session.grab.x, cursor.y - session.grab.y),
                EDGE_KEEP_CHIP,
            );
            if last_position != Some(position) {
                if let Some(chip) = app.get_webview_window(&session.window_label) {
                    if chip.set_position(position).is_ok() {
                        last_position = Some(position);
                    }
                }
            }

            set_hover(&app, &state, window_under_point(&session.targets, cursor));
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// 切换落点高亮:旧目标收到"离开",新目标收到"进入"(带 CSS 像素横坐标,
/// 由目标窗口自己在标签栏里算插入位)。
fn set_hover(app: &AppHandle, state: &TabDragState, next: Option<&str>) {
    let previous = {
        let Ok(mut slot) = state.hover.lock() else { return };
        if slot.as_deref() == next {
            return;
        }
        std::mem::replace(&mut *slot, next.map(str::to_string))
    };
    if let Some(label) = previous {
        let _ = app.emit_to(&label, "tab-drag-hover-end", ());
    }
    // local_css_x 要问事件循环拿光标位置,emit_to 也要派发给 webview,两者都是
    // 阻塞等主线程的往返。resolve() 拿的是同一把锁,持锁等主线程、主线程回头
    // 等这把锁就成死锁,所以只在上面那段锁内换状态,派发一律放到锁外。
    if let Some(label) = next {
        let x = local_css_x(app, label);
        let _ = app.emit_to(label, "tab-drag-hover", serde_json::json!({ "x": x }));
    }
}

/// 光标在目标窗口内的横坐标(CSS 像素,相对窗口内容区左上角)。
fn local_css_x(app: &AppHandle, label: &str) -> f64 {
    let Some(window) = app.get_webview_window(label) else {
        return 0.0;
    };
    let (Ok(cursor), Ok(position)) = (app.cursor_position(), window.outer_position()) else {
        return 0.0;
    };
    let scale = window.scale_factor().unwrap_or(1.0).max(0.01);
    // 窗口都去掉了原生装饰,外框位置就是内容区原点。
    (cursor.x - position.x as f64) / scale
}

/// 落点候选:芯片窗口与源窗口以外的所有窗口矩形,按创建顺序从新到旧。
fn collect_targets(
    app: &AppHandle,
    state: &TabDragState,
    exclude: &[&str],
) -> Vec<(String, PhysicalRect<i32, u32>)> {
    let order = state.created.lock().map(|c| c.clone()).unwrap_or_default();
    let rank = |label: &str| order.iter().position(|l| l == label).unwrap_or(0);
    let mut targets: Vec<(usize, String, PhysicalRect<i32, u32>)> = Vec::new();
    for (label, window) in app.webview_windows() {
        if exclude.contains(&label.as_str()) || window.is_minimized().unwrap_or(false) {
            continue;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            continue;
        };
        targets.push((
            rank(&label),
            label,
            PhysicalRect { position, size },
        ));
    }
    targets.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    targets
        .into_iter()
        .map(|(_, label, rect)| (label, rect))
        .collect()
}

/// 光标命中的落点窗口。`targets` 已按创建顺序从新到旧排好,重叠时先命中最上层。
/// 右/下边界不计入:光标正好压在窗口边上时不算落在这个窗口里。
fn window_under_point(
    targets: &[(String, PhysicalRect<i32, u32>)],
    point: PhysicalPosition<f64>,
) -> Option<&str> {
    targets.iter().find_map(|(label, rect)| {
        let inside = point.x >= rect.position.x as f64
            && point.y >= rect.position.y as f64
            && point.x < (rect.position.x + rect.size.width as i32) as f64
            && point.y < (rect.position.y + rect.size.height as i32) as f64;
        inside.then_some(label.as_str())
    })
}

/// 把窗口左上角夹进光标所在显示器的可用区域,至少留 `keep` 长在里面。
fn clamp_to_work_area(
    reference: &WebviewWindow,
    position: PhysicalPosition<f64>,
    keep: f64,
) -> PhysicalPosition<i32> {
    match reference.monitor_from_point(position.x, position.y) {
        Ok(Some(monitor)) => clamp_position(position, *monitor.work_area(), keep),
        _ => PhysicalPosition::new(position.x.round() as i32, position.y.round() as i32),
    }
}

/// [`clamp_to_work_area`] 里的纯计算部分:窗口左上角既不越过工作区左边/上边,
/// 也不会从右边/下边滑出去太多。工作区比 `keep` 还小时退化成贴住左上角。
fn clamp_position(
    position: PhysicalPosition<f64>,
    work: PhysicalRect<i32, u32>,
    keep: f64,
) -> PhysicalPosition<i32> {
    let (left, top) = (work.position.x, work.position.y);
    // 工作区比 keep 还小时退化成贴住左上角。
    let max_x = left + (work.size.width as f64 - keep).max(0.0).round() as i32;
    let max_y = top + (work.size.height as f64 - keep).max(0.0).round() as i32;
    let x = (position.x.round() as i32).max(left).min(max_x);
    let y = (position.y.round() as i32).max(top).min(max_y);
    PhysicalPosition::new(x, y)
}

/// 建窗口。芯片窗口不抢前台:源窗口保持前台才拿得住系统指针捕获,否则拖到
/// 一半 pointerup 就丢了(tao 对 focused(false) 走 SW_SHOWNOACTIVATE /
/// orderFront / accept_focus(false),都不激活窗口)。
fn open_window(
    app: &AppHandle,
    label: &str,
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
    scale: f64,
    chip: bool,
) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("OpenMD")
        .decorations(false)
        .focused(false)
        .always_on_top(chip)
        .resizable(!chip)
        .shadow(chip)
        // 建窗时先给个逻辑尺寸,紧接着用物理尺寸校正,避免窗口先以默认尺寸闪一下。
        .inner_size(size.width as f64 / scale, size.height as f64 / scale)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.set_size(size);
    let _ = window.set_position(position);
    Ok(window)
}

fn new_label(state: &TabDragState) -> String {
    format!("tab-win-{}", state.seq.fetch_add(1, Ordering::Relaxed) + 1)
}

fn remember_created(state: &TabDragState, label: &str) {
    if let Ok(mut created) = state.created.lock() {
        if !created.iter().any(|l| l == label) {
            created.push(label.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_position, window_under_point, DragSession, PhysicalPosition, PhysicalRect,
        PhysicalSize,
    };

    fn rect(x: i32, y: i32, w: u32, h: u32) -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(w, h),
        }
    }

    fn targets() -> Vec<(String, PhysicalRect<i32, u32>)> {
        vec![
            ("newer".to_string(), rect(500, 100, 400, 300)),
            ("older".to_string(), rect(0, 0, 600, 400)),
        ]
    }

    #[test]
    fn a_point_inside_a_window_hits_it() {
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(700.0, 200.0)),
            Some("newer")
        );
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(100.0, 200.0)),
            Some("older")
        );
    }

    #[test]
    fn points_outside_every_window_hit_nothing() {
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(2000.0, 2000.0)),
            None
        );
        // 窗口之间的缝隙
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(700.0, 700.0)),
            None
        );
    }

    #[test]
    fn edges_are_half_open_so_an_exact_right_or_bottom_edge_is_a_miss() {
        // 右边界 900 不算在 newer 里(newer 的 x 区间是 [500,900));再往右同理。
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(900.0, 200.0)),
            None
        );
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(900.5, 200.0)),
            None
        );
        // 左/上边界算窗口内。
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(500.0, 100.0)),
            Some("newer")
        );
        // 下边界 400 不再算在 older 里。
        assert_eq!(
            window_under_point(&targets(), PhysicalPosition::new(100.0, 400.0)),
            None
        );
    }

    #[test]
    fn overlapping_windows_pick_the_one_created_later() {
        let list = vec![
            ("newer".to_string(), rect(100, 100, 800, 600)),
            ("older".to_string(), rect(0, 0, 800, 600)),
        ];
        assert_eq!(
            window_under_point(&list, PhysicalPosition::new(200.0, 200.0)),
            Some("newer")
        );
    }

    #[test]
    fn clamping_keeps_the_window_on_the_work_area() {
        let work = rect(0, 0, 1920, 1040);
        // 拖到右下角:不能整个滑出屏幕。
        let clamped = clamp_position(PhysicalPosition::new(1900.0, 1030.0), work, 120.0);
        assert_eq!(clamped.x, 1800);
        assert_eq!(clamped.y, 920);
        // 拖到左上角之外:贴住左上角。
        let clamped = clamp_position(PhysicalPosition::new(-400.0, -200.0), work, 120.0);
        assert_eq!(clamped.x, 0);
        assert_eq!(clamped.y, 0);
        // 工作区内的位置不动。
        let clamped = clamp_position(PhysicalPosition::new(300.0, 400.0), work, 120.0);
        assert_eq!(clamped.x, 300);
        assert_eq!(clamped.y, 400);
    }

    #[test]
    fn clamping_handles_a_work_area_smaller_than_the_kept_margin() {
        let work = rect(0, 0, 80, 60);
        let clamped = clamp_position(PhysicalPosition::new(500.0, 500.0), work, 120.0);
        assert_eq!(clamped.x, 0);
        assert_eq!(clamped.y, 0);
    }

    #[test]
    fn clamping_respects_a_negative_origin_monitor() {
        let work = rect(-1920, 0, 1920, 1040);
        let clamped = clamp_position(PhysicalPosition::new(-300.0, 100.0), work, 120.0);
        assert_eq!(clamped.x, -300);
        let clamped = clamp_position(PhysicalPosition::new(-2500.0, 100.0), work, 120.0);
        assert_eq!(clamped.x, -1920);
    }

    #[test]
    fn a_session_can_be_shared_across_threads() {
        // 轮询线程每拍都要克隆 Arc<DragSession>;这里钉住它是 Send + Sync。
        fn assert_send_sync<T: Send + Sync>(_: &T) {}
        let session = DragSession {
            id: 1,
            window_label: "tab-win-1".into(),
            source_label: "main".into(),
            grab: PhysicalPosition::new(10.0, 12.0),
            settle_size: PhysicalSize::new(720, 480),
            settle_min: PhysicalSize::new(640, 480),
            targets: targets(),
        };
        assert_send_sync(&session);
    }
}
