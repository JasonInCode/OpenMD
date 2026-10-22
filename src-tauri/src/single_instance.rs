//! 单实例转发:同一份可执行文件只留一个实例,后启动的把命令行参数转给先启动的
//! 那个,自己随即结束。
//!
//! 身份按**可执行文件路径**区分,而不是按应用 identifier。dev 构建与已安装版
//! 共用 identifier,按 identifier 区分时两者会互相抢单:资源管理器把「Open with
//! OpenMD」投递给已安装版,已安装版却把路径转发给了 dev 构建 —— 用户点的程序
//! 没反应,路径还进了另一个进程。
//!
//! 参数用 JSON 传递,原样往返:按分隔符拼接再切分会切坏本身带分隔符的路径。

use std::ffi::c_void;
use tauri::plugin::{self, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Wry};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HWND, LPARAM, LRESULT, WPARAM, ERROR_ALREADY_EXISTS,
};
use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowW, GetWindowLongPtrW,
    RegisterClassExW, SendMessageW, SetWindowLongPtrW, CREATESTRUCTW, GWLP_USERDATA, HWND_MESSAGE,
    WNDCLASSEXW, WM_COPYDATA, WM_CREATE, WM_DESTROY,
};

/// 转发用的消息编号:与其它用途的 WM_COPYDATA 区分开,避免误解析。
const WM_COPYDATA_ARGS: usize = 0x4F4D_4441;

/// 收到转发时回调:参数与 `std::env::args()` 同形,首项是可执行文件路径。
type ArgsCallback = Box<dyn FnMut(&AppHandle, Vec<String>) + Send + 'static>;

/// 主实例持有的互斥体:退出时释放,免得下次启动被误判成"已有实例"。
/// 句柄以整数保存:裸指针不是 Send/Sync,进不了 Tauri 的状态表。
struct MutexHandle(isize);

/// 主实例持有的转发窗口:第二实例按窗口类与标题找到它。
struct TargetWindowHandle(isize);

struct UserData {
    app: AppHandle,
    callback: ArgsCallback,
}

/// 注册单实例转发插件。必须在应用创建任何窗口之前注册:第二实例要赶在窗口
/// 出现之前把参数转走并结束,否则会先闪一扇空窗口。
pub fn plugin<F>(callback: F) -> TauriPlugin<Wry>
where
    F: FnMut(&AppHandle, Vec<String>) + Send + 'static,
{
    plugin::Builder::new("single-instance")
        .setup(|app, _api| {
            install(app, Box::new(callback));
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                destroy(app);
            }
        })
        .build()
}

/// 窗口与互斥体都挂在可执行文件路径的哈希上:同一份 exe 才算"同一个应用"。
fn instance_key() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    format!("OpenMD-si-{:016x}", fnv1a(exe.to_string_lossy().as_bytes()))
}

/// FNV-1a:只用于给路径算一个稳定的名字,不是安全哈希。
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 转发参数。已在运行时:同一份 exe 的第二个实例把参数交给第一个,自己结束。
fn install(app: &AppHandle, callback: ArgsCallback) {
    let key = instance_key();
    let mutex_name = wide(&format!("{key}-mtx"));
    let class_name = wide(&format!("{key}-cls"));
    let window_name = wide(&format!("{key}-wnd"));

    let hmutex = unsafe { CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr()) };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let hwnd = unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
        if !hwnd.is_null() {
            forward(hwnd);
            app.cleanup_before_exit();
            std::process::exit(0);
        }
        // 互斥体还在但转发窗口已经没了(主实例正在启动):自己当主实例,
        // 照样建转发窗口,不然往后的转发就没人接。
    }
    app.manage(MutexHandle(hmutex as isize));
    let userdata = Box::into_raw(Box::new(UserData {
        app: app.clone(),
        callback,
    }));
    let hwnd = create_target_window(&class_name, &window_name, userdata);
    app.manage(TargetWindowHandle(hwnd as isize));
}

fn forward(hwnd: HWND) {
    let args = std::env::args().collect::<Vec<String>>();
    let Ok(payload) = serde_json::to_vec(&args) else {
        return;
    };
    let cds = COPYDATASTRUCT {
        dwData: WM_COPYDATA_ARGS,
        cbData: payload.len() as u32,
        lpData: payload.as_ptr() as *mut c_void,
    };
    unsafe { SendMessageW(hwnd, WM_COPYDATA, 0, &cds as *const _ as LPARAM) };
}

fn create_target_window(
    class_name: &[u16],
    window_name: &[u16],
    userdata: *mut UserData,
) -> HWND {
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: 0,
            lpfnWndProc: Some(target_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        RegisterClassExW(&class);
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            userdata as *const c_void,
        )
    }
}

unsafe extern "system" fn target_window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
            0
        }
        WM_COPYDATA => {
            let cds = &*(lparam as *const COPYDATASTRUCT);
            if cds.dwData == WM_COPYDATA_ARGS {
                let userdata = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut UserData);
                let bytes = std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
                match serde_json::from_slice::<Vec<String>>(bytes) {
                    Ok(args) => (userdata.callback)(&userdata.app, args),
                    Err(e) => crate::debug_log(&userdata.app, &format!("单实例参数解析失败: {e}")),
                }
            }
            1
        }
        WM_DESTROY => {
            let userdata = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut UserData;
            if !userdata.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(userdata));
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 释放单实例占用的系统资源:窗口与互斥体。
pub fn destroy(app: &AppHandle) {
    if let Some(mutex) = app.try_state::<MutexHandle>() {
        unsafe {
            ReleaseMutex(mutex.0 as HANDLE);
            CloseHandle(mutex.0 as HANDLE);
        }
    }
    if let Some(window) = app.try_state::<TargetWindowHandle>() {
        unsafe { DestroyWindow(window.0 as HWND) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_follows_the_executable_not_the_app_identifier() {
        let key = instance_key();
        assert!(key.starts_with("OpenMD-si-"));
        // 同一路径必须算出同一个身份,否则同一份 exe 会被当成两个实例。
        assert_eq!(key, instance_key());
    }

    #[test]
    fn the_key_differs_between_executables() {
        let a = fnv1a(b"C:\\Program Files\\OpenMD\\openmd.exe");
        let b = fnv1a(b"D:\\dev\\target\\debug\\openmd.exe");
        assert_ne!(a, b);
    }

    #[test]
    fn arguments_survive_the_round_trip() {
        let args = vec![
            r#"C:\Program Files\OpenMD\openmd.exe"#.to_string(),
            r#"D:\a|b\文档.md"#.to_string(),
            "D:\\空 格\\目录".to_string(),
        ];
        let payload = serde_json::to_vec(&args).unwrap();
        let back: Vec<String> = serde_json::from_slice(&payload).unwrap();
        assert_eq!(back, args);
    }
}
