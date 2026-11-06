const DEFAULT_BASE = "http://127.0.0.1:8765";

async function getBase() {
  const stored = await chrome.storage.local.get("companionUrl");
  return String(stored.companionUrl || DEFAULT_BASE).replace(/\/+$/, "");
}

async function request(path, options = {}, timeoutMs = 15000) {
  const base = await getBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (!res.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    return { ok: true, data };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "offline" };
  } finally {
    clearTimeout(timer);
  }
}

function validJobId(value) {
  return typeof value === "string" && /^[a-f0-9]{8,64}$/i.test(value);
}

function sanitizeFilename(name, fallback) {
  let out = String(name || fallback || "download")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
  if (!out) out = "download";
  if (out.length > 160) {
    const dot = out.lastIndexOf(".");
    if (dot > 20) out = out.slice(0, 150) + out.slice(dot);
    else out = out.slice(0, 160);
  }
  return out;
}

async function handleMessage(msg) {
  switch (msg.type) {
    case "YTDL_HEALTH":
      return request("/api/health", { method: "GET" }, 2500);

    case "YTDL_FORMATS":
      return request(
        "/api/formats",
        { method: "POST", body: JSON.stringify({ url: msg.url }) },
        90000
      );

    case "YTDL_START":
      return request(
        "/api/download",
        {
          method: "POST",
          body: JSON.stringify({
            url: msg.url,
            formatId: msg.formatId,
            kind: msg.kind,
            title: msg.title
          })
        },
        15000
      );

    case "YTDL_STATUS":
      if (!validJobId(msg.jobId)) return { ok: false, error: "invalid_job_id" };
      return request(`/api/jobs/${encodeURIComponent(msg.jobId)}`, { method: "GET" }, 8000);

    case "YTDL_CANCEL":
      if (!validJobId(msg.jobId)) return { ok: false, error: "invalid_job_id" };
      return request(
        `/api/jobs/${encodeURIComponent(msg.jobId)}/cancel`,
        { method: "POST" },
        8000
      );

    case "YTDL_SAVE": {
      if (!validJobId(msg.jobId)) return { ok: false, error: "invalid_job_id" };
      const base = await getBase();
      const filename = sanitizeFilename(msg.filename, "youtube-download");
      try {
        const downloadId = await chrome.downloads.download({
          url: `${base}/api/jobs/${encodeURIComponent(msg.jobId)}/file`,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        });
        return { ok: true, downloadId };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    case "YTDL_DOWNLOAD_STATE": {
      const id = Number(msg.downloadId);
      if (!Number.isInteger(id) || id < 0) return { ok: false, error: "invalid_download_id" };
      try {
        const [item] = await chrome.downloads.search({ id });
        if (!item) return { ok: false, error: "not_found" };
        return {
          ok: true,
          data: { state: item.state, error: item.error || null, filename: item.filename || "" }
        };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    case "YTDL_OPEN_SETUP":
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL("src/setup.html") });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }

    default:
      return { ok: false, error: "unknown_message" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("YTDL_")) return false;
  handleMessage(msg).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String((err && err.message) || err) })
  );
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("companionUrl");
  if (!stored.companionUrl) {
    await chrome.storage.local.set({ companionUrl: DEFAULT_BASE });
  }
});
