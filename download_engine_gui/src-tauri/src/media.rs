//! Video pages — YouTube and the other sites yt-dlp understands — downloaded by
//! running yt-dlp, with ffmpeg alongside to merge the separate video and audio
//! streams those sites serve.
//!
//! ## Why not the engine
//!
//! The engine downloads one HTTP resource. A YouTube video is not one: video
//! and audio arrive as separate adaptive streams, their URLs are signed per
//! session and expire, and the throttling parameter has to be solved by running
//! the player's own JavaScript. yt-dlp keeps up with all of that as sites
//! change, which is not something worth re-implementing here.
//!
//! ## Where the tools come from
//!
//! Fetched quietly the first time a video is asked for, from the projects' own
//! GitHub releases into the app's data folder; never bundled and never put on
//! PATH. Each file is checked against the SHA-256 list published with the same
//! release before it is kept, so a truncated or tampered download is refused
//! rather than executed. yt-dlp then updates itself in the background every few
//! days, since sites like YouTube change often enough to break an old copy.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_SUMS: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";
const FFMPEG_ZIP: &str = "ffmpeg-master-latest-win64-gpl.zip";
const FFMPEG_URL: &str = "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";
const FFMPEG_SUMS: &str = "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/checksums.sha256";

/// Keeps yt-dlp from opening a console window for every run.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Heights offered in the quality menu, when the video has them.
const LADDER: &[u32] = &[2160, 1440, 1080, 720, 480, 360];

/// How often yt-dlp is asked to update itself.
const UPDATE_EVERY: std::time::Duration = std::time::Duration::from_secs(3 * 24 * 60 * 60);
const UPDATE_STAMP: &str = "yt-dlp.updated";

#[derive(Default)]
pub struct MediaState {
    procs: Mutex<HashMap<String, Running>>,
    /// Held while the tools are installed or updated, and briefly by every run
    /// before it starts, so nothing launches yt-dlp while it is being replaced.
    tools: tokio::sync::Mutex<()>,
    updating: AtomicBool,
}

struct Running {
    child: Arc<tokio::sync::Mutex<Child>>,
    /// Why the process is being stopped, so its exit can be reported as what
    /// the user asked for rather than as a failure.
    stop: Arc<Mutex<Option<StopReason>>>,
}

#[derive(Clone, Copy, PartialEq)]
enum StopReason {
    Pause,
    Cancel,
}

#[derive(Clone, Serialize)]
pub struct ToolsStatus {
    pub ytdlp: bool,
    pub ffmpeg: bool,
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    tool: &'static str,
    downloaded: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
pub struct Choice {
    /// What `media_download` is told: `best`, `v1080`, `m4a`, `mp3`.
    pub id: String,
    pub label: String,
    pub detail: String,
}

#[derive(Clone, Serialize)]
pub struct MediaInfo {
    pub title: String,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub uploader: Option<String>,
    pub choices: Vec<Choice>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum MediaResult {
    Completed { path: String },
    Paused,
    Cancelled,
}

#[derive(Clone, Serialize)]
struct MediaStatus {
    job_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct JobProgress {
    job_id: String,
    downloaded: u64,
    total: u64,
}

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no app data directory: {e}"))?.join("tools");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn ytdlp_path(dir: &Path) -> PathBuf {
    dir.join("yt-dlp.exe")
}

fn ffmpeg_path(dir: &Path) -> PathBuf {
    dir.join("ffmpeg.exe")
}

pub fn status(app: &AppHandle) -> Result<ToolsStatus, String> {
    let dir = tools_dir(app)?;
    Ok(ToolsStatus {
        ytdlp: ytdlp_path(&dir).is_file(),
        ffmpeg: ffmpeg_path(&dir).is_file(),
    })
}

#[tauri::command]
pub fn media_tools_status(app: AppHandle) -> Result<ToolsStatus, String> {
    status(&app)
}

/// Fetches `url` into memory, reporting progress as it goes. The tools are
/// tens of megabytes, small enough that holding one in memory to hash it before
/// it touches the disk is simpler than hashing a file after the fact.
async fn fetch(app: &AppHandle, client: &reqwest::Client, url: &str, tool: &'static str, on_progress: &(dyn Fn(&'static str, u64, u64) + Send + Sync)) -> Result<Vec<u8>, String> {
    let mut res = client.get(url).send().await.map_err(|e| format!("{tool}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{tool}: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut buf = Vec::with_capacity(total as usize);
    let mut last = 0u64;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("{tool}: {e}"))? {
        buf.extend_from_slice(&chunk);
        let done = buf.len() as u64;
        // A few hundred events per tool is plenty for a progress bar.
        if done - last > 256 * 1024 || done == total {
            last = done;
            let _ = app.emit("media-tools-progress", InstallProgress { tool, downloaded: done, total });
            on_progress(tool, done, total);
        }
    }
    Ok(buf)
}

/// The expected hash for `file` in a `sha256sum`-style list.
fn expected_hash(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == file).then(|| hash.to_ascii_lowercase())
    })
}

fn verify(bytes: &[u8], sums: &str, file: &str) -> Result<(), String> {
    let expected = expected_hash(sums, file).ok_or_else(|| format!("{file} is not in the release's checksum list"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err(format!("{file} failed its checksum, so it was not installed"));
    }
    Ok(())
}

/// Writes next to the target and renames over it, so a crash mid-write never
/// leaves a half-written executable where the app would later run it.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("download");
    std::fs::write(&tmp, bytes).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("failed to install {}: {e}", path.display()))
}

#[tauri::command]
pub async fn install_media_tools(app: AppHandle, state: State<'_, MediaState>) -> Result<ToolsStatus, String> {
    ensure_tools(&app, &state, &|_, _, _| {}).await?;
    status(&app)
}

/// Makes sure both tools are in place, installing whatever is missing. Every
/// caller waits on the same lock, so two videos added at once share one
/// install instead of racing to write the same files.
pub async fn ensure_tools(app: &AppHandle, state: &MediaState, on_progress: &(dyn Fn(&'static str, u64, u64) + Send + Sync)) -> Result<(), String> {
    let _guard = state.tools.lock().await;
    let have = status(app)?;
    if have.ytdlp && have.ffmpeg {
        return Ok(());
    }
    install(app, on_progress).await
}

/// Installs in the background without waiting, for the browser bridge: the
/// extension shows "setting up" and asks again until the tools are ready.
pub fn ensure_tools_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MediaState>();
        if let Err(e) = ensure_tools(&app, &state, &|_, _, _| {}).await {
            eprintln!("media: background install failed: {e}");
        }
    });
}

/// Run once at startup: updates yt-dlp if the last check was a while ago.
/// Uses yt-dlp's own `-U`, which fetches the newest release and checks it
/// against the release's hashes before swapping it in.
pub fn update_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MediaState>();
        let Ok(dir) = tools_dir(&app) else { return };
        let exe = ytdlp_path(&dir);
        let stamp = dir.join(UPDATE_STAMP);
        let due = std::fs::metadata(&stamp).and_then(|m| m.modified()).map(|t| t.elapsed().unwrap_or_default() > UPDATE_EVERY).unwrap_or(true);
        if !exe.is_file() || !due || state.updating.swap(true, Ordering::SeqCst) {
            return;
        }
        let _guard = state.tools.lock().await;
        let mut cmd = Command::new(&exe);
        cmd.args(["-U", "--no-config"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if matches!(cmd.status().await, Ok(s) if s.success()) {
            let _ = std::fs::write(&stamp, b"");
        }
        state.updating.store(false, Ordering::SeqCst);
    });
}

async fn install(app: &AppHandle, on_progress: &(dyn Fn(&'static str, u64, u64) + Send + Sync)) -> Result<(), String> {
    let dir = tools_dir(app)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("nodo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    let exe = ytdlp_path(&dir);
    if !exe.is_file() {
        let sums = String::from_utf8_lossy(&fetch(app, &client, YTDLP_SUMS, "yt-dlp", &|_, _, _| {}).await?).into_owned();
        let bytes = fetch(app, &client, YTDLP_URL, "yt-dlp", on_progress).await?;
        verify(&bytes, &sums, "yt-dlp.exe")?;
        write_atomic(&exe, &bytes)?;
        let _ = std::fs::write(dir.join(UPDATE_STAMP), b"");
    }

    if !ffmpeg_path(&dir).is_file() {
        let sums = String::from_utf8_lossy(&fetch(app, &client, FFMPEG_SUMS, "ffmpeg", &|_, _, _| {}).await?).into_owned();
        let bytes = fetch(app, &client, FFMPEG_URL, "ffmpeg", on_progress).await?;
        verify(&bytes, &sums, FFMPEG_ZIP)?;
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || extract_ffmpeg(&bytes, &dir))
            .await
            .map_err(|e| e.to_string())??;
    }
    Ok(())
}

/// Pulls `ffmpeg.exe` and `ffprobe.exe` out of the build archive, by file name
/// only: the archive's folder layout is the release's business, and nothing
/// else in it is needed.
fn extract_ffmpeg(zip_bytes: &[u8], dir: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| format!("ffmpeg archive: {e}"))?;
    let mut found = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("ffmpeg archive: {e}"))?;
        let name = entry.name().rsplit('/').next().unwrap_or("").to_string();
        if name != "ffmpeg.exe" && name != "ffprobe.exe" {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| format!("ffmpeg archive: {e}"))?;
        write_atomic(&dir.join(&name), &bytes)?;
        found += 1;
    }
    if found < 2 {
        return Err("the ffmpeg archive did not contain ffmpeg.exe and ffprobe.exe".into());
    }
    Ok(())
}

/// A Netscape cookie file for yt-dlp, built from the `Cookie` header the
/// extension read for this site. Written into the tools folder rather than the
/// temp directory, and deleted as soon as the run that needed it ends.
struct CookieFile(PathBuf);

impl CookieFile {
    fn create(dir: &Path, url: &str, cookie: &str) -> Option<Self> {
        let host = reqwest::Url::parse(url).ok()?.host_str()?.to_string();
        // The site's registrable domain, so cookies set on `.youtube.com` reach
        // `www.youtube.com` as the browser would send them.
        let labels: Vec<&str> = host.split('.').collect();
        let domain = if labels.len() >= 2 { format!(".{}", labels[labels.len() - 2..].join(".")) } else { host };
        let mut out = String::from("# Netscape HTTP Cookie File\n");
        for pair in cookie.split(';') {
            let Some((name, value)) = pair.trim().split_once('=') else { continue };
            if name.is_empty() || name.contains(['\t', '\n']) || value.contains(['\t', '\n']) {
                continue;
            }
            out.push_str(&format!("{domain}\tTRUE\t/\tTRUE\t0\t{name}\t{value}\n"));
        }
        let path = dir.join(format!("cookies-{}.txt", rand_suffix()));
        std::fs::write(&path, out).ok()?;
        Some(Self(path))
    }
}

impl Drop for CookieFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn rand_suffix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// The arguments every run shares: request context from the browser, and the
/// switches that keep yt-dlp from doing anything beyond the one video asked for.
fn base_command(exe: &Path, headers: &HashMap<String, String>, cookies: Option<&CookieFile>) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args(["--no-playlist", "--no-warnings", "--no-config", "--encoding", "utf-8"]);
    // Only the request context the engine would also accept. Values reach yt-dlp
    // as single argv entries, never through a shell.
    if let Some(ua) = headers.get("user-agent") {
        cmd.args(["--user-agent", ua.as_str()]);
    }
    if let Some(referer) = headers.get("referer") {
        cmd.args(["--referer", referer.as_str()]);
    }
    if let Some(file) = cookies {
        cmd.arg("--cookies").arg(&file.0);
    }
    cmd.env("PYTHONUTF8", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn require_http(url: &str) -> Result<(), String> {
    let ok = reqwest::Url::parse(url).map(|u| matches!(u.scheme(), "http" | "https")).unwrap_or(false);
    if ok { Ok(()) } else { Err("url must be http or https".into()) }
}

/// Reads what a page offers. Shared by the command and the browser bridge.
pub async fn probe(app: &AppHandle, url: &str, headers: &HashMap<String, String>) -> Result<MediaInfo, String> {
    require_http(url)?;
    let dir = tools_dir(app)?;
    let exe = ytdlp_path(&dir);
    if !exe.is_file() {
        return Err("tools-missing".into());
    }
    let has_ffmpeg = ffmpeg_path(&dir).is_file();
    let cookies = headers.get("cookie").and_then(|c| CookieFile::create(&dir, url, c));

    let mut cmd = base_command(&exe, headers, cookies.as_ref());
    cmd.args(["-J", "--", url]);
    let out = cmd.output().await.map_err(|e| format!("could not run yt-dlp: {e}"))?;
    if !out.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let info: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("unreadable yt-dlp output: {e}"))?;
    Ok(summarise(&info, has_ffmpeg))
}

#[tauri::command]
pub async fn media_probe(app: AppHandle, url: String, headers: Option<HashMap<String, String>>) -> Result<MediaInfo, String> {
    probe(&app, &url, &headers.unwrap_or_default()).await
}

fn size_of(f: &Value) -> u64 {
    f.get("filesize").and_then(Value::as_u64).or_else(|| f.get("filesize_approx").and_then(Value::as_u64)).unwrap_or(0)
}

fn human(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if mb >= 1024.0 { format!("{:.1} GB", mb / 1024.0) } else { format!("{mb:.0} MB") }
}

/// Turns yt-dlp's format list into the handful of choices a person picks from.
fn summarise(info: &Value, has_ffmpeg: bool) -> MediaInfo {
    let formats = info.get("formats").and_then(Value::as_array).cloned().unwrap_or_default();
    let has = |f: &Value, key: &str| f.get(key).and_then(Value::as_str).is_some_and(|c| c != "none");
    let height = |f: &Value| f.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;

    let best_audio = formats.iter().filter(|f| has(f, "acodec") && !has(f, "vcodec")).map(size_of).max().unwrap_or(0);
    let mut choices = Vec::new();
    // Without ffmpeg only files that already hold both streams can be saved.
    let usable: Vec<&Value> = formats.iter().filter(|f| has(f, "vcodec") && (has_ffmpeg || has(f, "acodec"))).collect();
    let top = usable.iter().map(|f| height(f)).max().unwrap_or(0);

    if top > 0 {
        let best_size = usable.iter().filter(|f| height(f) == top).map(|f| size_of(f)).max().unwrap_or(0);
        let extra = if has_ffmpeg { best_audio } else { 0 };
        choices.push(Choice {
            id: "best".into(),
            label: "Best quality".into(),
            detail: format!("{top}p{}", if best_size > 0 { format!(" · ~{}", human(best_size + extra)) } else { String::new() }),
        });
    }
    for &h in LADDER {
        if h > top || !usable.iter().any(|f| height(f) == h) {
            continue;
        }
        let size = usable.iter().filter(|f| height(f) == h).map(|f| size_of(f)).max().unwrap_or(0);
        let extra = if has_ffmpeg { best_audio } else { 0 };
        choices.push(Choice {
            id: format!("v{h}"),
            label: format!("{h}p"),
            detail: format!("MP4{}", if size > 0 { format!(" · ~{}", human(size + extra)) } else { String::new() }),
        });
    }
    if formats.iter().any(|f| has(f, "acodec")) {
        let size = if best_audio > 0 { format!(" · ~{}", human(best_audio)) } else { String::new() };
        if has_ffmpeg {
            choices.push(Choice { id: "m4a".into(), label: "Audio only".into(), detail: format!("M4A{size}") });
            choices.push(Choice { id: "mp3".into(), label: "Audio only".into(), detail: "MP3".into() });
        } else {
            choices.push(Choice { id: "m4a".into(), label: "Audio only".into(), detail: format!("Original format{size}") });
        }
    }
    // A page yt-dlp handles but that lists no formats (a single direct file):
    // still offer the one thing it can do.
    if choices.is_empty() {
        choices.push(Choice { id: "best".into(), label: "Download".into(), detail: "Best available".into() });
    }

    let text = |key: &str| info.get(key).and_then(Value::as_str).map(str::to_string);
    MediaInfo {
        title: text("title").unwrap_or_else(|| "Video".into()),
        thumbnail: text("thumbnail"),
        duration: info.get("duration").and_then(Value::as_f64),
        uploader: text("uploader").or_else(|| text("channel")),
        choices,
    }
}

/// yt-dlp's own explanation of a failure, which is far more useful than an
/// exit code: "Sign in to confirm your age", "Video unavailable".
fn last_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .map(|l| l.trim_start_matches("ERROR:").trim().to_string())
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string()))
        .unwrap_or_else(|| "yt-dlp failed".into())
}

fn format_args(choice: &str, has_ffmpeg: bool) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match (choice, has_ffmpeg) {
        ("mp3", true) => s(&["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"]),
        ("m4a", true) => s(&["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"]),
        ("m4a" | "mp3", false) => s(&["-f", "ba/b"]),
        (c, true) if c.starts_with('v') => {
            let h = c[1..].parse::<u32>().unwrap_or(1080);
            let sort = format!("res:{h},ext:mp4:m4a");
            s(&["-f", "bv*+ba/b", "-S", sort.as_str(), "--merge-output-format", "mp4"])
        }
        (c, false) if c.starts_with('v') => {
            let h = c[1..].parse::<u32>().unwrap_or(1080);
            vec!["-f".into(), format!("b[height<={h}]/b")]
        }
        (_, true) => s(&["-f", "bv*+ba/b", "-S", "ext:mp4:m4a", "--merge-output-format", "mp4"]),
        (_, false) => s(&["-f", "b"]),
    }
}

/// Converts the engine's "500KB" style limit to yt-dlp's "500K".
fn rate_arg(limit: &str) -> Option<String> {
    let l = limit.trim().to_ascii_uppercase();
    if l.is_empty() {
        return None;
    }
    Some(l.trim_end_matches('B').to_string())
}

#[tauri::command]
pub async fn media_download(
    app: AppHandle,
    state: State<'_, MediaState>,
    job_id: String,
    url: String,
    choice: String,
    output_dir: String,
    limit: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<MediaResult, String> {
    require_http(&url)?;
    // First video ever: fetch the tools right here, reporting progress on this
    // job's own row, rather than stopping to ask.
    if !matches!(status(&app), Ok(ToolsStatus { ytdlp: true, ffmpeg: true })) {
        let _ = app.emit("media-status", MediaStatus { job_id: job_id.clone(), text: "Preparing video support…".into() });
    }
    let report = {
        let app = app.clone();
        let job_id = job_id.clone();
        move |_tool: &'static str, done: u64, total: u64| {
            let text = if total > 0 { format!("Preparing video support… {}%", done * 100 / total) } else { "Preparing video support…".into() };
            let _ = app.emit("media-status", MediaStatus { job_id: job_id.clone(), text });
        }
    };
    ensure_tools(&app, &state, &report).await.map_err(|e| format!("Couldn't set up video support: {e}"))?;
    let dir = tools_dir(&app)?;
    let exe = ytdlp_path(&dir);
    let has_ffmpeg = ffmpeg_path(&dir).is_file();
    let headers = headers.unwrap_or_default();
    let cookies = headers.get("cookie").and_then(|c| CookieFile::create(&dir, &url, c));
    let out_dir = if output_dir.trim().is_empty() { std::env::current_dir().map_err(|e| e.to_string())? } else { PathBuf::from(&output_dir) };

    let mut cmd = base_command(&exe, &headers, cookies.as_ref());
    cmd.args(format_args(&choice, has_ffmpeg));
    if has_ffmpeg {
        cmd.arg("--ffmpeg-location").arg(&dir);
    }
    if let Some(rate) = limit.as_deref().and_then(rate_arg) {
        cmd.args(["-r", rate.as_str()]);
    }
    cmd.args(["--newline", "--progress", "--windows-filenames", "--no-mtime", "-N", "4"]);
    cmd.args(["--progress-template", "download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"]);
    // `--print` implies `--quiet`; `--no-quiet` after it keeps the progress
    // lines coming on stdout, which is what drives the bar.
    cmd.args(["--print", "after_move:FILE %(filepath)s", "--no-quiet"]);
    cmd.arg("-P").arg(&out_dir);
    cmd.args(["-o", "%(title).150B [%(id)s].%(ext)s", "--", url.as_str()]);

    let mut child = cmd.spawn().map_err(|e| format!("could not run yt-dlp: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let child = Arc::new(tokio::sync::Mutex::new(child));
    let stop = Arc::new(Mutex::new(None));
    if let Ok(mut procs) = state.procs.lock() {
        procs.insert(job_id.clone(), Running { child: child.clone(), stop: stop.clone() });
    }

    // stderr drained on its own task, so a chatty run can't fill the pipe and stall.
    let err_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 16 * 1024 {
                tail.drain(..tail.len() - 8 * 1024);
            }
        }
        tail
    });

    let mut final_path = None;
    // A merged download fetches video then audio, each counting from zero;
    // what finished before is carried so the bar only moves forward.
    let mut base = 0u64;
    let (mut last_done, mut last_total) = (0u64, 0u64);
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(rest) = line.strip_prefix("PROG ") {
            let mut parts = rest.split_whitespace().map(|p| p.parse::<f64>().ok().map(|v| v as u64));
            let done = parts.next().flatten().unwrap_or(0);
            let total = parts.next().flatten().or(parts.next().flatten()).unwrap_or(0);
            if done + 1024 * 1024 < last_done {
                base += last_total.max(last_done);
            }
            last_done = done;
            last_total = total;
            let _ = app.emit("job-progress", JobProgress { job_id: job_id.clone(), downloaded: base + done, total: base + total.max(done) });
        } else if let Some(path) = line.strip_prefix("FILE ") {
            final_path = Some(path.trim().to_string());
        } else if line.starts_with("[Merger]") || line.starts_with("[ExtractAudio]") || line.starts_with("[VideoConvertor]") {
            let text = if line.starts_with("[Merger]") { "Merging video and audio…" } else { "Converting…" };
            let _ = app.emit("media-status", MediaStatus { job_id: job_id.clone(), text: text.into() });
        }
    }

    let exit = child.lock().await.wait().await.map_err(|e| e.to_string())?;
    let tail = err_task.await.unwrap_or_default();
    if let Ok(mut procs) = state.procs.lock() {
        procs.remove(&job_id);
    }
    drop(cookies);

    match *stop.lock().map_err(|_| "state poisoned")? {
        Some(StopReason::Pause) => return Ok(MediaResult::Paused),
        Some(StopReason::Cancel) => return Ok(MediaResult::Cancelled),
        None => {}
    }
    if !exit.success() {
        return Err(last_error(&tail));
    }
    let path = final_path.ok_or("yt-dlp finished without reporting a file")?;
    Ok(MediaResult::Completed { path })
}

async fn stop_job(state: &MediaState, job_id: &str, reason: StopReason) -> Result<(), String> {
    let (child, stop) = {
        let procs = state.procs.lock().map_err(|_| "state poisoned")?;
        let running = procs.get(job_id).ok_or_else(|| format!("job {job_id} is not running"))?;
        (running.child.clone(), running.stop.clone())
    };
    *stop.lock().map_err(|_| "state poisoned")? = Some(reason);
    // yt-dlp keeps its `.part` files on a kill, and picks them up again on the
    // next run with the same output template — which is what makes pause work.
    child.lock().await.start_kill().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn media_pause(state: State<'_, MediaState>, job_id: String) -> Result<(), String> {
    stop_job(&state, &job_id, StopReason::Pause).await
}

#[tauri::command]
pub async fn media_cancel(state: State<'_, MediaState>, job_id: String) -> Result<(), String> {
    stop_job(&state, &job_id, StopReason::Cancel).await
}
