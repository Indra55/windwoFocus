(() => {
  const continuationKey = "windowfocus:next-lecture";
  const seen = new WeakSet();
  let settings = { enabled: false, autoNext: false };
  let settingsReady = false;
  let nextTimer;
  let pendingPlay = null;
  let notice;

  const coursePath = (path = location.pathname) => path.match(/^\/learn\/[^/]+\//)?.[0] || null;
  const isLecture = (path = location.pathname) => /^\/learn\/[^/]+\/lecture\/[^/]+(?:\/|$)/.test(path);
  const sameCourseLecture = (path) => isLecture(path) && coursePath(path) === coursePath();
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
    const intent = { path, from: location.pathname, source, expires: Date.now() + 20000 };
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
    if (!isLecture() || coursePath(intent.from || intent.path || "") !== coursePath()) {
      clearContinuation();
      return;
    }
    if ((intent.path ? location.pathname !== intent.path : location.pathname === intent.from) || video.readyState === 0 ||
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

  function usable(element) {
    return element.getClientRects().length > 0 && !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]');
  }

  function nextVideoCard(video) {
    const frame = video.getBoundingClientRect();
    if (frame.width <= 0 || frame.height <= 0) return null;
    for (const control of document.querySelectorAll('button, a[href], [role="button"]')) {
      if (!usable(control) || control.closest("form, [role=\"dialog\"]")) continue;
      const labels = [control.getAttribute("aria-label"), control.textContent].filter(Boolean);
      if (!labels.some((label) => /^start(?:\s+(?:video|learning))?$/i.test(label.replace(/\s+/g, " ").trim()))) continue;
      const rect = control.getBoundingClientRect();
      const x = (rect.left + rect.right) / 2;
      const y = (rect.top + rect.bottom) / 2;
      if (x < frame.left || x > frame.right || y < frame.top || y > frame.bottom) continue;

      let card = control.parentElement;
      for (let depth = 0; card && depth < 5; depth++, card = card.parentElement) {
        if (card === document.body || card.contains(video)) break;
        const text = card.textContent.replace(/\s+/g, " ").trim();
        if (text.length > 600) break;
        if (!/^video\s*\(\s*\d/i.test(text)) continue;

        if (control.hasAttribute("href")) {
          const url = new URL(control.getAttribute("href"), location.href);
          if (url.origin !== location.origin || !sameCourseLecture(url.pathname) || url.pathname === location.pathname) break;
          return { control, path: url.pathname };
        }
        return { control, path: null };
      }
    }
    return null;
  }

  function nextLectureLink() {
    for (const anchor of document.querySelectorAll("a[href]")) {
      const labels = [anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.textContent]
        .filter(Boolean).map((label) => label.replace(/\s+/g, " ").trim());
      if (!labels.some((label) => /^(?:go to (?:the )?)?next(?:\s+(?:video|lecture|lesson|item))?(?:\s*[:→›»\-].*)?$/i.test(label))) continue;
      if (!usable(anchor)) continue;
      const url = new URL(anchor.href, location.href);
      if (url.origin === location.origin && sameCourseLecture(url.pathname) && url.pathname !== location.pathname) {
        return { control: anchor, path: url.pathname };
      }
    }
    return null;
  }

  function onEnded(video, event) {
    if (!event.isTrusted || !video.ended || !active() || !settings.autoNext) return;
    const finishedPath = location.pathname;
    const finishedSource = video.currentSrc;
    clearTimeout(nextTimer);
    // Allow native navigation first, then wait for a delayed end card if needed.
    const advance = (retries = 0) => {
      if (!active() || !settings.autoNext || location.pathname !== finishedPath ||
          video.currentSrc !== finishedSource || !video.ended || !video.isConnected) return;
      const next = nextVideoCard(video) || nextLectureLink();
      if (!next) {
        if (retries < 24) {
          nextTimer = setTimeout(() => advance(retries + 1), 500);
          return;
        }
        message("Playback finished. No next-video control appeared; use the page navigation.");
        return;
      }
      saveContinuation(next.path, finishedSource);
      if (notice) { notice.remove(); notice = null; }
      next.control.click();
    };
    nextTimer = setTimeout(() => advance(), 1500);
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
