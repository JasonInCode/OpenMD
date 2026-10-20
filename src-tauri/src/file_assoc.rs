//! 运行时资源管理器集成(Windows):Markdown 文件关联与文件夹右键菜单项。
//! 注册表读写委托给 `openmd-shell-verb`,与安装器、卸载器共用同一份实现。

use openmd_shell_verb::ShellVerbError;
use std::path::PathBuf;
use tauri::Manager;

/// 关联文件的图标(由 file.png 转换的多尺寸 ico;Windows 注册表图标不支持 PNG)
const MD_FILE_ICON_BYTES: &[u8] = include_bytes!("../icons/md-file.ico");

/// 右键菜单项图标,与程序图标同源
const APP_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");

/// 注册表只能引用磁盘上的文件,内嵌资源得先落到应用数据目录。
fn write_icon(app: &tauri::AppHandle, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| {
        rust_i18n::t!("file_assoc.app_data_dir_unavailable", error = e).into_owned()
    })?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let icon_path = dir.join(name);
    std::fs::write(&icon_path, bytes).map_err(|e| e.to_string())?;
    Ok(icon_path)
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| rust_i18n::t!("file_assoc.exe_path_unavailable", error = e).into_owned())
}

/// 共享 crate 按失败阶段区分错误,这里挑对应的本地化提示。
fn describe(e: ShellVerbError) -> String {
    match &e {
        ShellVerbError::Unsupported => rust_i18n::t!("file_assoc.windows_only").into_owned(),
        ShellVerbError::Key(..) | ShellVerbError::Write(..) => {
            rust_i18n::t!("file_assoc.registry_write_failed", error = e).into_owned()
        }
        ShellVerbError::Delete(..) => {
            rust_i18n::t!("file_assoc.registry_delete_failed", error = e).into_owned()
        }
    }
}

#[tauri::command]
pub fn is_md_associated() -> bool {
    openmd_shell_verb::md_is_associated()
}

#[tauri::command]
pub fn register_md_association(app: tauri::AppHandle) -> Result<(), String> {
    let exe = current_exe()?;
    let icon = write_icon(&app, "md-file.ico", MD_FILE_ICON_BYTES)?;
    openmd_shell_verb::register_md(&exe, &icon).map_err(describe)
}

#[tauri::command]
pub fn unregister_md_association() -> Result<(), String> {
    openmd_shell_verb::unregister_md().map_err(describe)
}

#[tauri::command]
pub fn is_folder_verb_registered() -> Result<bool, String> {
    let exe = current_exe()?;
    Ok(openmd_shell_verb::folder_verb_is_registered(&exe))
}

#[tauri::command]
pub fn register_folder_verb(app: tauri::AppHandle) -> Result<(), String> {
    let exe = current_exe()?;
    let icon = write_icon(&app, "app-icon.ico", APP_ICON_BYTES)?;
    openmd_shell_verb::register_folder_verb(&exe, &icon).map_err(describe)
}

#[tauri::command]
pub fn unregister_folder_verb() -> Result<(), String> {
    openmd_shell_verb::unregister_folder_verb().map_err(describe)
}
