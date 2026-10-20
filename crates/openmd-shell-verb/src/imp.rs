//! 注册表读写实现。所有写入都落在 `HKCU\Software\Classes`:HKCR 是 HKCU 与 HKLM
//! 的合并视图,写用户态不需要管理员权限,卸载时也能干净清掉。

use super::{
    command_line, default_icon_line, verb_icon_line, ShellVerbError, FOLDER_VERB_KEY,
    FOLDER_VERB_LABEL, MD_EXTENSIONS, MD_PROG_DESC, MD_PROG_ID,
};
use std::path::Path;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

fn classes_root() -> Result<RegKey, ShellVerbError> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
        .map_err(|e| ShellVerbError::Key("open HKCU\\Software\\Classes", e))
}

/// 资源管理器缓存了菜单项与图标,注册表改动后要通知它重新读取。
fn notify_shell() {
    unsafe {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

fn folder_verb_key() -> String {
    format!("Directory\\shell\\{FOLDER_VERB_KEY}")
}

pub fn md_is_associated() -> bool {
    let Ok(classes) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Classes\\.md")
    else {
        return false;
    };
    let prog_id: String = classes.get_value("").unwrap_or_default();
    prog_id == MD_PROG_ID
}

pub fn register_md(exe: &Path, icon: &Path) -> Result<(), ShellVerbError> {
    let classes = classes_root()?;

    let (prog, _) = classes
        .create_subkey(MD_PROG_ID)
        .map_err(|e| ShellVerbError::Key("create ProgID", e))?;
    prog.set_value("", &MD_PROG_DESC)
        .map_err(|e| ShellVerbError::Write("set ProgID description", e))?;
    prog.create_subkey("DefaultIcon")
        .map_err(|e| ShellVerbError::Key("create DefaultIcon", e))?
        .0
        .set_value("", &default_icon_line(icon))
        .map_err(|e| ShellVerbError::Write("set DefaultIcon", e))?;
    prog.create_subkey("shell\\open\\command")
        .map_err(|e| ShellVerbError::Key("create ProgID open command", e))?
        .0
        .set_value("", &command_line(exe))
        .map_err(|e| ShellVerbError::Write("set ProgID open command", e))?;

    for ext in MD_EXTENSIONS {
        let (key, _) = classes
            .create_subkey(ext)
            .map_err(|e| ShellVerbError::Key("create extension key", e))?;
        key.set_value("", &MD_PROG_ID)
            .map_err(|e| ShellVerbError::Write("set extension ProgID", e))?;
    }

    notify_shell();
    Ok(())
}

pub fn unregister_md() -> Result<(), ShellVerbError> {
    let classes = classes_root()?;
    classes
        .delete_subkey_all(MD_PROG_ID)
        .map_err(|e| ShellVerbError::Delete("delete ProgID", e))?;

    // 扩展名的默认值可能已经被别的阅读器改过,只在自己仍然占用时才清空。
    for ext in MD_EXTENSIONS {
        if let Ok(key) = classes.open_subkey_with_flags(ext, KEY_READ | KEY_WRITE) {
            let prog_id: String = key.get_value("").unwrap_or_default();
            if prog_id == MD_PROG_ID {
                key.delete_value("")
                    .map_err(|e| ShellVerbError::Delete("clear extension ProgID", e))?;
            }
        }
    }

    notify_shell();
    Ok(())
}

/// 菜单项是否指向**当前**这个 exe。比对 command 而不只是看键在不在:用户换了安装
/// 目录之后,残留的注册项会指向一个不存在的程序,此时设置页必须显示未注册。
pub fn folder_verb_is_registered(exe: &Path) -> bool {
    let Ok(classes) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Classes") else {
        return false;
    };
    let Ok(verb) = classes.open_subkey(&folder_verb_key()) else {
        return false;
    };
    let Ok(command) = verb.open_subkey("command") else {
        return false;
    };
    let registered: String = command.get_value("").unwrap_or_default();
    registered == command_line(exe)
}

pub fn register_folder_verb(exe: &Path, icon: &Path) -> Result<(), ShellVerbError> {
    let classes = classes_root()?;
    let (verb, _) = classes
        .create_subkey(&folder_verb_key())
        .map_err(|e| ShellVerbError::Key("create folder verb", e))?;
    // 只写 MUIVerb、不写键的默认值:Explorer 优先取 MUIVerb 作为菜单文字。
    verb.set_value("MUIVerb", &FOLDER_VERB_LABEL)
        .map_err(|e| ShellVerbError::Write("set folder verb label", e))?;
    verb.set_value("Icon", &verb_icon_line(icon))
        .map_err(|e| ShellVerbError::Write("set folder verb icon", e))?;
    // 单选模型:框选多个文件夹时菜单项直接不出现,避免只打开其中一个却看着像
    // 打开了全部。
    verb.set_value("MultiSelectModel", &"Single")
        .map_err(|e| ShellVerbError::Write("set folder verb selection model", e))?;
    verb.create_subkey("command")
        .map_err(|e| ShellVerbError::Key("create folder verb command", e))?
        .0
        .set_value("", &command_line(exe))
        .map_err(|e| ShellVerbError::Write("set folder verb command", e))?;

    notify_shell();
    Ok(())
}

pub fn unregister_folder_verb() -> Result<(), ShellVerbError> {
    let classes = classes_root()?;
    // 从未注册过时 `Directory\shell` 可能整个不存在,这不算失败。
    let Ok(shell) = classes.open_subkey_with_flags("Directory\\shell", KEY_READ | KEY_WRITE) else {
        return Ok(());
    };
    shell
        .delete_subkey_all(FOLDER_VERB_KEY)
        .map_err(|e| ShellVerbError::Delete("delete folder verb", e))?;

    notify_shell();
    Ok(())
}
