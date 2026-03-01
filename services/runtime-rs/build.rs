use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

type BuildResult<T> = Result<T, Box<dyn std::error::Error>>;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    emit_git_rerun_hints();

    let version = build_service_version().unwrap_or_else(|error| {
        panic!("Failed to stamp runtime trace version at build time: {error}")
    });
    println!("cargo:rustc-env=APPROACH_VIZ_RUNTIME_BUILD_SERVICE_VERSION={version}");
}

fn build_service_version() -> BuildResult<String> {
    let timestamp = chrono::Utc::now().format("%Y%m%d.%H%M%S").to_string();
    let git_branch = sanitize_version_component(&run_git_command(&["rev-parse", "--abbrev-ref", "HEAD"])?);
    let git_sha = sanitize_version_component(&run_git_command(&["rev-parse", "--short=12", "HEAD"])?);
    let is_dirty = git_worktree_is_dirty()?;

    if git_branch.is_empty() {
        return Err("Resolved git branch is empty after sanitization.".into());
    }
    if git_sha.is_empty() {
        return Err("Resolved git sha is empty after sanitization.".into());
    }
    let mut version = format!("{timestamp}-{git_branch}-{git_sha}");
    if is_dirty {
        version.push_str("-dirty");
    }
    Ok(version)
}

fn git_worktree_is_dirty() -> BuildResult<bool> {
    let output = run_git_command(&["status", "--porcelain", "--untracked-files=normal"])?;
    Ok(!output.is_empty())
}

fn run_git_command(args: &[&str]) -> BuildResult<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace_root())
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {} failed (status: {}). stderr: {}",
            args.join(" "),
            output.status,
            stderr.trim()
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("Failed to resolve workspace root for build metadata.")
}

fn sanitize_version_component(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn emit_git_rerun_hints() {
    let git_dir = match run_git_command(&["rev-parse", "--git-dir"]) {
        Ok(raw) => raw,
        Err(_) => return,
    };
    let git_dir_path = {
        let root = workspace_root();
        let candidate = Path::new(&git_dir);
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            root.join(candidate)
        }
    };

    println!("cargo:rerun-if-changed={}", git_dir_path.join("HEAD").display());
    println!("cargo:rerun-if-changed={}", git_dir_path.join("index").display());

    let head_path = git_dir_path.join("HEAD");
    let head = match fs::read_to_string(head_path) {
        Ok(value) => value,
        Err(_) => return,
    };
    if let Some(reference) = head.strip_prefix("ref: ").map(str::trim) {
        println!(
            "cargo:rerun-if-changed={}",
            git_dir_path.join(reference).display()
        );
    }
}
