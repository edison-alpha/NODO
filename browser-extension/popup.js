/* The toolbar popup: connection at a glance, pairing on first run, a paste box, and the switches. */

async function refresh() {
  const result = await connection();
  showConnection($("conn"), result);
  // Pairing problems are fixed right here; anything else just needs the app open.
  const needsPairing = result.kind === "no-token" || result.kind === "bad-token";
  $("pairCard").hidden = !needsPairing;
  $("sendCard").hidden = needsPairing;
  if (result.kind === "unreachable") setMsg($("sendMsg"), "bad", "nodo isn't running. Open the app to send links.");
  else if ($("sendMsg").classList.contains("bad")) setMsg($("sendMsg"), "", "");
  if (result.kind === "bad-token") setMsg($("pairMsg"), "bad", "That token was rejected. Copy it again from nodo.");
}

$("connect").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) {
    setMsg($("pairMsg"), "bad", "Paste the pairing token first.");
    return;
  }
  setMsg($("pairMsg"), "", "Connecting…");
  await chrome.storage.local.set({ token });
  const [kind, text] = connectionAdvice(await connection());
  setMsg($("pairMsg"), kind, text);
  await refresh();
});
$("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("connect").click();
});

$("send").addEventListener("click", async () => {
  const url = $("url").value.trim();
  if (!/^https?:\/\//i.test(url)) {
    setMsg($("sendMsg"), "bad", url ? "Only http(s) links can be downloaded." : "Paste a link first.");
    return;
  }
  setMsg($("sendMsg"), "", "Sending…");
  // Through the service worker, which owns the one copy of the send logic.
  const result = await chrome.runtime.sendMessage({ type: "send-url", url });
  if (result?.ok) {
    setMsg($("sendMsg"), "ok", "Added to nodo.");
    $("url").value = "";
  } else if (result?.status === 401) {
    setMsg($("sendMsg"), "bad", "nodo rejected the token. Pair again.");
    await refresh();
  } else if (result?.status) {
    setMsg($("sendMsg"), "bad", `nodo answered with HTTP ${result.status}.`);
  } else {
    setMsg($("sendMsg"), "bad", "nodo isn't running. Open the app to send links.");
  }
});
$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("send").click();
});

/** "Show again" for a site where the floating button was hidden with its ×. */
async function refreshSite() {
  const { fabHiddenSites = [] } = await chrome.storage.local.get("fabHiddenSites");
  // Readable because opening the popup grants activeTab.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let site = "";
  try {
    site = tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    site = "";
  }
  const hidden = Boolean(site) && fabHiddenSites.includes(site);
  $("siteRow").hidden = !hidden;
  if (!hidden) return;
  $("siteText").textContent = `Hidden on ${site}`;
  $("siteShow").onclick = async () => {
    await chrome.storage.local.set({ fabHiddenSites: fabHiddenSites.filter((s) => s !== site) });
    await refreshSite();
  };
}

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("version").textContent = `v${chrome.runtime.getManifest().version}`;

const permissionError = (text) => setMsg($("sendMsg"), "bad", text);
void bindFab($("fab"));
void bindPermission($("intercept"), PERMS.intercept, permissionError);
void bindPermission($("cookies"), PERMS.cookies, permissionError);
void refreshSite();
void refresh();
