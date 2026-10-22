(() => {
  const coursePath = "/learn/upgrading-apps-generative-ai/";
  const continuationKey = "windowfocus:next-lecture";
  const seen = new WeakSet();
  let settings = { enabled: false, autoNext: false };
  let settingsReady = false;
  let nextTimer;
  let pendingPlay = null;
  let notice;

  const isLecture = (path = location.pathname) => path.startsWith(`${coursePath}lecture/`);
  const active = () => settings.enabled && isLecture();

  function message(text) {
    if (!document.body) return;
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "windowfocus-status";
      notice.setAttribute("role", "status");
      Object.assign(notice.style, {
        position: "fixed", bottom: "16px", right: "16px", zIndex: "2147483647",
        maxWidth: "320px", padding: "12px 16px", borderRadius: "10px",
        background: "#202522", color: "#f3f5f3", font: "13px/1.5 system-ui",
        boxShadow: "0 4px 24px #0003", cursor: "pointer",
      });
      notice.title = "Click to dismiss";
      notice.addEventListener("click", () => { notice.remove(); notice = null; });
      document.body.append(notice);
    }
    notice.textContent = `WindowFocus: ${text}`;
  }

  function clearContinuation() {
    pendingPlay = null;
    try { sessionStorage.removeItem(continuationKey); } catch {}
  }

  function saveContinuation(path, source) {
    const intent = { path, source, expires: Date.now() + 20000 };
    pendingPlay = intent;
    try { sessionStorage.setItem(continuationKey, JSON.stringify(intent)); } catch {}
  }

  function readContinuation() {
    try { return JSON.parse(sessionStorage.getItem(continuationKey)); } catch { return null; }
  }

  function resumeNextVideo(video) {
    if (!settingsReady) return;
    const intent = pendingPlay || readContinuation();
    if (!intent) return;
    if (!settings.enabled || !settings.autoNext || Date.now() > intent.expires) {
      clearContinuation();
      return;
    }
    if (location.pathname !== intent.path || video.readyState === 0 ||
        video.ended || video.currentSrc === intent.source) return;
    clearContinuation();
    video.play().catch(() => message("Your browser blocked autoplay. Click Play to continue."));
  }

  // Keep native behavior whenever the extension is off or the route is not a lecture.
  for (const [key, visible] of Object.entries({
    hidden: false, visibilityState: "visible", webkitHidden: false,
    webkitVisibilityState: "visible",
  })) {
    const native = Object.getOwnPropertyDescriptor(Document.prototype, key);
    if (!native?.get) continue;
    Object.defineProperty(document, key, {
      configurable: true,
      get: () => active() ? visible : native.get.call(document),
    });
  }
  const nativeHasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => active() || nativeHasFocus();

  for (const type of ["blur", "focusout", "visibilitychange", "webkitvisibilitychange"]) {
    window.addEventListener(type, (event) => {
      if (active() && (event.target === window || event.target === document)) {
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function nextLectureLink() {
    for (const anchor of document.querySelectorAll("a[href]")) {
      const labels = [anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.textContent]
        .filter(Boolean).map((label) => label.replace(/\s+/g, " ").trim());
      if (!labels.some((label) => /^(?:go to (?:the )?)?next(?:\s+(?:video|lecture|lesson|item))?(?:\s*[:→›»\-].*)?$/i.test(label))) continue;
      if (!anchor.getClientRects().length || anchor.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      if (anchor.getAttribute("aria-disabled") === "true") continue;
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin && isLecture(url.pathname) && url.pathname !== location.pathname) {
        return { anchor, path: url.pathname };
      }
    }
    return null;
  }

  function onEnded(video, event) {
    if (!event.isTrusted || !video.ended || !active() || !settings.autoNext) return;
    const finishedPath = location.pathname;
    const finishedSource = video.currentSrc;
    clearTimeout(nextTimer);
    // Give Coursera's own autoplay a chance to navigate first.
    nextTimer = setTimeout(() => {
      if (!active() || !settings.autoNext || location.pathname !== finishedPath ||
          video.currentSrc !== finishedSource || !video.ended || !video.isConnected) return;
      const next = nextLectureLink();
      if (!next) {
        message("Video finished. No clear next-lecture link found; use the course navigation.");
        return;
      }
      saveContinuation(next.path, finishedSource);
      next.anchor.click();
    }, 1500);
  }

  function watchVideos() {
    for (const video of document.querySelectorAll("video")) {
      if (!seen.has(video)) {
        seen.add(video);
        video.addEventListener("ended", (event) => onEnded(video, event));
        video.addEventListener("loadeddata", () => resumeNextVideo(video));
        video.addEventListener("canplay", () => resumeNextVideo(video));
      }
      resumeNextVideo(video);
    }
  }

  window.addEventListener("windowfocus:settings", (event) => {
    let value;
    try { value = JSON.parse(event.detail); } catch { return; }
    if (!value || typeof value !== "object") return;
    settings = { enabled: value.enabled === true, autoNext: value.autoNext === true };
    settingsReady = true;
    if (!settings.enabled || !settings.autoNext) {
      clearTimeout(nextTimer);
      clearContinuation();
    }
    if (!settings.enabled && notice) { notice.remove(); notice = null; }
    watchVideos();
  });

  const observer = new MutationObserver(watchVideos);
  observer.observe(document, { childList: true, subtree: true });
  window.addEventListener("popstate", () => {
    clearTimeout(nextTimer);
    watchVideos();
  });
  watchVideos();
  window.dispatchEvent(new Event("windowfocus:ready"));
})();
