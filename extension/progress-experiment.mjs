import { isTargetPage } from "./diagnostic-report.mjs";

export function playbackSnapshot() {
  const video = document.querySelector("video");
  return {
    origin: location.origin, path: location.pathname,
    source: video?.currentSrc || "", position: video?.currentTime || 0,
    duration: video?.duration || 0, rate: video?.playbackRate || 1,
  };
}

export function validPlayback(value) {
  return value && isTargetPage(value.origin + value.path) && typeof value.source === "string" &&
    value.source.length > 0 && Number.isFinite(value.duration) && value.duration > 0 &&
    Number.isFinite(value.position) && value.position >= 0 && Number.isFinite(value.rate) && value.rate > 0 && value.rate <= 2;
}

export function progressTemplate(entry, snapshot, context, startedAt) {
  if (!validPlayback(snapshot) || !validPlayback(context) || snapshot.path !== context.path ||
      snapshot.source !== context.source || snapshot.position < 2) return null;
  if (entry.request?.method !== "PUT" || entry.response?.status !== 204 ||
      !Number.isFinite(Date.parse(entry.startedDateTime)) || Date.parse(entry.startedDateTime) < startedAt) return null;
  let url, body;
  try {
    url = new URL(entry.request.url);
    body = JSON.parse(entry.request.postData.text);
  } catch { return null; }
  if (url.origin !== snapshot.origin || url.username || url.password ||
      !/^\/api\/onDemandVideoProgresses\.v1(?:\/[^/]+)?\/?$/.test(url.pathname)) return null;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["viewedUpTo", "videoProgressId"].includes(key)) ||
      !Number.isFinite(body.viewedUpTo) || body.viewedUpTo <= 0 ||
      typeof body.videoProgressId !== "string" ||
      !/^[a-z0-9_-]+~[a-z0-9_-]+~[a-z0-9_-]+$/i.test(body.videoProgressId) || body.videoProgressId.length > 512) return null;
  const suffix = url.pathname.replace(/^\/api\/onDemandVideoProgresses\.v1\/?/, "");
  try {
    if (suffix && decodeURIComponent(suffix.replace(/\/$/, "")) !== body.videoProgressId) return null;
  } catch { return null; }

  // Infer the unit from the live media clock; do not assume milliseconds.
  const tolerance = Math.min(3, Math.max(0.5, snapshot.position * 0.1));
  const scales = [1, 1000].filter(scale => Math.abs(body.viewedUpTo / scale - snapshot.position) <= tolerance);
  if (scales.length !== 1 || body.viewedUpTo > (snapshot.duration + tolerance) * scales[0]) return null;

  const headers = { "content-type": "application/json" };
  for (const header of entry.request.headers || []) {
    if (/^(?:content-type|csrf3-token|x-csrf3-token|x-csrftoken|x-csrf-token)$/i.test(header.name)) {
      headers[header.name.toLowerCase()] = header.value;
    }
  }
  // Request identity and CSRF headers stay in this DevTools panel's memory.
  return {
    origin: snapshot.origin, path: snapshot.path, source: snapshot.source,
    url: url.href, videoProgressId: body.videoProgressId, unit: scales[0], headers,
  };
}

export async function applyEndPosition(plan) {
  const video = document.querySelector("video");
  if (!video || location.origin !== plan.origin || location.pathname !== plan.path ||
      video.currentSrc !== plan.source || !Number.isFinite(video.duration) || video.duration <= 0) {
    return { state: "stale" };
  }
  if (video.playbackRate > 2 || video.playbackRate <= 0 || ![1, 1000].includes(plan.unit)) return { state: "unsupported" };
  let url;
  try { url = new URL(plan.url); } catch { return { state: "unsupported" }; }
  if (url.origin !== location.origin ||
      !/^\/api\/onDemandVideoProgresses\.v1(?:\/[^/]+)?\/?$/.test(url.pathname)) return { state: "unsupported" };

  video.pause();
  await new Promise(resolve => setTimeout(resolve, 400));
  if (location.pathname !== plan.path || video.currentSrc !== plan.source || !video.isConnected) return { state: "stale" };
  const target = Math.ceil(video.duration * plan.unit);
  try {
    const response = await fetch(url.href, {
      method: "PUT", credentials: "same-origin", headers: plan.headers,
      body: JSON.stringify({ viewedUpTo: target, videoProgressId: plan.videoProgressId }),
      signal: AbortSignal.timeout(10000),
    });
    return {
      state: response.status >= 200 && response.status < 300 ? "accepted" : "rejected",
      status: response.status, requestedSeconds: target / plan.unit,
    };
  } catch { return { state: "network-error" }; }
}
