//! OpenMD 的 Windows 资源管理器集成:`.md` 等扩展名的文件关联,以及文件夹右键菜单项。
//!
//! 主程序、安装器、卸载器共用这一份注册表读写实现。三处各写一份时,注册表键名与
//! 命令格式会各自漂移,升级后新旧两套注册项同时留在用户机器上。

use std::path::Path;

/// Markdown 文档的 ProgID。已发布版本按这个名字写过用户机器,改名会让所有已安装
/// 用户的文件关联失效,所以它是跨版本兼容的常量,不是可调参数。
pub const MD_PROG_ID: &str = "OpenMD.Markdown";
pub const MD_PROG_DESC: &str = "OpenMD Markdown Document";
pub const MD_EXTENSIONS: [&str; 4] = [".md", ".markdown", ".mdown", ".mkd"];

/// 文件夹右键菜单项。写入 `HKCU\Software\Classes\Directory\shell\<键>`,
/// 因此只在**选中**文件夹时出现,不会出现在文件夹空白处或驱动器上。
pub const FOLDER_VERB_KEY: &str = "OpenWithOpenMD";
pub const FOLDER_VERB_LABEL: &str = "Open with OpenMD";

/// 注册表操作失败。变体按失败阶段划分,让各调用方挑对应的本地化提示,
/// 而不用在一个扁平的错误串里区分阶段。
#[derive(Debug)]
pub enum ShellVerbError {
    /// 打开或创建注册表键失败
    Key(&'static str, std::io::Error),
    /// 写入注册表值失败
    Write(&'static str, std::io::Error),
    /// 删除注册表键或值失败
    Delete(&'static str, std::io::Error),
}

impl std::fmt::Display for ShellVerbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Key(action, e) | Self::Write(action, e) | Self::Delete(action, e) => {
                write!(f, "{action}: {e}")
            }
        }
    }
}

impl std::error::Error for ShellVerbError {}

/// shell 动词的 `command` 值:启动 exe 并把被操作的路径作为唯一参数传入。
/// 路径加引号,安装目录含空格时仍能正确解析。
pub fn command_line(exe: &Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

/// `DefaultIcon` 值。`,0` 取 ico 里的第一张图。
pub fn default_icon_line(icon: &Path) -> String {
    format!("\"{}\",0", icon.display())
}

/// verb 菜单项的 `Icon` 值。与 `DefaultIcon` 不同,这里取纯路径不带索引。
pub fn verb_icon_line(icon: &Path) -> String {
    format!("\"{}\"", icon.display())
}

mod imp;

pub use imp::{
    folder_verb_is_registered, md_is_associated, register_folder_verb, register_md,
    unregister_folder_verb, unregister_md,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> &Path {
        Path::new(s)
    }

    #[test]
    fn command_line_quotes_both_the_exe_and_the_shell_placeholder() {
        assert_eq!(
            command_line(p(r#"C:\Program Files\OpenMD\openmd.exe"#)),
            r#""C:\Program Files\OpenMD\openmd.exe" "%1""#
        );
    }

    #[test]
    fn default_icon_picks_the_first_image_of_the_ico() {
        assert_eq!(
            default_icon_line(p(r#"C:\a b\icon.ico"#)),
            r#""C:\a b\icon.ico",0"#
        );
    }

    #[test]
    fn verb_icon_has_no_image_index() {
        assert_eq!(
            verb_icon_line(p(r#"C:\a b\icon.ico"#)),
            r#""C:\a b\icon.ico""#
        );
    }

    #[test]
    fn errors_name_the_stage_that_failed() {
        let io = std::io::Error::other("boom");
        assert_eq!(
            ShellVerbError::Key("create folder verb", io).to_string(),
            "create folder verb: boom"
        );
    }
}
