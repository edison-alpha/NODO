//! A loopback HTTP endpoint so a browser extension can hand links to the app.
//!
//! ## Why a socket and not Native Messaging
//!
//! A native-messaging host is spawned *per connection* by the browser, so it
//! would be a second process that still has to locate and talk to the running
//! GUI — an extra hop with its own IPC to build. The app is already running and
//! already owns the job list, so the shortest path is to let it listen itself.
//!
//! ## What guards it
//!
//! A loopback socket is reachable by every process on the machine and by any
//! web page the user happens to visit, so "it's only localhost" is not a
//! security model. Three things stand between a caller and a queued download:
//!
//! 1. **Bound to 127.0.0.1**, never `0.0.0.0`, so nothing on the LAN can reach
//!    it.
//! 2. **The `Origin` must not be a web page.** When page JavaScript calls
//!    loopback, the browser attaches an `Origin` the page cannot forge; only
//!    extension origins are accepted, which rules out the drive-by case.
//! 3. **A shared token in a request header.** Needed because the `Origin`
//!    check only binds callers that genuinely are a browser — a local process
//!    can claim any origin it likes. The token travels in a header and never in
//!    the query string: a custom header forces a CORS preflight that a web page
//!    cannot satisfy, so this doubles as the CSRF defence.
//!
//! The listener is off until the user turns it on, because opening a port is
//! not something an app should do behind the user's back.
//!
//! Checks 2 and 3 live in the `bridge_guard` crate so they can be unit-tested
//! without linking Tauri; what remains here is the plumbing around them.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;

use bridge_guard::{check_origin, new_token, token_matches, OriginCheck, TOKEN_HEADER};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, CONTENT_TYPE, VARY,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;

/// Fixed so the extension can find the app without a discovery handshake.
/// High enough to sit in the ephemeral range where nothing well-known lives.
pub const BRIDGE_PORT: u16 = 47283;

const TOKEN_FILE: &str = "bridge-token";

/// Enough for a URL plus a cookie jar, and small enough that a local process
/// cannot make the app allocate its way out of memory on an unread body.
const MAX_BODY_BYTES: usize = 64 * 1024;

const PING_BODY: &str = concat!(
    "{\"app\":\"download-engine\",\"version\":\"",
    env!("CARGO_PKG_VERSION"),
    "\"}"
);

/// What the extension sends to queue a download.
///
/// Deliberately *not* carrying a file name: one supplied from outside would be
/// joined onto the output directory, and `..\..\` in it would write wherever
/// the caller liked. The name keeps coming from the URL, as it does for every
/// other way of adding a job.
#[derive(Deserialize)]
struct DownloadRequest {
    url: String,
    /// Request context the link needs to resolve — a session `Cookie`, a
    /// `Referer` the server checks. Filtered against an allowlist at the
    /// `start_download` boundary, not here, so there is one place to audit.
    #[serde(default)]
    headers: HashMap<String, String>,
}

/// A video page the extension wants saved through yt-dlp. Like a plain
/// download it carries no file name; yt-dlp names the file from the video's
/// own title, sanitised for Windows.
#[derive(Deserialize)]
struct MediaRequest {
    url: String,
    /// One of the ids `/media/formats` returned.
    choice: String,
    /// Shown in the list until yt-dlp reports the real file name.
    #[serde(default)]
    label: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Deserialize)]
struct FormatsRequest {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
struct BridgeMedia {
    url: String,
    choice: String,
    label: String,
    title: String,
    headers: HashMap<String, String>,
}

/// Forwarded to the UI, which owns the job list and decides what to do with it.
#[derive(Clone, Serialize)]
struct BridgeDownload {
    url: String,
    headers: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    pub running: bool,
}

#[derive(Default)]
pub struct BridgeState {
    /// Read from disk on first use; kept so the extension stays paired across
    /// restarts instead of needing a new token every launch.
    token: Mutex<Option<String>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl BridgeState {
    fn token(&self, app: &AppHandle) -> Result<String, String> {
        let mut slot = self.token.lock().map_err(|_| "bridge state poisoned")?;
        if let Some(token) = slot.as_ref() {
            return Ok(token.clone());
        }
        let token = load_or_create_token(app)?;
        *slot = Some(token.clone());
        Ok(token)
    }

    fn running(&self) -> bool {
        self.task.lock().map(|t| t.is_some()).unwrap_or(false)
    }

    fn info(&self, app: &AppHandle) -> Result<BridgeInfo, String> {
        Ok(BridgeInfo {
            port: BRIDGE_PORT,
            token: self.token(app)?,
            running: self.running(),
        })
    }
}

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    Ok(dir.join(TOKEN_FILE))
}

fn load_or_create_token(app: &AppHandle) -> Result<String, String> {
    let path = token_path(app)?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let token = new_token()?;
    std::fs::write(&path, &token).map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    Ok(token)
}

fn respond(status: StatusCode, body: &'static str, origin: Option<HeaderValue>) -> Response<Full<Bytes>> {
    respond_bytes(status, Bytes::from_static(body.as_bytes()), origin)
}

fn respond_json<T: Serialize>(status: StatusCode, body: &T, origin: Option<HeaderValue>) -> Response<Full<Bytes>> {
    let bytes = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    respond_bytes(status, Bytes::from(bytes), origin)
}

fn respond_bytes(status: StatusCode, body: Bytes, origin: Option<HeaderValue>) -> Response<Full<Bytes>> {
    let mut res = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        // The permitted origin differs per request, so a cache must not serve
        // one extension's response to another.
        .header(VARY, "origin")
        .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
        .header(ACCESS_CONTROL_ALLOW_HEADERS, concat!("content-type, ", "x-download-engine-token"))
        .header(ACCESS_CONTROL_MAX_AGE, "600")
        .body(Full::new(body))
        .expect("response built from constants is always valid");
    if let Some(origin) = origin {
        res.headers_mut().insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    res
}

async fn route(app: AppHandle, token: String, req: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    let (parts, body) = req.into_parts();

    let origin = match check_origin(&parts.headers) {
        OriginCheck::Allowed(origin) => origin,
        OriginCheck::Rejected => {
            return Ok(respond(StatusCode::FORBIDDEN, r#"{"error":"origin not allowed"}"#, None));
        }
    };

    // Answered before the token check: a preflight is the browser asking
    // whether it may send the token header at all, so it cannot carry one.
    if parts.method == Method::OPTIONS {
        return Ok(respond(StatusCode::NO_CONTENT, "", origin));
    }

    let provided = parts.headers.get(TOKEN_HEADER).map(HeaderValue::as_bytes).unwrap_or(b"");
    if !token_matches(&token, provided) {
        return Ok(respond(StatusCode::UNAUTHORIZED, r#"{"error":"invalid token"}"#, origin));
    }

    match (&parts.method, parts.uri.path()) {
        // Lets the extension tell "app not running" from "app running but not
        // paired", which are different things to show the user.
        (&Method::GET, "/ping") => Ok(respond(StatusCode::OK, PING_BODY, origin)),

        (&Method::POST, "/download") => {
            let Ok(collected) = Limited::new(body, MAX_BODY_BYTES).collect().await else {
                return Ok(respond(StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"body too large"}"#, origin));
            };
            let Ok(payload) = serde_json::from_slice::<DownloadRequest>(&collected.to_bytes()) else {
                return Ok(respond(StatusCode::BAD_REQUEST, r#"{"error":"invalid json"}"#, origin));
            };

            // The engine would accept any string it is handed. Pinning the
            // scheme here stops an outside caller from aiming it at `file://`
            // or anything else that isn't a download.
            let allowed = reqwest::Url::parse(&payload.url)
                .map(|u| matches!(u.scheme(), "http" | "https"))
                .unwrap_or(false);
            if !allowed {
                return Ok(respond(StatusCode::BAD_REQUEST, r#"{"error":"url must be http or https"}"#, origin));
            }

            let _ = app.emit(
                "bridge-download",
                BridgeDownload {
                    url: payload.url,
                    headers: payload.headers,
                },
            );
            Ok(respond(StatusCode::ACCEPTED, r#"{"ok":true}"#, origin))
        }

        // What qualities a video page offers. Runs yt-dlp, so it takes a few
        // seconds; the extension shows a spinner meanwhile.
        (&Method::POST, "/media/formats") => {
            let Ok(collected) = Limited::new(body, MAX_BODY_BYTES).collect().await else {
                return Ok(respond(StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"body too large"}"#, origin));
            };
            let Ok(payload) = serde_json::from_slice::<FormatsRequest>(&collected.to_bytes()) else {
                return Ok(respond(StatusCode::BAD_REQUEST, r#"{"error":"invalid json"}"#, origin));
            };
            match crate::media::probe(&app, &payload.url, &payload.headers).await {
                Ok(info) => Ok(respond_json(StatusCode::OK, &info, origin)),
                // Its own status, so the extension can say "open the app to
                // install video support" instead of a generic failure.
                // First video ever: start setting the tools up and tell the
                // extension to ask again; it shows "setting up" meanwhile.
                Err(e) if e == "tools-missing" => {
                    crate::media::ensure_tools_in_background(&app);
                    Ok(respond(StatusCode::CONFLICT, r#"{"error":"tools-installing"}"#, origin))
                }
                Err(e) => Ok(respond_json(StatusCode::UNPROCESSABLE_ENTITY, &serde_json::json!({ "error": e }), origin)),
            }
        }

        (&Method::POST, "/media") => {
            let Ok(collected) = Limited::new(body, MAX_BODY_BYTES).collect().await else {
                return Ok(respond(StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"body too large"}"#, origin));
            };
            let Ok(payload) = serde_json::from_slice::<MediaRequest>(&collected.to_bytes()) else {
                return Ok(respond(StatusCode::BAD_REQUEST, r#"{"error":"invalid json"}"#, origin));
            };
            let allowed = reqwest::Url::parse(&payload.url)
                .map(|u| matches!(u.scheme(), "http" | "https"))
                .unwrap_or(false);
            // Only ids this app hands out; anything else would reach yt-dlp's
            // format selector as text from outside.
            let known = matches!(payload.choice.as_str(), "best" | "m4a" | "mp3")
                || payload.choice.strip_prefix('v').is_some_and(|h| !h.is_empty() && h.len() <= 4 && h.bytes().all(|b| b.is_ascii_digit()));
            if !allowed || !known {
                return Ok(respond(StatusCode::BAD_REQUEST, r#"{"error":"invalid media request"}"#, origin));
            }
            let _ = app.emit(
                "bridge-media",
                BridgeMedia {
                    url: payload.url,
                    choice: payload.choice,
                    label: payload.label.chars().take(80).collect(),
                    title: payload.title.chars().take(300).collect(),
                    headers: payload.headers,
                },
            );
            Ok(respond(StatusCode::ACCEPTED, r#"{"ok":true}"#, origin))
        }

        _ => Ok(respond(StatusCode::NOT_FOUND, r#"{"error":"not found"}"#, origin)),
    }
}

async fn serve(app: AppHandle, token: String, listener: TcpListener) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            // Looping on a failed accept risks spinning hot against something
            // that won't clear on its own, so the bridge stops instead and the
            // user can switch it back on.
            Err(e) => {
                eprintln!("bridge: accept failed, stopping listener: {e}");
                return;
            }
        };

        let app = app.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            let service = service_fn(move |req| route(app.clone(), token.clone(), req));
            if let Err(e) = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await {
                eprintln!("bridge: connection error: {e}");
            }
        });
    }
}

/// Port and pairing token, so the settings screen can show them without
/// having to start the listener first.
#[tauri::command]
pub fn bridge_info(app: AppHandle, state: State<'_, BridgeState>) -> Result<BridgeInfo, String> {
    state.info(&app)
}

#[tauri::command]
pub async fn set_bridge_enabled(app: AppHandle, state: State<'_, BridgeState>, enabled: bool) -> Result<BridgeInfo, String> {
    if !enabled {
        {
            let mut slot = state.task.lock().map_err(|_| "bridge state poisoned")?;
            if let Some(task) = slot.take() {
                task.abort();
            }
        }
        return state.info(&app);
    }

    if state.running() {
        return state.info(&app);
    }

    let token = state.token(&app)?;
    // Bound here rather than inside the task so a taken port surfaces as an
    // error on the toggle, instead of a listener that silently never came up.
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, BRIDGE_PORT)))
        .await
        .map_err(|e| format!("port {BRIDGE_PORT} is unavailable: {e}"))?;

    let handle = tauri::async_runtime::spawn(serve(app.clone(), token, listener));
    {
        let mut slot = state.task.lock().map_err(|_| "bridge state poisoned")?;
        // Replace-and-abort rather than checking first: if two calls raced,
        // this leaves exactly one listener alive either way.
        if let Some(previous) = slot.replace(handle) {
            previous.abort();
        }
    }
    state.info(&app)
}
