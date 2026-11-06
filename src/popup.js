const DEFAULT_BASE = "http://127.0.0.1:8765";

const dot = document.getElementById("dot");
const statusTitle = document.getElementById("status-title");
const statusSub = document.getElementById("status-sub");
const urlInput = document.getElementById("url");
const testButton = document.getElementById("test");
const saveButton = document.getElementById("save");
const guideButton = document.getElementById("guide");

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: "no_response" });
      }
    });
  });
}

function setStatus(kind, title, sub) {
  dot.className = `dot ${kind}`;
  statusTitle.textContent = title;
  statusSub.textContent = sub;
}

function normalizeBase(value) {
  let raw = String(value || "").trim() || DEFAULT_BASE;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  return `${url.protocol}//${url.host}`;
}

async function testConnection() {
  setStatus("checking", "Checking companion…", urlInput.value || DEFAULT_BASE);
  const response = await send({ type: "YTDL_HEALTH" });

  if (response.ok && response.data && response.data.ok) {
    const version = response.data.ytdlp || "unknown";
    const ffmpeg = response.data.ffmpeg ? "ffmpeg ready" : "ffmpeg missing";
    setStatus("online", "Companion online", `yt-dlp ${version} · ${ffmpeg}`);
    return;
  }

  if (response.ok && response.data && !response.data.ok) {
    setStatus("offline", "Companion problem", response.data.error || "yt-dlp was not found");
    return;
  }

  const reason =
    response.error === "timeout"
      ? "The helper did not respond in time"
      : "Start server\\start.bat, then test again";
  setStatus("offline", "Companion offline", reason);
}

async function save() {
  const base = normalizeBase(urlInput.value);
  if (!base) {
    setStatus("offline", "Invalid URL", "Use http://127.0.0.1:8765 or http://localhost:8765");
    return;
  }
  urlInput.value = base;
  await chrome.storage.local.set({ companionUrl: base });
  await testConnection();
}

testButton.addEventListener("click", testConnection);
saveButton.addEventListener("click", save);
urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") save();
});
guideButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/setup.html") });
});

chrome.storage.local.get("companionUrl").then((stored) => {
  urlInput.value = stored.companionUrl || DEFAULT_BASE;
  testConnection();
});
