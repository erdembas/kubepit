use std::path::{Path, PathBuf};

/// The login shell for local terminals: `settings.shell_path` when it points
/// at an existing file, else the platform default.
pub(super) fn shell_for(override_path: Option<&str>) -> (PathBuf, Vec<String>) {
    if let Some(custom) = override_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        let args = login_args_for(&custom);
        return (custom, args);
    }
    default_shell()
}

pub(super) fn default_shell() -> (PathBuf, Vec<String>) {
    if let Some(custom) = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        let args = login_args_for(&custom);
        return (custom, args);
    }

    #[cfg(target_os = "macos")]
    {
        let zsh = PathBuf::from("/bin/zsh");
        let args = login_args_for(&zsh);
        (zsh, args)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for candidate in ["/bin/bash", "/bin/sh"] {
            let path = PathBuf::from(candidate);
            if path.is_file() {
                let args = login_args_for(&path);
                return (path, args);
            }
        }
        let sh = PathBuf::from("/bin/sh");
        let args = login_args_for(&sh);
        (sh, args)
    }

    #[cfg(windows)]
    {
        if let Some(pwsh) = find_in_path("pwsh.exe") {
            return (pwsh, vec!["-NoLogo".to_string()]);
        }
        if let Some(ps) = find_in_path("powershell.exe") {
            return (ps, vec!["-NoLogo".to_string()]);
        }
        let comspec = std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("cmd.exe"));
        (comspec, Vec::new())
    }
}

fn login_args_for(path: &Path) -> Vec<String> {
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match name.as_str() {
        "sh" | "dash" | "ash" => vec!["-l".to_string()],
        "pwsh" | "powershell" => vec!["-NoLogo".to_string()],
        "cmd" => Vec::new(),
        _ => vec!["-i".to_string(), "-l".to_string()],
    }
}

#[cfg(windows)]
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_args_known_shells() {
        assert_eq!(
            login_args_for(Path::new("/bin/bash")),
            vec!["-i".to_string(), "-l".to_string()]
        );
        assert_eq!(
            login_args_for(Path::new("/usr/local/bin/zsh")),
            vec!["-i".to_string(), "-l".to_string()]
        );
        assert_eq!(
            login_args_for(Path::new("/usr/local/bin/fish")),
            vec!["-i".to_string(), "-l".to_string()]
        );
        assert_eq!(login_args_for(Path::new("/bin/sh")), vec!["-l".to_string()]);
        assert_eq!(
            login_args_for(Path::new("/bin/dash")),
            vec!["-l".to_string()]
        );
        assert_eq!(login_args_for(Path::new("cmd.exe")), Vec::<String>::new());
        assert_eq!(
            login_args_for(Path::new("pwsh.exe")),
            vec!["-NoLogo".to_string()]
        );
        assert_eq!(
            login_args_for(Path::new("powershell.exe")),
            vec!["-NoLogo".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_override_falls_back_to_default_shell() {
        assert_eq!(shell_for(Some("/no/such/shell")), default_shell());
        assert_eq!(shell_for(Some("  ")), default_shell());
        let (path, args) = shell_for(Some("/bin/sh"));
        assert_eq!(path, PathBuf::from("/bin/sh"));
        assert_eq!(args, vec!["-l".to_string()]);
    }

    #[test]
    fn login_args_unknown_shell_defaults_to_interactive_login() {
        assert_eq!(
            login_args_for(Path::new("/usr/local/bin/nu")),
            vec!["-i".to_string(), "-l".to_string()]
        );
    }
}
