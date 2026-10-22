const fields = new Set([
  "currentTime", "duration", "videoDuration", "videoPosition", "video_position",
  "watchedUpTo", "watchedUpto", "viewedUpTo", "watchedSeconds", "watched_seconds", "watchedDuration",
  "percentWatched", "percentageWatched", "percent_watched", "video_percent",
  "videoProgress", "playbackRate", "playback_rate", "playbackSpeed",
  "isCompleted", "is_completed", "completed", "elapsedSeconds",
  "progress", "isComplete", "is_complete", "timeCodes", "timeRanges",
  "ranges", "segments", "intervals", "played", "viewedRanges",
]);
const eventNames = new Set([
  "open_course.video.heartbeat", "open_course.video.complete", "open_course.video.play",
  "open_course.video.pause", "open_course.video.seek", "open_course.video.progress",
  "open_course.video.rate_change", "open_course.video.loaded", "open_course.video.ended",
]);
const eventTypes = new Set(["ViewedUpto", "Ended", "Started", "Paused", "PlaybackRateChanged"]);

export function isTargetPage(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://www.coursera.org" &&
      url.pathname.startsWith("/learn/upgrading-apps-generative-ai/lecture/");
  } catch { return false; }
}

function safeValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : undefined;
  if (value === "true" || value === "false") return value === "true";
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return safeValue(Number(value));
  return undefined;
}

const privateField = /token|secret|password|auth|csrf|cookie|header|email|name|account|user|answer|submission|hash|ids?$/i;
const progressField = /progress|position|duration|time|rate|watched|viewed|play|segment|range|interval|complete|start|end|video/i;
const wrappers = new Set(["elements", "data", "body", "payload", "value", "updates", "entries", "events"]);

function fieldLabel(key) {
  if (!/^[a-zA-Z][a-zA-Z_]{0,63}$/.test(key) || privateField.test(key)) return "other";
  return wrappers.has(key) || progressField.test(key) ? key : "other";
}

function safeRanges(value) {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const valid = number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 1e7;
  if (value.every(valid)) return value;
  if (value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(valid))) return value;
  return undefined;
}

export function sanitizeRequest(entry) {
  let url;
  try { url = new URL(entry.request.url); } catch { return null; }
  if (url.protocol !== "https:" || !(url.hostname === "coursera.org" || url.hostname.endsWith(".coursera.org"))) return null;
  const endpoint = url.pathname.match(/^\/api\/([a-z][a-z0-9]*(?:\.[a-z0-9]+)?)(?:\/|$)/i);
  if (!endpoint) return null;

  const signals = [];
  const events = new Set();
  const types = new Set();
  const bodyInfo = { format: "missing", fields: [] };
  const shapes = new Set();
  let visited = 0;
  function visit(value, depth = 0, prefix = "") {
    if (!value || typeof value !== "object" || depth > 6 || visited++ > 300 || signals.length >= 40) return;
    if (eventNames.has(value.key)) events.add(value.key);
    if (eventTypes.has(value.type)) types.add(value.type);
    for (const [key, child] of Object.entries(value)) {
      if (privateField.test(key)) continue;
      const label = Array.isArray(value) ? "[]" : fieldLabel(key);
      const path = prefix ? `${prefix}.${label}` : label;
      const type = Array.isArray(child) ? "array" : child === null ? "null" : typeof child;
      const shape = `${path}:${type}`;
      if (!shapes.has(shape) && bodyInfo.fields.length < 60) {
        shapes.add(shape);
        bodyInfo.fields.push({ field: path, type });
      }
      if (fields.has(key) || (label !== "other" && progressField.test(key))) {
        const safe = safeValue(child) ?? safeRanges(child);
        if (safe !== undefined && signals.length < 40) signals.push({ field: key, value: safe });
        else if (child && typeof child === "object") visit(child, depth + 1, path);
      } else if (child && typeof child === "object") {
        visit(child, depth + 1, path);
      }
    }
  }

  const data = entry.request.postData;
  if (typeof data?.text === "string" && data.text.length <= 200000) {
    try {
      const body = JSON.parse(data.text);
      bodyInfo.format = "json";
      if (Array.isArray(body?.events)) {
        for (const event of body.events.slice(0, 100)) {
          if (eventNames.has(event?.key)) visit(event);
        }
      } else {
        visit(body);
      }
    } catch {
      bodyInfo.format = data.text.length === 0 ? "empty" : "unparsed";
      if (data.mimeType?.startsWith("application/x-www-form-urlencoded")) {
        bodyInfo.format = "form";
        visit(Object.fromEntries(new URLSearchParams(data.text)));
      }
    }
  } else if (Array.isArray(data?.params)) {
    bodyInfo.format = "form";
    visit(Object.fromEntries(data.params.slice(0, 100).filter(p => !privateField.test(p.name)).map(p => [p.name, p.value])));
  } else if (data) {
    bodyInfo.format = typeof data.text === "string" ? "too-large" : "unavailable";
  }

  if (!/video|lecture|progress|batch|event|clickstream|material/i.test(endpoint[1]) &&
      !url.pathname.endsWith("/videoEvents") && events.size === 0) return null;
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(entry.request.method) ? entry.request.method : "OTHER";
  const status = entry.response?.status;
  return {
    endpoint: `/api/${endpoint[1]}${url.pathname.endsWith("/videoEvents") ? "/…/videoEvents" : ""}`,
    method,
    status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
    events: [...events],
    types: [...types],
    progress: signals,
    body: bodyInfo,
  };
}

export function isProgressRead(entry) {
  try {
    const url = new URL(entry.request.url);
    return url.origin === "https://www.coursera.org" && entry.request.method === "GET" &&
      entry.response?.status === 200 && /^\/api\/onDemandVideoProgresses\.v1(?:\/[^/]+)?\/?$/.test(url.pathname);
  } catch { return false; }
}

export function sanitizeProgressResponse(entry, content, encoding) {
  if (!isProgressRead(entry)) return null;
  if (encoding || typeof content !== "string" || content.length > 200000) {
    return { body: { format: "unavailable", fields: [] }, progress: [] };
  }
  const safe = sanitizeRequest({
    request: { url: entry.request.url, method: "GET", postData: { text: content, mimeType: "application/json" } },
    response: { status: 200 },
  });
  return { body: safe.body, progress: safe.progress };
}

export function formatReport(entries, outcome, dropped = 0, source = "live") {
  return JSON.stringify({
    format: "windowfocus-playback-check-v2",
    source: source === "existing-log" ? "existing-log" : "live",
    outcome: ["not-checked", "check-visible", "check-missing"].includes(outcome) ? outcome : "not-checked",
    dropped,
    requests: entries,
  }, null, 2);
}
