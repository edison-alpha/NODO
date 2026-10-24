/**
 * Shared by the popup and the options page, so both read the connection and
 * the permissions the same way and can never disagree about them.
 */

const BRIDGE_ORIGIN = "http://127.0.0.1:47283";
const TOKEN_HEADER = "x-download-engine-token";

const PERMS = {
  cookies: { permissions: ["cookies"], origins: ["<all_urls>"] },
  intercept: { permissions: ["downloads"] },
};

const $ = (id) => document.getElementById(id);

/**
 * Tells apart the failures that feel the same but have different fixes: no
 * token yet, app not running (or links from the extension switched off), and
 * app reachable but the token wrong.
 */
async function ping(token) {
  if (!token) return { kind: "no-token" };
  let response;
  try {
    response = await fetch(`${BRIDGE_ORIGIN}/ping`, { headers: { [TOKEN_HEADER]: token } });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 401) return { kind: "bad-token" };
  if (!response.ok) return { kind: "http", status: response.status };
  const info = await response.json().catch(() => null);
  return { kind: "ok", version: info?.version };
}

async function connection() {
  const { token } = await chrome.storage.local.get("token");
  return ping(token);
}

const CONN_TEXT = {
  ok: ["ok", "Connected"],
  "no-token": ["", "Not paired"],
  "bad-token": ["bad", "Token rejected"],
  unreachable: ["bad", "nodo not running"],
};

function showConnection(el, result) {
  const [cls, text] = CONN_TEXT[result.kind] ?? ["bad", `HTTP ${result.status}`];
  el.className = `conn ${cls}`;
  el.textContent = text;
}

/** A sentence for each failure, saying what to do about it. */
function connectionAdvice(result) {
  switch (result.kind) {
    case "ok":
      return ["ok", `Connected to nodo${result.version ? ` ${result.version}` : ""}.`];
    case "no-token":
      return ["bad", "Paste the pairing token first."];
    case "bad-token":
      return ["bad", "nodo answered but rejected the token. Copy it again from Settings → Integrations."];
    case "unreachable":
      return ["bad", "nodo isn't answering. Open the app and turn on “Accept links from the extension” in Settings → Integrations."];
    default:
      return ["bad", `nodo answered with HTTP ${result.status}.`];
  }
}

function setMsg(el, kind, text) {
  el.className = `msg ${kind}`;
  el.textContent = text;
}

/**
 * A switch that mirrors a permission Chrome actually holds, not a saved
 * preference: the user can revoke it from Chrome's own page at any time.
 *
 * The prompt needs the user gesture this event carries. `request` throws when
 * Chrome's copy of the manifest doesn't list the permission, which for an
 * unpacked extension means it was updated on disk but not reloaded.
 */
function bindPermission(input, request, onError) {
  const refresh = async () => {
    input.checked = await chrome.permissions.contains(request);
  };
  input.addEventListener("change", async () => {
    try {
      if (input.checked) {
        const granted = await chrome.permissions.request(request);
        if (!granted) onError?.("Chrome didn't grant the permission.");
      } else {
        await chrome.permissions.remove(request);
      }
    } catch (e) {
      onError?.(`Chrome refused: ${e.message}. Reload the extension in chrome://extensions and try again.`);
    } finally {
      await refresh();
    }
  });
  return refresh();
}

/** The floating video button's on/off switch, which is a stored preference. */
async function bindFab(input) {
  const { fabEnabled } = await chrome.storage.local.get("fabEnabled");
  input.checked = fabEnabled !== false;
  input.addEventListener("change", () => chrome.storage.local.set({ fabEnabled: input.checked }));
}

let toastTimer;
function toast(message, ok = true) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.append(el);
  }
  el.className = ok ? "toast" : "toast bad";
  el.innerHTML = ok
    ? '<svg class="icon" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
    : '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  el.append(message);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
