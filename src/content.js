(() => {
  "use strict";
  if (window.__ytdlLoaded) return;
  window.__ytdlLoaded = true;

  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  const ICON_ALERT =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V8h2v5z"/></svg>';
  const ICON_CLOUD_OFF =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46A5.5 5.5 0 0 1 17.5 10H19a3.5 3.5 0 0 1 1.96 6.39l1.42 1.42A5.49 5.49 0 0 0 19.35 10zM3.27 2.5 2 3.77l2.1 2.1A5.5 5.5 0 0 0 6.5 17H17l1.73 1.73 1.27-1.27L3.27 2.5zM6.5 15a3.5 3.5 0 0 1-.35-6.98l6.4 6.4V15H6.5z"/></svg>';

  const state = {
    videoId: null,
    panel: null,
    open: false,
    formats: null,
    activeTab: "video",
    loading: false,
    error: null,
    job: null,
    pollToken: 0,
    loadToken: 0
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const FORMATS_TTL = 5 * 60 * 1000;
  const formatsCache = new Map();
  const formatRequests = new Map();

  function cachedFormats(videoId) {
    const entry = formatsCache.get(videoId);
    if (!entry) return null;
    if (Date.now() - entry.at > FORMATS_TTL) {
      formatsCache.delete(videoId);
      return null;
    }
    return entry.data;
  }

  function fetchFormats(videoId) {
    const cached = cachedFormats(videoId);
    if (cached) return Promise.resolve({ ok: true, data: cached });

    const existing = formatRequests.get(videoId);
    if (existing) return existing;

    let request = send({
      type: "YTDL_FORMATS",
      url: `https://www.youtube.com/watch?v=${videoId}`
    }).then((response) => {
      if (response.ok && response.data && Array.isArray(response.data.formats)) {
        formatsCache.set(videoId, { data: response.data, at: Date.now() });
      }
      return response;
    });
    request = request.finally(() => formatRequests.delete(videoId));
    formatRequests.set(videoId, request);
    return request;
  }

  function warmFormats() {
    if (!isWatchPage()) return;
    const videoId = currentVideoId();
    if (!videoId || cachedFormats(videoId)) return;
    fetchFormats(videoId);
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: "no_response" });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function currentVideoId() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function isWatchPage() {
    return location.pathname === "/watch" && Boolean(currentVideoId());
  }

  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "size unknown";
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    const rounded = index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
    return `${rounded} ${units[index]}`;
  }

  function audioLabel(format) {
    const kbps = Math.round(format.abr || format.tbr || 0);
    return kbps ? `${kbps}k` : format.formatNote || "Audio";
  }

  function codecLabel(format) {
    const codec = format.kind === "audio" ? format.acodec : format.vcodec;
    const text = String(codec || "");
    if (/opus/i.test(text)) return "OPUS";
    if (/mp4a|aac/i.test(text)) return "AAC";
    if (/av01/i.test(text)) return "AV1";
    if (/vp9|vp09/i.test(text)) return "VP9";
    if (/avc|h264/i.test(text)) return "H.264";
    return text.split(".")[0].toUpperCase() || (format.kind === "audio" ? "AUDIO" : "VIDEO");
  }

  function errorText(code) {
    if (code === "offline") return "Companion app is offline";
    if (code === "timeout") return "Companion app timed out";
    return String(code || "Something went wrong");
  }

  function ensureButton() {
    if (state.panel && !state.panel.isConnected) {
      state.panel = null;
      state.open = false;
    }
    if (!isWatchPage()) {
      document.querySelectorAll(".ytdl-button").forEach((node) => node.remove());
      return;
    }
    if (document.querySelector("ytd-miniplayer[active]")) {
      document.querySelectorAll(".ytdl-button").forEach((node) => node.remove());
      if (state.open) closePanel();
      return;
    }
    const controls = document.querySelector("#movie_player .ytp-right-controls");
    if (!controls) return;
    let button = controls.querySelector(".ytdl-button");
    if (button) return;
    button = document.createElement("button");
    button.type = "button";
    button.className = "ytp-button ytdl-button";
    button.title = "Download";
    button.setAttribute("aria-label", "Download");
    button.innerHTML = ICON_DOWNLOAD;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    });
    const settings = controls.querySelector(".ytp-settings-button");
    if (settings && settings.parentElement) {
      settings.parentElement.insertBefore(button, settings);
    } else {
      const right = controls.querySelector(".ytp-right-controls-right");
      (right || controls).appendChild(button);
    }
    updateButtonBusy();
  }

  function updateButtonBusy() {
    const button = document.querySelector(".ytdl-button");
    if (!button) return;
    button.classList.toggle("ytdl-busy", Boolean(state.job && state.job.active));
  }

  function ensurePanel() {
    const player = document.querySelector("#movie_player");
    if (!player) return null;
    let panel = player.querySelector(".ytdl-panel");
    if (panel) return panel;

    panel = document.createElement("div");
    panel.className = "ytdl-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Download options");
    panel.hidden = true;
    panel.innerHTML = `
      <div class="ytdl-head">
        <div class="ytdl-head-text">
          <h2 class="ytdl-head-title">Download</h2>
          <p class="ytdl-head-sub"></p>
        </div>
        <button class="ytdl-close" type="button" aria-label="Close">${ICON_CLOSE}</button>
      </div>
      <div class="ytdl-tabs" role="tablist" aria-label="Download type">
        <button class="ytdl-tab" type="button" role="tab" data-tab="video">Video<span class="ytdl-tab-count"></span></button>
        <button class="ytdl-tab" type="button" role="tab" data-tab="audio">Audio<span class="ytdl-tab-count"></span></button>
      </div>
      <div class="ytdl-banner" role="status" hidden></div>
      <div class="ytdl-body"></div>
      <div class="ytdl-foot" hidden>
        <div class="ytdl-progress-main">
          <div class="ytdl-progress-head">
            <span class="ytdl-progress-label" aria-live="polite"></span>
            <span class="ytdl-progress-pct"></span>
          </div>
          <div class="ytdl-progress-track"><div class="ytdl-progress-fill"></div></div>
        </div>
        <button class="ytdl-cancel" type="button" hidden>Cancel</button>
      </div>
    `;

    ["click", "dblclick", "mousedown", "pointerdown", "contextmenu"].forEach((name) => {
      panel.addEventListener(name, (event) => event.stopPropagation());
    });

    panel.querySelector(".ytdl-close").addEventListener("click", closePanel);

    panel.querySelectorAll(".ytdl-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.activeTab = tab.dataset.tab;
        render();
      });
    });

    panel.querySelector(".ytdl-cancel").addEventListener("click", cancelJob);

    player.appendChild(panel);
    state.panel = panel;
    return panel;
  }

  function togglePanel() {
    if (state.open) {
      closePanel();
      return;
    }
    const panel = ensurePanel();
    if (!panel) return;
    state.open = true;
    panel.hidden = false;
    if (!state.formats || state.videoId !== currentVideoId()) {
      loadFormats();
    } else {
      render();
    }
  }

  function closePanel() {
    state.open = false;
    const panel = state.panel || document.querySelector(".ytdl-panel");
    if (panel) panel.hidden = true;
  }

  async function loadFormats() {
    const videoId = currentVideoId();
    const token = ++state.loadToken;
    state.videoId = videoId;
    state.loading = true;
    state.error = null;
    state.formats = null;
    render();

    const response = await send({
      type: "YTDL_FORMATS",
      url: `https://www.youtube.com/watch?v=${videoId}`
    });

    if (token !== state.loadToken || state.videoId !== videoId) return;

    state.loading = false;
    if (response.ok && response.data && Array.isArray(response.data.formats)) {
      state.formats = response.data;
      const hasVideo = response.data.formats.some((format) => format.kind !== "audio");
      state.activeTab = hasVideo ? "video" : "audio";
    } else {
      state.error = errorText(response.error);
    }
    render();
  }

  function sortedFormats() {
    if (!state.formats) return [];
    const all = state.formats.formats || [];
    const list = all.filter((format) =>
      state.activeTab === "audio" ? format.kind === "audio" : format.kind !== "audio"
    );
    if (state.activeTab === "audio") {
      list.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    } else {
      list.sort(
        (a, b) =>
          (b.height || 0) - (a.height || 0) ||
          (b.fps || 0) - (a.fps || 0) ||
          (b.kind === "av" ? 1 : 0) - (a.kind === "av" ? 1 : 0) ||
          (b.tbr || 0) - (a.tbr || 0)
      );
    }
    return list;
  }

  function render() {
    const panel = state.panel || document.querySelector(".ytdl-panel");
    if (!panel) return;

    const sub = panel.querySelector(".ytdl-head-sub");
    if (state.formats && state.formats.title) sub.textContent = state.formats.title;
    else if (state.loading) sub.textContent = "Fetching available formats…";
    else sub.textContent = "YouTube";

    const all = (state.formats && state.formats.formats) || [];
    const videoCount = all.filter((format) => format.kind !== "audio").length;
    const audioCount = all.filter((format) => format.kind === "audio").length;

    panel.querySelectorAll(".ytdl-tab").forEach((tab) => {
      const active = tab.dataset.tab === state.activeTab;
      tab.classList.toggle("ytdl-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      const count = tab.dataset.tab === "audio" ? audioCount : videoCount;
      tab.querySelector(".ytdl-tab-count").textContent = state.formats ? String(count) : "";
    });

    const banner = panel.querySelector(".ytdl-banner");
    const warnings = [];
    if (state.formats && state.formats.isLive) {
      warnings.push("This is a live stream. Only the current segment can be captured.");
    }
    if (state.formats && state.formats.ffmpeg === false && state.activeTab === "video") {
      warnings.push("ffmpeg is missing, so video-only formats can't be merged with audio.");
    }
    banner.hidden = warnings.length === 0;
    banner.textContent = warnings.join(" ");

    const body = panel.querySelector(".ytdl-body");
    body.textContent = "";

    if (state.loading) {
      for (let index = 0; index < 6; index += 1) {
        const row = document.createElement("div");
        row.className = "ytdl-skeleton";
        row.innerHTML =
          '<span class="ytdl-sk-badge"></span><span class="ytdl-sk-meta"><span class="ytdl-sk-line"></span><span class="ytdl-sk-line ytdl-sk-short"></span></span>';
        body.appendChild(row);
      }
    } else if (state.error) {
      body.appendChild(buildErrorState());
    } else if (!state.formats) {
      body.appendChild(buildMessageState("Download", "Open a video and try again."));
    } else {
      const list = sortedFormats();
      if (!list.length) {
        body.appendChild(
          buildMessageState(
            "Nothing here",
            state.activeTab === "audio"
              ? "No separate audio track is available for this video."
              : "No video track is available for this video."
          )
        );
      } else {
        list.forEach((format) => body.appendChild(buildRow(format)));
      }
    }

    renderFooter();
  }

  function buildMessageState(title, text) {
    const wrap = document.createElement("div");
    wrap.className = "ytdl-empty";
    wrap.innerHTML = `
      <span class="ytdl-empty-icon">${ICON_DOWNLOAD}</span>
      <span class="ytdl-empty-title"></span>
      <p class="ytdl-empty-text"></p>
    `;
    wrap.querySelector(".ytdl-empty-title").textContent = title;
    wrap.querySelector(".ytdl-empty-text").textContent = text;
    return wrap;
  }

  function buildErrorState() {
    const offline = state.error === errorText("offline") || state.error === errorText("timeout");
    const wrap = document.createElement("div");
    wrap.className = "ytdl-empty";
    wrap.innerHTML = `
      <span class="ytdl-empty-icon">${offline ? ICON_CLOUD_OFF : ICON_ALERT}</span>
      <span class="ytdl-empty-title"></span>
      <p class="ytdl-empty-text"></p>
      ${offline ? '<code class="ytdl-empty-code">server\\start.bat</code>' : ""}
      <div class="ytdl-empty-actions">
        <button class="ytdl-btn" type="button" data-action="retry">Retry</button>
        ${offline ? '<button class="ytdl-btn ytdl-btn-ghost" type="button" data-action="setup">Setup guide</button>' : ""}
      </div>
    `;
    wrap.querySelector(".ytdl-empty-title").textContent = offline
      ? "Companion app is offline"
      : "Couldn't load formats";
    wrap.querySelector(".ytdl-empty-text").textContent = offline
      ? "Start the local helper once, keep it running, then retry. Setup steps are in the extension popup."
      : state.error;
    wrap.querySelector('[data-action="retry"]').addEventListener("click", () => loadFormats());
    const guide = wrap.querySelector('[data-action="setup"]');
    if (guide) {
      guide.addEventListener("click", () => send({ type: "YTDL_OPEN_SETUP" }));
    }
    return wrap;
  }

  function buildRow(format) {
    const isAudio = format.kind === "audio";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ytdl-row";
    row.title = format.formatNote || format.quality || "";

    const needsMerge = !isAudio && format.kind === "video";
    if (needsMerge && state.formats && state.formats.ffmpeg === false) {
      row.disabled = true;
      row.title = "ffmpeg is required to merge this video with audio";
    }

    const quality = document.createElement("span");
    quality.className = `ytdl-q${isAudio ? " ytdl-q-audio" : ""}`;
    quality.textContent = isAudio
      ? audioLabel(format)
      : format.height
        ? `${format.height}p`
        : format.formatNote || "Video";

    const meta = document.createElement("span");
    meta.className = "ytdl-meta";

    const chips = document.createElement("span");
    chips.className = "ytdl-chips";

    const addChip = (text, accent) => {
      const chip = document.createElement("span");
      chip.className = `ytdl-chip${accent ? " ytdl-chip-accent" : ""}`;
      chip.textContent = text;
      chips.appendChild(chip);
    };

    addChip(String(format.ext || "").toUpperCase());
    addChip(codecLabel(format));
    if (!isAudio && format.fps && format.fps > 30) addChip(`${format.fps} FPS`);
    if (!isAudio && format.dynamicRange && /HDR|HLG|PQ/i.test(format.dynamicRange)) addChip("HDR");
    if (!isAudio && format.kind === "av") addChip("WITH AUDIO", true);

    const sub = document.createElement("span");
    sub.className = "ytdl-sub";
    const approx = format.kind === "video" || format.filesizeEstimated ? "~" : "";
    if (isAudio) {
      sub.textContent = `${format.formatNote || "Audio"} · ${approx}${fmtSize(format.filesize)}`;
    } else {
      const dimensions = format.width && format.height ? `${format.width}×${format.height} · ` : "";
      const merge = format.kind === "video" ? " · audio merged" : "";
      sub.textContent = `${dimensions}${approx}${fmtSize(format.filesize)}${merge}`;
    }

    meta.appendChild(chips);
    meta.appendChild(sub);

    const action = document.createElement("span");
    action.className = "ytdl-dl";
    action.innerHTML = ICON_DOWNLOAD;

    row.appendChild(quality);
    row.appendChild(meta);
    row.appendChild(action);
    row.addEventListener("click", () => startDownload(format));
    return row;
  }

  async function startDownload(format) {
    if (state.job && state.job.active) {
      showToast("A download is already in progress", true);
      return;
    }
    if (
      format.kind === "video" &&
      state.formats &&
      state.formats.ffmpeg === false
    ) {
      showToast("ffmpeg is required to merge video with audio", true);
      return;
    }

    const label =
      format.kind === "audio"
        ? `${audioLabel(format)} audio`
        : `${format.height}p${format.fps && format.fps > 30 ? format.fps : ""}`;

    const job = {
      active: true,
      id: null,
      label,
      percent: 0,
      state: "starting",
      speed: "",
      eta: "",
      filename: ""
    };
    state.job = job;
    updateButtonBusy();
    renderFooter();

    const response = await send({
      type: "YTDL_START",
      url: `https://www.youtube.com/watch?v=${state.videoId}`,
      formatId: format.id,
      kind: format.kind,
      title: (state.formats && state.formats.title) || ""
    });

    if (state.job !== job) return;

    if (!response.ok) {
      if (job.active) failJob(response.error);
      return;
    }

    const jobId = response.data && response.data.jobId;
    if (!jobId) {
      if (job.active) failJob("The companion returned an invalid response");
      return;
    }

    job.id = jobId;
    if (!job.active) {
      send({ type: "YTDL_CANCEL", jobId });
      return;
    }
    pollJob(jobId);
  }

  async function pollJob(jobId) {
    const token = ++state.pollToken;
    const startedAt = Date.now();

    while (state.job && state.job.id === jobId && state.job.active) {
      const response = await send({ type: "YTDL_STATUS", jobId });
      if (token !== state.pollToken) return;

      if (!response.ok) {
        if (Date.now() - startedAt > 25000) {
          failJob(response.error);
          return;
        }
        await delay(1000);
        continue;
      }

      const job = response.data;
      state.job.percent = Number(job.percent) || 0;
      state.job.state = job.state || "downloading";
      state.job.speed = job.speed || "";
      state.job.eta = job.eta || "";
      state.job.filename = job.filename || "";
      renderFooter();

      if (job.state === "done") {
        const save = await send({
          type: "YTDL_SAVE",
          jobId,
          filename: job.filename
        });
        if (!save.ok) {
          failJob(save.error);
          return;
        }

        state.job.state = "saving";
        state.job.percent = 100;
        renderFooter();

        if (save.downloadId == null) {
          markSaved();
          return;
        }

        const finished = await waitForDownload(save.downloadId, jobId);
        if (!finished) {
          failJob("The file could not be saved to Downloads");
          return;
        }
        markSaved();
        return;
      }

      if (job.state === "cancelled") {
        markCancelled();
        return;
      }

      if (job.state === "error") {
        failJob(job.error || "Download failed");
        return;
      }

      await delay(800);
    }
  }

  async function waitForDownload(downloadId, jobId) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (!state.job || state.job.id !== jobId) return false;
      const response = await send({ type: "YTDL_DOWNLOAD_STATE", downloadId });
      if (response.ok && response.data) {
        if (response.data.state === "complete") return true;
        if (response.data.state === "interrupted") return false;
      }
      await delay(500);
    }
    return false;
  }

  function markSaved() {
    if (!state.job) return;
    state.job.active = false;
    state.job.state = "saved";
    state.job.percent = 100;
    updateButtonBusy();
    renderFooter();
    showToast("Saved to Downloads");
    setTimeout(() => {
      if (state.job && state.job.state === "saved") {
        state.job = null;
        renderFooter();
      }
    }, 5000);
  }

  function markCancelled() {
    if (!state.job) return;
    state.job.active = false;
    state.job.state = "cancelled";
    updateButtonBusy();
    renderFooter();
    showToast("Download cancelled");
    setTimeout(() => {
      if (state.job && state.job.state === "cancelled") {
        state.job = null;
        renderFooter();
      }
    }, 4000);
  }

  async function cancelJob() {
    const job = state.job;
    if (!job || !job.active) return;
    const jobId = job.id;
    job.active = false;
    job.state = "cancelled";
    state.pollToken += 1;
    updateButtonBusy();
    renderFooter();
    if (jobId) {
      await send({ type: "YTDL_CANCEL", jobId });
    }
    if (state.job === job) markCancelled();
  }

  function failJob(error) {
    if (state.job) {
      state.job.active = false;
      state.job.state = "error";
      state.job.error = errorText(error);
    }
    updateButtonBusy();
    renderFooter();
    showToast(errorText(error), true);
  }

  function renderFooter() {
    const panel = state.panel || document.querySelector(".ytdl-panel");
    if (!panel) return;
    const foot = panel.querySelector(".ytdl-foot");
    const label = panel.querySelector(".ytdl-progress-label");
    const pct = panel.querySelector(".ytdl-progress-pct");
    const fill = panel.querySelector(".ytdl-progress-fill");
    const cancel = panel.querySelector(".ytdl-cancel");

    if (!state.job) {
      foot.hidden = true;
      return;
    }

    foot.hidden = false;
    const job = state.job;
    const cancellable =
      job.active && (job.state === "starting" || job.state === "downloading" || job.state === "processing");
    cancel.hidden = !cancellable;
    let text = "";
    let indeterminate = false;
    let percent = Math.max(0, Math.min(100, job.percent || 0));

    switch (job.state) {
      case "starting":
        text = `Preparing ${job.label}…`;
        indeterminate = true;
        break;
      case "downloading": {
        const extras = [];
        if (job.speed) extras.push(job.speed);
        if (job.eta) extras.push(`ETA ${job.eta}`);
        text = `Downloading ${job.label}${extras.length ? " · " + extras.join(" · ") : ""}`;
        break;
      }
      case "processing":
        text = "Merging audio and video…";
        indeterminate = true;
        break;
      case "done":
      case "saving":
        text = "Saving to Downloads…";
        indeterminate = true;
        break;
      case "saved":
        text = "Saved to Downloads";
        percent = 100;
        break;
      case "cancelled":
        text = "Download cancelled";
        break;
      case "error":
        text = job.error || "Download failed";
        break;
      default:
        text = "Working…";
        indeterminate = true;
    }

    label.textContent = text;
    pct.textContent =
      job.state === "downloading" || job.state === "saved" ? `${Math.round(percent)}%` : "";
    fill.style.width = `${percent}%`;
    fill.classList.toggle("ytdl-indeterminate", indeterminate);
  }

  function showToast(message, isError) {
    const player = document.querySelector("#movie_player");
    if (!player) return;
    const existing = player.querySelector(".ytdl-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = `ytdl-toast${isError ? " ytdl-toast-error" : ""}`;
    toast.innerHTML = `${isError ? ICON_ALERT : ICON_CHECK}<span></span>`;
    toast.querySelector("span").textContent = message;
    player.appendChild(toast);
    setTimeout(() => toast.remove(), 3800);
  }

  function onNavigate() {
    const videoId = currentVideoId();
    if (videoId === state.videoId) {
      ensureButton();
      return;
    }
    closePanel();
    state.videoId = videoId;
    state.formats = null;
    state.error = null;
    state.loading = false;
    state.activeTab = "video";
    state.loadToken += 1;
    const stalePanel = document.querySelector(".ytdl-panel");
    if (stalePanel) stalePanel.remove();
    state.panel = null;
    setTimeout(ensureButton, 250);
    setTimeout(ensureButton, 1200);
  }

  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("yt-page-data-updated", onNavigate);
  document.addEventListener("fullscreenchange", () => ensureButton());

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && state.open) closePanel();
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!state.open) return;
      const panel = state.panel || document.querySelector(".ytdl-panel");
      if (!panel) return;
      if (panel.contains(event.target) || (event.target.closest && event.target.closest(".ytdl-button"))) {
        return;
      }
      closePanel();
    },
    true
  );

  setInterval(ensureButton, 1000);
  ensureButton();
})();
