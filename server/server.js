"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || "127.0.0.1";
const YTDLP = process.env.YTDLP || "yt-dlp";
const FFMPEG = process.env.FFMPEG || "ffmpeg";

const jobs = new Map();
const startedAt = Date.now();
let toolInfo = null;

const MAX_ACTIVE_JOBS = 3;
const ACTIVE_JOB_TTL = 6 * 60 * 60 * 1000;
const FINISHED_JOB_TTL = 6 * 60 * 60 * 1000;

const ALLOWED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be"
]);

const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".wav": "audio/wav"
};

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed =
    !origin ||
    origin === "null" ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://");
  if (origin && allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  return allowed;
}

function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err.message || err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        try {
          child.kill();
        } catch {}
        stderr += "\nTimed out";
      }
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
      if (stdout.length > 40 * 1024 * 1024) {
        try {
          child.kill();
        } catch {}
      }
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString("utf8");
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message || err) });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function validateUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return null;
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function cleanError(stderr) {
  const lines = String(stderr || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line)) || lines.pop() || "";
  return errorLine.replace(/^ERROR:\s*/i, "").slice(0, 400) || "yt-dlp failed";
}

function normalize(info) {
  const formats = [];
  const seen = new Set();
  const duration = Number(info.duration) || 0;

  for (const format of info.formats || []) {
    if (!format || format.has_drm) continue;
    if (!format.url && !format.manifest_url) continue;
    const hasVideo = Boolean(format.vcodec && format.vcodec !== "none");
    const hasAudio = Boolean(format.acodec && format.acodec !== "none");
    if (!hasVideo && !hasAudio) continue;
    if (format.ext === "mhtml" || format.protocol === "mhtml") continue;

    if (/-drc$/i.test(String(format.format_id))) continue;

    const kind = hasVideo && hasAudio ? "av" : hasVideo ? "video" : "audio";
    const key = String(format.format_id);
    if (seen.has(key)) continue;
    seen.add(key);

    let filesize = format.filesize || format.filesize_approx || null;
    let filesizeEstimated = false;
    if (!filesize && duration && format.tbr) {
      filesize = Math.round(((format.tbr * 1000) / 8) * duration);
      filesizeEstimated = true;
    }

    formats.push({
      id: String(format.format_id),
      ext: format.ext || (kind === "audio" ? "m4a" : "mp4"),
      kind,
      height: format.height || null,
      width: format.width || null,
      fps: format.fps || null,
      vcodec: format.vcodec || "none",
      acodec: format.acodec || "none",
      dynamicRange: format.dynamic_range || null,
      filesize,
      filesizeEstimated,
      tbr: format.tbr || null,
      abr: format.abr || null,
      formatNote: format.format_note || "",
      quality: format.quality || "",
      protocol: format.protocol || ""
    });
  }

  return {
    id: info.id || "",
    title: info.title || "YouTube video",
    uploader: info.uploader || info.channel || "",
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    isLive: Boolean(
      info.is_live || info.live_status === "is_live" || info.live_status === "is_upcoming"
    ),
    formats
  };
}

async function checkTools() {
  if (toolInfo) return toolInfo;
  const [yt, ff] = await Promise.all([
    run(YTDLP, ["--version"], 15000),
    run(FFMPEG, ["-version"], 15000)
  ]);
  toolInfo = {
    ytdlp: yt.code === 0 ? yt.stdout.trim().split(/\r?\n/)[0] : null,
    ffmpeg: ff.code === 0
  };
  return toolInfo;
}

function selectorFor(formatId, kind) {
  if (kind === "video") return `${formatId}+bestaudio/best`;
  return formatId;
}

function activeJobCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.state === "starting" || job.state === "downloading" || job.state === "processing") {
      count += 1;
    }
  }
  return count;
}

function cancelJob(job) {
  if (job.state === "done" || job.state === "error" || job.state === "cancelled") return;
  job.state = "cancelled";
  job.error = "Cancelled";
  if (job.child && !job.child.killed) {
    try {
      job.child.kill();
    } catch {}
  }
  try {
    fs.rmSync(job.dir, { recursive: true, force: true });
  } catch {}
}

function startJob({ url, formatId, kind }) {
  const jobId = crypto.randomBytes(8).toString("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
  const job = {
    id: jobId,
    dir,
    state: "starting",
    percent: 0,
    speed: "",
    eta: "",
    filename: "",
    file: "",
    error: "",
    createdAt: Date.now(),
    servedAt: 0,
    child: null
  };
  jobs.set(jobId, job);

  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--no-mtime",
    "--concurrent-fragments",
    "4",
    "--retries",
    "3",
    "--merge-output-format",
    "mp4/mkv",
    "--progress-template",
    "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "-f",
    selectorFor(formatId, kind),
    "-o",
    path.join(dir, "%(title).140s [%(id)s].%(ext)s"),
    url
  ];

  const child = spawn(YTDLP, args, { windowsHide: true });
  job.child = child;

  let buffer = "";
  let stderrTail = "";

  child.stdout.on("data", (data) => {
    buffer += data.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const rawLine of lines) handleLine(job, rawLine);
  });

  child.stderr.on("data", (data) => {
    stderrTail += data.toString("utf8");
    if (stderrTail.length > 256 * 1024) stderrTail = stderrTail.slice(-128 * 1024);
    if (/\[Merger\]|\[ffmpeg\]/i.test(stderrTail)) job.state = "processing";
  });

  child.on("error", (err) => {
    if (job.state === "cancelled") return;
    job.state = "error";
    job.error = String(err.message || err);
  });

  child.on("close", (code) => {
    if (job.state === "error" || job.state === "cancelled") return;
    if (code === 0) {
      try {
        const files = fs
          .readdirSync(dir)
          .filter((name) => !/\.(part|ytdl|temp)$/i.test(name))
          .map((name) => {
            const full = path.join(dir, name);
            let size = 0;
            try {
              size = fs.statSync(full).size;
            } catch {}
            return { name, full, size };
          })
          .filter((entry) => entry.size > 0)
          .sort((a, b) => b.size - a.size);

        if (!files.length) {
          job.state = "error";
          job.error = "Download finished but no output file was found";
          return;
        }

        job.file = files[0].full;
        job.filename = files[0].name;
        job.percent = 100;
        job.speed = "";
        job.eta = "";
        job.state = "done";
      } catch (err) {
        job.state = "error";
        job.error = String(err.message || err);
      }
    } else {
      job.state = "error";
      job.error = cleanError(stderrTail);
    }
  });

  return jobId;
}

function handleLine(job, line) {
  if (job.state === "cancelled") return;
  const text = String(line).replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!text) return;

  const progress = text.match(/^([\d.]+)%\s*\|(.*?)\|(.*)$/);
  if (progress) {
    const percent = parseFloat(progress[1]);
    if (Number.isFinite(percent)) job.percent = Math.max(0, Math.min(100, percent));
    const speed = String(progress[2] || "").trim();
    const eta = String(progress[3] || "").trim();
    job.speed = /^N\/A$|^Unknown$|^$/i.test(speed) ? "" : speed;
    job.eta = /^N\/A$|^Unknown$|^$/i.test(eta) ? "" : eta;
    if (job.state === "starting") job.state = "downloading";
    return;
  }

  if (/\[Merger\]|Merging formats/i.test(text)) {
    job.state = "processing";
  }
}

function jobStatus(job) {
  return {
    jobId: job.id,
    state: job.state,
    percent: Math.round(job.percent),
    speed: job.speed,
    eta: job.eta,
    filename: job.filename,
    error: job.error
  };
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished =
      job.state === "done" || job.state === "error" || job.state === "cancelled";
    const age = now - job.createdAt;
    const expired = finished ? age > FINISHED_JOB_TTL : age > ACTIVE_JOB_TTL;
    const servedLongAgo = job.servedAt && now - job.servedAt > FINISHED_JOB_TTL;
    if (expired || servedLongAgo) {
      if (job.child && !job.child.killed && !finished) {
        try {
          job.child.kill();
        } catch {}
      }
      try {
        fs.rmSync(job.dir, { recursive: true, force: true });
      } catch {}
      jobs.delete(id);
    }
  }
}

setInterval(cleanupJobs, 5 * 60 * 1000).unref();

function serveJobFile(req, res, job) {
  if (job.state !== "done" || !job.file) {
    sendJson(req, res, 409, { error: "File is not ready" });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(job.file);
  } catch {
    sendJson(req, res, 404, { error: "File is no longer available" });
    return;
  }

  const ext = path.extname(job.filename).toLowerCase();
  const fallback = job.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(job.filename);

  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "Cache-Control": "no-store",
    "Accept-Ranges": "none"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  job.servedAt = Date.now();
  const stream = fs.createReadStream(job.file);
  stream.pipe(res);
  stream.on("error", () => {
    try {
      res.destroy();
    } catch {}
  });
}

const server = http.createServer(async (req, res) => {
  const allowed = setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!allowed) {
    sendJson(req, res, 403, { error: "Origin not allowed" });
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    sendJson(req, res, 400, { error: "Bad request" });
    return;
  }

  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (pathname === "/" || pathname === "/api/health") {
      const tools = await checkTools();
      sendJson(req, res, 200, {
        ok: Boolean(tools.ytdlp),
        service: "youtube-downloader-companion",
        ytdlp: tools.ytdlp,
        ffmpeg: tools.ffmpeg,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        error: tools.ytdlp ? undefined : "yt-dlp was not found on PATH"
      });
      return;
    }

    if (pathname === "/api/formats" && req.method === "POST") {
      const body = await readBody(req);
      const target = validateUrl(body.url);
      if (!target) {
        sendJson(req, res, 400, { error: "A valid YouTube URL is required" });
        return;
      }

      const result = await run(
        YTDLP,
        ["-J", "--no-warnings", "--no-playlist", "--no-check-formats", target],
        90000
      );

      if (result.code !== 0) {
        sendJson(req, res, 502, { error: cleanError(result.stderr) });
        return;
      }

      let info;
      try {
        info = JSON.parse(result.stdout);
      } catch {
        sendJson(req, res, 502, { error: "Could not parse yt-dlp output" });
        return;
      }

      if (info && info._type === "playlist") {
        info = (info.entries || [])[0] || info;
      }

      const tools = await checkTools();
      const data = normalize(info);
      data.ffmpeg = tools.ffmpeg;
      sendJson(req, res, 200, data);
      return;
    }

    if (pathname === "/api/download" && req.method === "POST") {
      const body = await readBody(req);
      const target = validateUrl(body.url);
      const formatId = String(body.formatId || "").trim();
      const kind = ["video", "audio", "av"].includes(body.kind) ? body.kind : "video";

      if (!target || !formatId) {
        sendJson(req, res, 400, { error: "url and formatId are required" });
        return;
      }

      const tools = await checkTools();
      if (!tools.ytdlp) {
        sendJson(req, res, 503, { error: "yt-dlp was not found on PATH" });
        return;
      }

      if (activeJobCount() >= MAX_ACTIVE_JOBS) {
        sendJson(req, res, 429, {
          error: `Too many downloads in progress (${MAX_ACTIVE_JOBS} max). Wait for one to finish.`
        });
        return;
      }

      const jobId = startJob({ url: target, formatId, kind });
      sendJson(req, res, 200, { jobId });
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]+)(?:\/(file|cancel))?$/i);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(req, res, 404, { error: "Unknown job" });
        return;
      }
      const action = jobMatch[2];
      if (action === "file") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(req, res, 405, { error: "Method not allowed" });
          return;
        }
        serveJobFile(req, res, job);
        return;
      }
      if (action === "cancel") {
        if (req.method !== "POST") {
          sendJson(req, res, 405, { error: "Method not allowed" });
          return;
        }
        cancelJob(job);
        sendJson(req, res, 200, jobStatus(job));
        return;
      }
      if (req.method !== "GET") {
        sendJson(req, res, 405, { error: "Method not allowed" });
        return;
      }
      sendJson(req, res, 200, jobStatus(job));
      return;
    }

    sendJson(req, res, 404, { error: "Not found" });
  } catch (err) {
    const message = String((err && err.message) || err);
    const status = /Invalid JSON body|too large/i.test(message) ? 400 : 500;
    sendJson(req, res, status, { error: message });
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error("");
    console.error(`  Port ${PORT} is already in use.`);
    console.error("  Another copy of the companion may already be running.");
    console.error("  Close it, or set a different PORT and update the extension popup.");
    console.error("");
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, async () => {
  const tools = await checkTools();
  console.log("");
  console.log("  YouTube Downloader companion");
  console.log(`  Listening on http://${HOST}:${PORT}`);
  console.log(`  yt-dlp : ${tools.ytdlp || "NOT FOUND"}`);
  console.log(`  ffmpeg : ${tools.ffmpeg ? "found" : "NOT FOUND (merging disabled)"}`);
  console.log("");
  console.log("  Keep this window open while downloading. Press Ctrl+C to stop.");
  console.log("");
});

