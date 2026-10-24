/* The full settings page: pairing, the three features, hidden sites, and what was sent. */

/**
 * Kept in `local`, not `sync`: the token only authorises the app on this one
 * machine, so syncing it would spread a credential to profiles with no app.
 */
async function loadToken() {
  const { token } = await chrome.storage.local.get("token");
  if (token) $("token").value = token;
}

async function refreshConnection() {
  const result = await connection();
  showConnection($("conn"), result);
  return result;
}

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) {
    setMsg($("tokenMsg"), "bad", "Paste the pairing token first.");
    return;
  }
  await chrome.storage.local.set({ token });
  setMsg($("tokenMsg"), "", "Testing…");
  const [kind, text] = connectionAdvice(await refreshConnection());
  setMsg($("tokenMsg"), kind, text);
  if (kind === "ok") toast("Connected to nodo");
});
$("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("save").click();
});

$("reveal").addEventListener("click", () => {
  const show = $("token").type === "password";
  $("token").type = show ? "text" : "password";
  $("reveal").setAttribute("aria-label", show ? "Hide token" : "Show token");
  $("reveal").title = show ? "Hide token" : "Show token";
});

/* ---------- hidden sites ---------- */

async function renderSites() {
  const { fabHiddenSites = [] } = await chrome.storage.local.get("fabHiddenSites");
  $("sitesSection").hidden = fabHiddenSites.length === 0;
  $("sites").replaceChildren(
    ...fabHiddenSites.map((site) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.style.flex = "1";
      name.textContent = site;
      const show = document.createElement("button");
      show.className = "link";
      show.textContent = "Show again";
      show.addEventListener("click", async () => {
        await chrome.storage.local.set({ fabHiddenSites: fabHiddenSites.filter((s) => s !== site) });
      });
      li.append(name, show);
      return li;
    }),
  );
}

/* ---------- activity ---------- */

const STATUS = {
  sent: ["ok", "Sent"],
  rejected: ["bad", "Rejected by nodo"],
  unreachable: ["bad", "nodo not running"],
};

const SOURCE = {
  intercept: "Browser download",
  menu: "Right-click",
  popup: "Popup",
  button: "Video button",
};

function shortUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return raw;
  }
}

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get("log");
  if (log.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing sent to nodo yet.";
    $("log").replaceChildren(empty);
    return;
  }
  // Built as nodes, not markup: the URLs come from pages the user visited.
  $("log").replaceChildren(
    ...log.map((entry) => {
      const [cls, label] = STATUS[entry.status] ?? ["", entry.status];
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = `dot ${cls}`;
      const what = document.createElement("div");
      what.className = "what";
      const url = document.createElement("b");
      url.textContent = shortUrl(entry.url);
      url.title = entry.url;
      const meta = document.createElement("span");
      meta.textContent = [label, SOURCE[entry.source] ?? entry.source, entry.cookie ? "with cookies" : ""].filter(Boolean).join(" · ");
      what.append(url, meta);
      const time = document.createElement("time");
      time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      li.append(dot, what, time);
      return li;
    }),
  );
}

$("clearLog").addEventListener("click", async () => {
  await chrome.storage.local.remove("log");
  toast("Activity cleared");
});

// Keeps an open settings page current while things are being sent.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.log) void renderLog();
  if (changes.fabHiddenSites) void renderSites();
});

/* ---------- start ---------- */

$("version").textContent = `Browser extension · v${chrome.runtime.getManifest().version}`;
const permissionError = (text) => {
  setMsg($("tokenMsg"), "bad", text);
  toast("Reload the extension first", false);
};
void loadToken();
void bindFab($("fab"));
void bindPermission($("intercept"), PERMS.intercept, permissionError);
void bindPermission($("cookies"), PERMS.cookies, permissionError);
void refreshConnection();
void renderSites();
void renderLog();
