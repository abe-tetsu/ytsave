use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 実行中の yt-dlp プロセス（中止用）
struct Running(Mutex<Option<Child>>);

#[derive(Serialize, Clone)]
struct Progress {
    percent: f64,
    speed: String,
    eta: String,
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// 同梱バイナリはアプリ本体と同じディレクトリに置かれる
fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("実行ファイルの場所が取得できません")?;
    let p = dir.join(exe_name(name));
    if p.exists() {
        Ok(p)
    } else {
        Err(format!("{} が見つかりません: {}", name, p.display()))
    }
}

/// yt-dlp は自己更新（-U）できるよう、アプリのデータフォルダにコピーしたものを使う。
/// アプリ本体の中身を書き換えずに済み、更新後もアプリの再インストールで戻せる。
fn ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(exe_name("yt-dlp"));
    if !dst.exists() {
        let src = sidecar_path("yt-dlp")?;
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(dst)
}

#[allow(unused_mut)]
fn command(path: &Path) -> Command {
    let mut c = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: コンソール窓を出さない
    }
    c
}

/// yt-dlp とその子プロセス（ffmpeg）をまとめて止める。
/// 親だけ殺すと ffmpeg が残ってファイルを掴み続ける。
fn kill_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        let _ = command(Path::new("taskkill"))
            .args(["/PID", &pid, "/T", "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        // download() で process_group(0) にしているので、グループごと止められる
        let _ = Command::new("kill").args(["--", &format!("-{pid}")]).output();
    }
    let _ = child.kill();
}

fn cancel_running(app: &AppHandle) {
    if let Some(mut child) = app.state::<Running>().0.lock().unwrap().take() {
        kill_tree(&mut child);
    }
}

fn run_capture(path: &Path, args: &[&str]) -> Result<String, String> {
    let out = command(path)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string()
        + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

/// "[download]  45.3% of 12.34MiB at 2.50MiB/s ETA 00:05" を読み取る
fn parse_progress(line: &str) -> Option<Progress> {
    if !line.starts_with("[download]") {
        return None;
    }
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let percent = tokens
        .iter()
        .find(|t| t.ends_with('%'))
        .and_then(|t| t.trim_end_matches('%').parse::<f64>().ok())?;
    let after = |key: &str| -> String {
        tokens
            .iter()
            .position(|t| *t == key)
            .and_then(|i| tokens.get(i + 1))
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    Some(Progress {
        percent,
        speed: after("at"),
        eta: after("ETA"),
    })
}

#[tauri::command]
async fn download(
    app: AppHandle,
    url: String,
    mode: String,
    out_dir: String,
) -> Result<String, String> {
    let ytdlp = ytdlp_path(&app)?;
    let ffmpeg = sidecar_path("ffmpeg")?;
    // 途中ファイル（.part、結合前の映像/音声、mp3 変換前の音声）は一時フォルダに置き、
    // 完成した1ファイルだけを保存先に移す
    let temp_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("tmp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    let mut c = command(&ytdlp);
    // Windows で日本語タイトルをパイプに書く際のエンコードエラーを防ぐ（yt-dlp は Python 製）
    c.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    c.args(["--newline", "--progress", "--no-simulate", "--no-playlist", "--no-colors"])
        .arg("--ffmpeg-location")
        .arg(&ffmpeg)
        .arg("-P")
        .arg(format!("home:{out_dir}"))
        .arg("-P")
        .arg(format!("temp:{}", temp_dir.display()))
        .args(["-o", "%(title)s.%(ext)s"])
        // 完成したファイルのパスを FILE: 付きで出力させる（後処理・移動の後）
        .args(["--print", "after_move:FILE:%(filepath)s"]);
    if mode == "mp3" {
        c.args(["-x", "--audio-format", "mp3", "--audio-quality", "0"]);
    } else {
        // 編集ソフト（PowerDirector 等）で確実に読める H.264 + AAC を優先する。
        // YouTube の高画質は AV1 / VP9 が多く、そのまま落とすと映像が再生できないことがある。
        c.args([
            "-f",
            "bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
            "--merge-output-format",
            "mp4",
        ]);
    }
    c.arg(&url).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let out_dir_fallback = out_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = c.spawn().map_err(|e| format!("yt-dlp を起動できません: {e}"))?;
        let stdout = child.stdout.take().ok_or("stdout が取れません")?;
        let stderr = child.stderr.take().ok_or("stderr が取れません")?;
        *app.state::<Running>().0.lock().unwrap() = Some(child);

        // stderr は別スレッドで読み、ERROR 行と最後の行を保持しておく
        let app2 = app.clone();
        let err_reader = std::thread::spawn(move || {
            let mut last_err = String::new();
            let mut last_line = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app2.emit("dl:log", &line);
                if line.starts_with("ERROR") {
                    last_err = line.clone();
                }
                last_line = line;
            }
            (last_err, last_line)
        });

        let mut file_path = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("FILE:") {
                file_path = rest.to_string();
                continue;
            }
            if let Some(p) = parse_progress(&line) {
                let _ = app.emit("dl:progress", p);
            } else if line.starts_with("[Merger]") || line.starts_with("[ExtractAudio]") {
                let _ = app.emit("dl:status", "変換中…");
            }
            let _ = app.emit("dl:log", &line);
        }

        let (last_err, last_line) = err_reader.join().unwrap_or_default();
        let status = {
            let state = app.state::<Running>();
            let mut guard = state.0.lock().unwrap();
            match guard.take() {
                Some(mut child) => child.wait().map_err(|e| e.to_string())?,
                None => return Err("中止しました".into()),
            }
        };
        let _ = app.emit(
            "dl:log",
            format!("[app] exit={:?} file={:?}", status.code(), file_path),
        );
        if status.success() {
            // FILE: 行が取れなかった場合も保存はできているので、保存先フォルダを返す
            Ok(if file_path.is_empty() { out_dir_fallback } else { file_path })
        } else if !last_err.is_empty() {
            Err(last_err.trim_start_matches("ERROR:").trim().to_string())
        } else {
            Err(format!(
                "ダウンロードに失敗しました（終了コード {}）{}",
                status.code().map(|c| c.to_string()).unwrap_or("不明".into()),
                if last_line.is_empty() { String::new() } else { format!(": {last_line}") }
            ))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_download(app: AppHandle) {
    cancel_running(&app);
}

#[tauri::command]
fn ytdlp_version(app: AppHandle) -> Result<String, String> {
    run_capture(&ytdlp_path(&app)?, &["--version"])
}

#[tauri::command]
async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let path = ytdlp_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || run_capture(&path, &["-U"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn default_download_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .download_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Running(Mutex::new(None)))
        // ダウンロード中にウィンドウを閉じても ffmpeg を残さない
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                cancel_running(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            download,
            cancel_download,
            ytdlp_version,
            update_ytdlp,
            default_download_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
