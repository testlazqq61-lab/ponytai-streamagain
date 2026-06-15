import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { StreamManager } from "./stream-manager.js";

const config = loadConfig();
const manager = new StreamManager(config);

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, { ok: true, videoRoot: config.videoRoot, ffmpegPath: config.ffmpegPath });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/videos") {
      sendJson(res, { videos: listVideos(config.videoRoot) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/videos/upload") {
      const fileName = sanitizeFileName(url.searchParams.get("name") || "");
      if (!fileName) throw new Error("File name is required.");
      const target = path.join(config.videoRoot, fileName);
      await saveRequestBody(req, target);
      sendJson(res, { ok: true, video: videoInfo(target) }, 201);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/streams") {
      sendJson(res, { streams: manager.list() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/streams") {
      const body = await readJson(req);
      const file = resolveVideoPath(body.file);
      sendJson(res, manager.start({ ...body, file }), 201);
      return;
    }

    const stopMatch = url.pathname.match(/^\/api\/streams\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      sendJson(res, manager.stop(stopMatch[1]));
      return;
    }

    if (req.method === "GET") {
      serveWeb(req, res);
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
});

server.listen(config.port, () => {
  console.log(`Ponytai local agent running at http://localhost:${config.port}`);
  console.log(`Video root: ${config.videoRoot}`);
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body is too large."));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
  });
}

function listVideos(root) {
  const supported = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
  const files = [];
  walk(root, files, supported);
  return files.map(videoInfo);
}

function walk(dir, files, supported) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      walk(fullPath, files, supported);
    } else if (supported.has(path.extname(item.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
}

function resolveVideoPath(relativePath) {
  const fullPath = path.resolve(config.videoRoot, relativePath || "");
  const rootWithSeparator = config.videoRoot.endsWith(path.sep) ? config.videoRoot : `${config.videoRoot}${path.sep}`;
  if (fullPath !== config.videoRoot && !fullPath.startsWith(rootWithSeparator)) {
    throw new Error("Video file must be inside VIDEO_ROOT.");
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error("Video file does not exist.");
  }
  return fullPath;
}

function saveRequestBody(req, target) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target, { flags: "w" });
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
    });
    req.pipe(output);
    req.on("error", reject);
    output.on("error", reject);
    output.on("finish", () => {
      if (size === 0) {
        fs.rmSync(target, { force: true });
        reject(new Error("Uploaded file is empty."));
        return;
      }
      resolve();
    });
  });
}

function sanitizeFileName(name) {
  const cleaned = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  const ext = path.extname(cleaned).toLowerCase();
  const supported = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
  if (!cleaned || !supported.has(ext)) return "";
  return cleaned;
}

function videoInfo(file) {
  const stat = fs.statSync(file);
  return {
    name: path.basename(file),
    relativePath: path.relative(config.videoRoot, file),
    size: stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

function serveWeb(req, res) {
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.resolve(webDir, `.${pathname}`);

  if (!target.startsWith(webDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };

  res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
}
