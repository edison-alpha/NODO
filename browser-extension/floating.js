/**
 * The floating "download this video" button, in the spirit of IDM's panel.
 *
 * Shown on YouTube watch and Shorts pages, and on any other page with a video
 * big enough to be the point of the page. Clicking it asks the app which
 * qualities the page offers (the app runs yt-dlp for that), and a pick goes
 * back to the app as a job. The page itself never talks to the app: every
 * request goes through the service worker, which holds the pairing token.
 *
 * Everything lives in a closed shadow root, so the site's CSS can't restyle it
 * and the site's scripts can't reach into it.
 */
(() => {
  if (window.top !== window || window.__nodoFloating) return;
  window.__nodoFloating = true;

  const SIZE = 48;
  const EDGE = 12;
  const MIN_VIDEO = { w: 200, h: 112 };

  const state = {
    enabled: true,
    hiddenSites: [],
    /** Position as a fraction of the free space, so it survives a resize. */
    pos: { rx: 1, ry: 1 },
    menuOpen: false,
    cache: new Map(),
  };

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647; width: 0; height: 0;";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
      .glass {
        background: rgba(24, 24, 27, 0.58);
        backdrop-filter: blur(20px) saturate(1.6);
        -webkit-backdrop-filter: blur(20px) saturate(1.6);
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12);
        color: #fafafa;
      }
      .fab {
        position: fixed; width: ${SIZE}px; height: ${SIZE}px; border-radius: 999px;
        display: grid; place-items: center; cursor: grab; user-select: none; touch-action: none;
        background: #2b7fff;
        transition: transform 160ms ease, opacity 200ms ease, background-color 160ms ease;
      }
      .fab:hover { background: #155dfc; }
      .fab:active { transform: scale(0.94); }
      .fab.dragging { cursor: grabbing; transition: none; transform: scale(1.06); }
      .fab .fa-cloud-download-alt { width: 22px; height: 22px; pointer-events: none; fill: currentColor; }
      .fab .close {
        position: absolute; top: -4px; right: -4px; width: 18px; height: 18px; border-radius: 999px;
        display: grid; place-items: center; opacity: 0; transition: opacity 140ms ease; cursor: pointer;
        background: rgba(24, 24, 27, 0.85); border: 1px solid rgba(255, 255, 255, 0.18);
      }
      .fab .close svg { width: 10px; height: 10px; pointer-events: none; }
      .fab:hover .close { opacity: 1; }
      .hidden { opacity: 0 !important; pointer-events: none !important; transform: scale(0.8) !important; }

      .menu {
        position: fixed; width: 300px; border-radius: 20px; padding: 6px; font-size: 13px;
        transform-origin: var(--origin, bottom right); animation: pop 200ms cubic-bezier(0.32, 0.72, 0, 1);
      }
      @keyframes pop { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
      .head { display: flex; gap: 10px; align-items: center; padding: 8px 8px 10px; }
      .thumb { width: 64px; height: 36px; border-radius: 8px; object-fit: cover; background: rgba(255,255,255,0.08); flex: none; }
      .title { font-weight: 600; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .sub { margin-top: 2px; color: rgba(255,255,255,0.55); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sep { height: 1px; margin: 4px 8px; background: rgba(255,255,255,0.1); }
      .label { padding: 6px 10px 2px; font-size: 11px; color: rgba(255,255,255,0.5); }
      .item {
        display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px;
        border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer;
        padding: 9px 10px; border-radius: 12px; font-size: 13px;
      }
      .item:hover, .item:focus-visible { background: rgba(255,255,255,0.1); outline: none; }
      .item .detail { color: rgba(255,255,255,0.55); font-size: 12px; white-space: nowrap; }
      .item b { font-weight: 600; }
      .note { padding: 10px; color: rgba(255,255,255,0.7); line-height: 1.45; }
      .note.bad { color: #ff8d86; }
      .note.ok { color: #5fd38a; font-weight: 600; }
      .row { display: flex; gap: 6px; padding: 0 6px 6px; }
      .btn {
        flex: 1; border: 0; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
        background: rgba(255,255,255,0.12); color: #fafafa;
      }
      .btn.primary { background: #2b7fff; }
      .btn:hover { filter: brightness(1.15); }
      .spin { width: 14px; height: 14px; border-radius: 999px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff; animation: spin 800ms linear infinite; display: inline-block; vertical-align: -2px; margin-right: 8px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .foot { padding: 6px 10px 4px; font-size: 10.5px; color: rgba(255,255,255,0.4); display: flex; justify-content: space-between; }
      .foot button { border: 0; background: none; color: rgba(255,255,255,0.55); font-size: 10.5px; cursor: pointer; padding: 0; }
      .foot button:hover { color: #fff; }
      @media (prefers-reduced-motion: reduce) { .menu { animation: none; } .fab { transition: none; } }
    </style>
    <div class="fab glass hidden" role="button" tabindex="0" aria-label="Download this video with nodo" title="Download with nodo — drag to move">
      <svg class="fa-solid fa-cloud-download-alt" viewBox="0 0 640 512" aria-hidden="true"><path d="M537.6 226.6C552.4 215.4 560 197.4 560 176c0-35.3-28.7-64-64-64-2.7 0-5.4.2-8 .5C469.4 50.4 409.2 0 336 0c-82.8 0-150.4 66.8-152 149.3C176.5 145.8 168.3 144 160 144c-53 0-96 43-96 96 0 4.8.4 9.5 1 14.1C27.7 266.3 0 303.3 0 347.3 0 410.8 51.5 462.3 115 462.3h159v-96h-64c-14.1 0-23.1-16.3-15.8-28.4l96-160c7.7-12.8 26.9-12.8 34.6 0l96 160c7.3 12.1-1.7 28.4-15.8 28.4h-64v96h196c71.7 0 129-58.1 129-129.8 0-56.8-36.4-105.1-87.2-122zM336 512c-17.7 0-32-14.3-32-32v-48h64v48c0 17.7-14.3 32-32 32z"/></svg>
      <span class="close" role="button" aria-label="Hide on this site" title="Hide on this site">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </span>
    </div>
  `;
  const fab = root.querySelector(".fab");
  const closeBtn = root.querySelector(".close");
  let menu = null;

  /* ---------- where the button sits ---------- */

  function place() {
    const maxX = window.innerWidth - SIZE - EDGE * 2;
    const maxY = window.innerHeight - SIZE - EDGE * 2;
    fab.style.left = `${EDGE + Math.max(0, Math.min(1, state.pos.rx)) * maxX}px`;
    fab.style.top = `${EDGE + Math.max(0, Math.min(1, state.pos.ry)) * maxY}px`;
  }

  function savePos(left, top) {
    const maxX = Math.max(1, window.innerWidth - SIZE - EDGE * 2);
    const maxY = Math.max(1, window.innerHeight - SIZE - EDGE * 2);
    state.pos = { rx: (left - EDGE) / maxX, ry: (top - EDGE) / maxY };
    chrome.storage.local.set({ fabPos: state.pos }).catch(() => {});
  }

  // Drag and click share one pointer gesture: a few pixels of travel turns
  // it into a drag, and a drag never also opens the menu.
  let drag = null;
  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.composedPath().includes(closeBtn)) return;
    const rect = fab.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      fab.classList.add("dragging");
      closeMenu();
    }
    const left = Math.max(EDGE, Math.min(window.innerWidth - SIZE - EDGE, drag.left + dx));
    const top = Math.max(EDGE, Math.min(window.innerHeight - SIZE - EDGE, drag.top + dy));
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
  });
  fab.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    fab.classList.remove("dragging");
    fab.releasePointerCapture(e.pointerId);
    if (wasDrag) {
      const rect = fab.getBoundingClientRect();
      savePos(rect.left, rect.top);
    } else {
      toggleMenu();
    }
  });
  fab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleMenu();
    }
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const site = location.hostname;
    state.hiddenSites = [...new Set([...state.hiddenSites, site])];
    chrome.storage.local.set({ fabHiddenSites: state.hiddenSites }).catch(() => {});
    closeMenu();
    refresh();
  });
  window.addEventListener("resize", () => {
    place();
    closeMenu();
  });

  /* ---------- when it shows ---------- */

  function isYouTubeVideo() {
    const h = location.hostname;
    if (h === "youtu.be") return true;
    if (!/(^|\.)youtube\.com$/.test(h)) return false;
    return location.pathname === "/watch" || location.pathname.startsWith("/shorts/") || location.pathname.startsWith("/live/");
  }

  /** The video on the page worth offering: visible and big enough to be content, not an ad thumbnail. */
  function mainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < MIN_VIDEO.w || r.height < MIN_VIDEO.h) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  /** A plain file the engine can fetch itself, faster than yt-dlp: not a blob or stream. */
  function directSource(video) {
    const src = video?.currentSrc || video?.src || video?.querySelector("source[src]")?.src || "";
    return /^https?:\/\//.test(src) && !/\.m3u8|\.mpd/i.test(src) ? src : "";
  }

  /** The page URL as yt-dlp should see it: a YouTube watch link without playlist noise. */
  function pageUrl() {
    if (isYouTubeVideo()) {
      const u = new URL(location.href);
      const id = u.searchParams.get("v");
      if (u.pathname === "/watch" && id) return `https://www.youtube.com/watch?v=${id}`;
    }
    return location.href.split("#")[0];
  }

  function pageTitle() {
    return document.title.replace(/\s*-\s*YouTube$/, "").replace(/^\(\d+\)\s*/, "").trim();
  }

  function refresh() {
    const allowed = state.enabled && !state.hiddenSites.includes(location.hostname) && !document.fullscreenElement;
    const show = allowed && (isYouTubeVideo() || mainVideo() !== null);
    fab.classList.toggle("hidden", !show);
    if (!show) closeMenu();
  }

  /* ---------- the menu ---------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
    state.menuOpen = false;
  }

  function positionMenu() {
    if (!menu) return;
    const f = fab.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const above = f.top - m.height - 10 >= EDGE;
    const top = above ? f.top - m.height - 10 : Math.min(window.innerHeight - m.height - EDGE, f.bottom + 10);
    const left = Math.max(EDGE, Math.min(window.innerWidth - m.width - EDGE, f.right - m.width));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.setProperty("--origin", `${above ? "bottom" : "top"} ${f.left > window.innerWidth / 2 ? "right" : "left"}`);
  }

  function toggleMenu() {
    if (state.menuOpen) closeMenu();
    else void openMenu();
  }

  function renderBody(nodes) {
    if (!menu) return;
    const body = menu.querySelector(".body");
    body.replaceChildren(...nodes);
    positionMenu();
  }

  function item(label, detail, onClick) {
    const b = el("button", "item");
    b.append(el("b", "", label), el("span", "detail", detail));
    b.addEventListener("click", onClick);
    return b;
  }

  async function openMenu() {
    closeMenu();
    state.menuOpen = true;
    menu = el("div", "menu glass");
    menu.setAttribute("role", "menu");
    const head = el("div", "head");
    const thumb = el("img", "thumb");
    thumb.alt = "";
    thumb.style.display = "none";
    const text = el("div", "");
    text.style.minWidth = "0";
    const title = el("div", "title", pageTitle() || location.hostname);
    const sub = el("div", "sub", location.hostname);
    text.append(title, sub);
    head.append(thumb, text);
    const body = el("div", "body");
    const foot = el("div", "foot");
    const hide = el("button", "", "Hide on this site");
    hide.addEventListener("click", () => closeBtn.click());
    foot.append(el("span", "", "nodo"), hide);
    menu.append(head, el("div", "sep"), body, foot);
    root.append(menu);

    const spinner = el("div", "note");
    spinner.prepend(el("span", "spin"));
    spinner.append("Finding qualities…");
    renderBody([spinner]);

    const url = pageUrl();
    const video = mainVideo();
    const direct = directSource(video);

    let res = state.cache.get(url);
    if (!res) {
      res = await chrome.runtime.sendMessage({ type: "media-formats", url }).catch(() => ({ ok: false, reason: "unreachable" }));
      if (res?.ok) state.cache.set(url, res);
    }
    if (!menu) return;

    const nodes = [];
    if (res?.ok) {
      const info = res.info;
      if (info.title) title.textContent = info.title;
      sub.textContent = [info.uploader, info.duration ? fmtDuration(info.duration) : ""].filter(Boolean).join(" · ") || location.hostname;
      if (info.thumbnail) {
        thumb.src = info.thumbnail;
        thumb.style.display = "";
      }
      const video = info.choices.filter((c) => !["m4a", "mp3"].includes(c.id));
      const audio = info.choices.filter((c) => ["m4a", "mp3"].includes(c.id));
      if (video.length) nodes.push(el("div", "label", "Video"), ...video.map((c) => item(c.label, c.detail, () => pick(url, c, info.title))));
      if (audio.length) nodes.push(el("div", "label", "Audio"), ...audio.map((c) => item(c.label, c.detail, () => pick(url, c, info.title))));
    } else {
      nodes.push(problem(res, url));
    }
    if (direct) {
      nodes.push(el("div", "sep"), item("Direct file", (direct.split("?")[0].match(/\.(\w{2,4})$/)?.[1] ?? "file").toUpperCase(), () => pickDirect(direct)));
    }
    renderBody(nodes);
    menu?.querySelector(".item")?.focus();
  }

  /** What went wrong, said plainly, with the one action that fixes it where there is one. */
  function problem(res, url) {
    const wrap = el("div", "");
    const reason = res?.reason;
    if (reason === "tools-missing") {
      wrap.append(el("div", "note", "Video support isn't installed in nodo yet. Send it anyway and nodo will offer to set it up."));
      const row = el("div", "row");
      const send = el("button", "btn primary", "Send best quality");
      send.addEventListener("click", () => pick(url, { id: "best", label: "Best quality", detail: "" }, pageTitle()));
      row.append(send);
      wrap.append(row);
    } else if (reason === "token") {
      wrap.append(el("div", "note bad", "The extension isn't paired with nodo yet."));
      const row = el("div", "row");
      const open = el("button", "btn primary", "Open extension settings");
      open.addEventListener("click", () => chrome.runtime.sendMessage({ type: "open-options" }));
      row.append(open);
      wrap.append(row);
    } else if (reason === "unreachable") {
      wrap.append(el("div", "note bad", "nodo isn't responding. Open the app and turn on browser links in Settings → Integrations."));
    } else {
      wrap.append(el("div", "note bad", res?.message || "This page has no video nodo can save."));
    }
    return wrap;
  }

  async function pick(url, choice, title) {
    const label = choice.id === "mp3" ? "Audio only · MP3" : choice.id === "m4a" ? "Audio only · M4A" : choice.label;
    renderBody([el("div", "note", "Sending to nodo…")]);
    const res = await chrome.runtime.sendMessage({ type: "media-download", url, choice: choice.id, label, title: title || pageTitle() }).catch(() => null);
    done(res);
  }

  async function pickDirect(src) {
    renderBody([el("div", "note", "Sending to nodo…")]);
    const res = await chrome.runtime.sendMessage({ type: "direct-download", url: src }).catch(() => null);
    done(res);
  }

  function done(res) {
    if (res?.ok) {
      renderBody([el("div", "note ok", "✓ Added to nodo")]);
      setTimeout(closeMenu, 1200);
    } else {
      renderBody([problem(res, pageUrl())]);
    }
  }

  function fmtDuration(sec) {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  }

  // Outside clicks and Escape close the menu. composedPath sees through the
  // shadow root, so clicks inside it don't count as outside.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (menu && !e.composedPath().includes(host)) closeMenu();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu) closeMenu();
  });

  /* ---------- start ---------- */

  chrome.storage.local.get(["fabEnabled", "fabHiddenSites", "fabPos"]).then((s) => {
    state.enabled = s.fabEnabled !== false;
    state.hiddenSites = Array.isArray(s.fabHiddenSites) ? s.fabHiddenSites : [];
    if (s.fabPos && typeof s.fabPos.rx === "number") state.pos = s.fabPos;
    (document.body || document.documentElement).append(host);
    place();
    refresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.fabEnabled) state.enabled = changes.fabEnabled.newValue !== false;
    if (changes.fabHiddenSites) state.hiddenSites = changes.fabHiddenSites.newValue ?? [];
    refresh();
  });

  // YouTube and other single-page sites swap videos without a page load.
  window.addEventListener("yt-navigate-finish", () => {
    state.cache.clear();
    closeMenu();
    refresh();
  });
  window.addEventListener("popstate", refresh);
  document.addEventListener("fullscreenchange", refresh);
  // A cheap poll catches videos that appear later and SPA route changes the
  // events above miss.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      closeMenu();
    }
    refresh();
  }, 1200);
})();
