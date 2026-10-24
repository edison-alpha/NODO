/**
 * Sends links to the nodo app over its loopback bridge, either from
 * the right-click menu or by taking over a download the browser just started.
 * See download_engine_gui/README.md for what guards that endpoint.
 */

const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";
const MENU_ID = "send-to-download-engine";

/**
 * Menus created here survive the service worker being shut down and restarted,
 * so this runs on install and update rather than on every worker wake-up —
 * creating it twice throws.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Download with nodo",
    contexts: ["link", "video", "audio", "image"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  // `linkUrl` for a link, `srcUrl` for a media element. Right-clicking a
  // linked image gives both, and the link is the more likely intent.
  const url = info.linkUrl || info.srcUrl;
  if (url) void send(url, info.pageUrl);
});

/**
 * Takes over a download the browser started on its own.
 *
 * The context menu only ever sees a link's `href`, which on many sites is not
 * what gets downloaded: an interstitial, a form submit or a redirect chain
 * resolves to a different URL, and until that has happened only the browser
 * knows the final one. `onCreated` hands it over once it does.
 *
 * Inactive unless the user grants `downloads` from the options page — that
 * permission reveals every download they make, which is far more than
 * installing a context menu should cost.
 */
async function onDownloadCreated(item) {
  // `finalUrl` is the end of the redirect chain, the URL bytes will actually
  // come from; `url` is only where the browser started.
  const url = item.finalUrl || item.url;

  // The engine speaks HTTP. `blob:`, `data:` and `filesystem:` URLs exist only
  // inside the browser's own memory, so handing one over would create a job
  // that can never resolve — after cancelling a download that would have worked.
  if (!/^https?:\/\//.test(url)) return;

  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  const headers = { "user-agent": navigator.userAgent };
  // The download item carries the referrer the browser itself used, which is
  // more reliable than the active tab: by now the user may have navigated away.
  if (item.referrer && /^https?:\/\//.test(item.referrer)) headers.referer = item.referrer;
  const cookie = await cookieHeader(url);
  if (cookie) headers.cookie = cookie;

  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/download`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ url, headers }),
    });
  } catch {
    // The app isn't listening, so leave the browser to finish the job. This is
    // the whole reason the hand-over happens before the cancel: the other order
    // would make every download started while the app is closed vanish.
    await record({ url, source: "intercept", cookie: Boolean(cookie), status: "unreachable" });
    return;
  }

  if (!response.ok) {
    flash("!", "#dc2626", `Rejected by nodo (HTTP ${response.status}) — the browser kept the download`);
    await record({ url, source: "intercept", cookie: Boolean(cookie), status: "rejected" });
    return;
  }

  await record({ url, source: "intercept", cookie: Boolean(cookie), status: "sent" });

  // Only now, with the job accepted, is stopping the browser's copy safe.
  // Erasing the row too: a cancelled entry left behind reads as a download that
  // failed, rather than one deliberately moved elsewhere.
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    // Already finished, or erased by the user. The job is running either way;
    // the only cost is a duplicate the browser had time to write.
  }

  flash("✓", "#16a34a", "Download handed to nodo");
}

/**
 * Attached synchronously, and deliberately not behind a permission check.
 *
 * MV3 only wakes a stopped service worker for events whose listeners were
 * registered in the first turn of its event loop. Deciding this after an
 * `await chrome.permissions.contains(...)` would appear to work and then stop
 * silently once the worker first idled out — the worst kind of failure here,
 * because the user would see downloads going to the browser again with nothing
 * to explain it.
 *
 * No check is needed anyway: `chrome.downloads` exists only while the
 * permission is held, so its presence *is* the check, and it is synchronous.
 */
if (chrome.downloads) chrome.downloads.onCreated.addListener(onDownloadCreated);

/**
 * Granting or revoking happens while this worker is awake — the options page
 * just talked to it — so the listener is attached or detached on the spot
 * rather than waiting for a restart. Cold starts are covered above.
 */
chrome.permissions.onAdded.addListener(() => {
  if (chrome.downloads && !chrome.downloads.onCreated.hasListener(onDownloadCreated)) {
    chrome.downloads.onCreated.addListener(onDownloadCreated);
  }
});

chrome.permissions.onRemoved.addListener(() => {
  if (chrome.downloads?.onCreated.hasListener(onDownloadCreated)) {
    chrome.downloads.onCreated.removeListener(onDownloadCreated);
  }
});

/**
 * Request context the link may need to resolve.
 *
 * Nothing here is guessed: the referrer is the page the link was actually on,
 * and the User-Agent is this browser's own. Sending something invented would
 * only make a picky server behave differently than it does for the browser.
 */
async function buildHeaders(url, pageUrl) {
  const headers = { "user-agent": navigator.userAgent };

  // Only a real page is worth sending. A server that checks Referer wants the
  // page the link sat on; `chrome://` or `about:` would be noise at best.
  if (pageUrl && /^https?:\/\//.test(pageUrl)) {
    headers.referer = pageUrl;
  }

  const cookie = await cookieHeader(url);
  if (cookie) headers.cookie = cookie;

  return headers;
}

/**
 * The target site's cookies, or "" when cookie access hasn't been granted.
 *
 * Checked rather than requested: a permission prompt needs a user gesture and
 * cannot be raised from a context-menu handler. The options page is where the
 * user turns this on, which also means a link that needs a login simply fails
 * until they do — visibly, rather than by the extension quietly reaching for
 * more access than it was given.
 */
async function cookieHeader(url) {
  let origin;
  try {
    origin = `${new URL(url).origin}/*`;
  } catch {
    return "";
  }

  const granted = await chrome.permissions.contains({
    permissions: ["cookies"],
    origins: [origin],
  });
  if (!granted) return "";

  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function send(url, pageUrl, source = "menu") {
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    flash("!", "#dc2626", "Not paired yet — open the extension settings");
    chrome.runtime.openOptionsPage();
    return { ok: false };
  }

  const headers = await buildHeaders(url, pageUrl);

  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/download`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ url, headers }),
    });
  } catch {
    // A refused connection is the common case and has a specific cause worth
    // naming, rather than a generic "failed".
    flash("!", "#dc2626", "nodo isn't answering — open the app and turn on links from the extension");
    await record({ url, source, cookie: Boolean(headers.cookie), status: "unreachable" });
    return { ok: false };
  }

  if (response.ok) {
    flash("✓", "#16a34a", "Sent to nodo");
  } else if (response.status === 401) {
    flash("!", "#dc2626", "Token rejected — pair again in the extension settings");
  } else {
    flash("!", "#dc2626", `Rejected by nodo (HTTP ${response.status})`);
  }

  await record({ url, source, cookie: Boolean(headers.cookie), status: response.ok ? "sent" : "rejected" });
  return { ok: response.ok, status: response.status };
}

/**
 * Lets the popup reuse `send` instead of posting to the bridge itself, so the
 * header allowlist, cookie lookup and logging have exactly one implementation.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The floating button's page, for the Referer; only trusted from our own content script.
  const pageUrl = sender.tab?.url;
  switch (message?.type) {
    case "send-url":
      send(message.url, undefined, "popup").then(sendResponse);
      return true; // keeps the channel open for the async reply
    case "direct-download":
      send(message.url, pageUrl, "button").then(sendResponse);
      return true;
    case "media-formats":
      mediaFormats(message.url).then(sendResponse);
      return true;
    case "media-download":
      sendMedia(message, pageUrl).then(sendResponse);
      return true;
    case "open-options":
      chrome.runtime.openOptionsPage();
      return false;
    default:
      return false;
  }
});

/**
 * Asks the app what qualities a video page offers. The app runs yt-dlp for
 * this, so it can take a few seconds; the button shows a spinner meanwhile.
 *
 * Answers with a `reason` the button can turn into the right sentence, rather
 * than one generic failure: not paired, app not running, video support not
 * installed yet, or yt-dlp's own explanation.
 */
async function mediaFormats(url) {
  const { token } = await chrome.storage.local.get("token");
  if (!token) return { ok: false, reason: "token" };
  const headers = await buildHeaders(url, url);
  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/media/formats`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ url, headers }),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 401) return { ok: false, reason: "token" };
  if (response.status === 409) return { ok: false, reason: "tools-missing" };
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, reason: "error", message: body.error || `HTTP ${response.status}` };
  return { ok: true, info: body };
}

async function sendMedia({ url, choice, label, title }, pageUrl) {
  const { token } = await chrome.storage.local.get("token");
  if (!token) return { ok: false, reason: "token" };
  const headers = await buildHeaders(url, pageUrl || url);
  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/media`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ url, choice, label, title, headers }),
    });
  } catch {
    await record({ url, source: "button", cookie: Boolean(headers.cookie), status: "unreachable" });
    return { ok: false, reason: "unreachable" };
  }
  await record({ url, source: "button", cookie: Boolean(headers.cookie), status: response.ok ? "sent" : "rejected" });
  if (response.ok) flash("✓", "#16a34a", "Video sent to nodo");
  if (response.status === 401) return { ok: false, reason: "token" };
  return { ok: response.ok, status: response.status };
}

/** How many hand-overs the log keeps. */
const LOG_LIMIT = 50;

/**
 * Records a hand-over so the options page can show what actually happened,
 * rather than the user having to guess whether a download reached the app.
 *
 * Capped and kept in `local`: these are URLs the user visited, so they stay on
 * this machine and never ride `sync` to another profile. "Clear" on the
 * options page erases the lot.
 */
async function record(entry) {
  const { log = [] } = await chrome.storage.local.get("log");
  log.unshift({ at: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
}

/**
 * Feedback on the toolbar icon. Chosen over a system notification because that
 * would need a permission of its own for something this small.
 */
function flash(text, color, title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: `nodo — ${title}` });
  // Cleared on a timer the worker may not live to see; that's fine, since the
  // badge is advisory and the next click overwrites it anyway.
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "nodo" });
  }, 4000);
}
