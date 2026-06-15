const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const VIDEO_PREFIX = "videos/";
const CONTROL_PREFIX = "_control/";
const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
let cachedAuth = null;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const route = `/${(params.path || []).join("/")}`;

  if (request.method === "OPTIONS") return emptyResponse();

  try {
    const b2 = await createB2Client(env);

    if (request.method === "GET" && route === "/health") {
      const agent = await readJson(b2, `${CONTROL_PREFIX}agent.json`, null);
      return json({ ok: true, mode: "b2", agent });
    }

    if (request.method === "GET" && route === "/videos") {
      return json(await storageSummary(b2));
    }

    if (request.method === "GET" && route === "/videos/file") {
      const key = String(url.searchParams.get("key") || "");
      if (!key.startsWith(VIDEO_PREFIX)) return json({ error: "Invalid video key." }, 400);
      const response = await b2.download(key);
      if (!response.ok) return json({ error: "Video not found." }, 404);
      return new Response(response.body, {
        headers: {
          "Content-Type": response.headers.get("content-type") || "application/octet-stream",
          "Content-Length": response.headers.get("content-length") || "",
          "Accept-Ranges": response.headers.get("accept-ranges") || "bytes",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (request.method === "POST" && route === "/videos/upload") {
      const name = sanitizeFileName(url.searchParams.get("name") || "");
      if (!name) return json({ error: "A supported video file name is required." }, 400);
      const contentLength = Number(request.headers.get("content-length") || "0");
      if (!contentLength) return json({ error: "Upload size is required." }, 411);
      await assertStorageRoom(b2, contentLength);
      const key = `${VIDEO_PREFIX}${Date.now()}-${name}`;
      const upload = await b2.uploadUrl();
      const uploaded = await b2.upload(upload, key, request.body, {
        contentLength,
        contentType: request.headers.get("content-type") || "application/octet-stream",
        metadata: { originalName: encodeURIComponent(name) }
      });
      return json({ ok: true, video: fileToVideo(uploaded) }, 201);
    }

    if (request.method === "POST" && route === "/videos/import-url") {
      const body = await request.json();
      const sourceUrl = new URL(String(body.url || ""));
      if (!["http:", "https:"].includes(sourceUrl.protocol)) return json({ error: "Only HTTP(S) URLs are supported." }, 400);
      const name = sanitizeFileName(body.name || sourceUrl.pathname.split("/").pop() || "");
      if (!name) return json({ error: "A supported video file name is required." }, 400);
      const upstream = await fetch(sourceUrl);
      if (!upstream.ok || !upstream.body) return json({ error: `Video URL returned HTTP ${upstream.status}.` }, 400);
      const contentLength = Number(upstream.headers.get("content-length") || "0");
      if (!contentLength) return json({ error: "The URL must include a Content-Length header for the 5GB quota check." }, 411);
      await assertStorageRoom(b2, contentLength);
      const key = `${VIDEO_PREFIX}${Date.now()}-${name}`;
      const upload = await b2.uploadUrl();
      const uploaded = await b2.upload(upload, key, upstream.body, {
        contentLength,
        contentType: upstream.headers.get("content-type") || "application/octet-stream",
        metadata: { originalName: encodeURIComponent(name), importedFrom: encodeURIComponent(sourceUrl.href) }
      });
      return json({ ok: true, video: fileToVideo(uploaded) }, 201);
    }

    if (request.method === "POST" && route === "/videos/rename") {
      const body = await request.json();
      const key = String(body.key || "");
      const name = sanitizeFileName(body.name || "");
      if (!key.startsWith(VIDEO_PREFIX)) return json({ error: "Invalid video key." }, 400);
      if (!name) return json({ error: "A supported video file name is required." }, 400);
      const source = await b2.fileInfo(key);
      if (!source) return json({ error: "Video not found." }, 404);
      const targetKey = `${VIDEO_PREFIX}${Date.now()}-${name}`;
      const download = await b2.download(key);
      if (!download.ok || !download.body) return json({ error: "Could not read the source video." }, 400);
      const upload = await b2.uploadUrl();
      const uploaded = await b2.upload(upload, targetKey, download.body, {
        contentLength: Number(source.contentLength || download.headers.get("content-length") || 0),
        contentType: download.headers.get("content-type") || "application/octet-stream",
        metadata: { originalName: encodeURIComponent(name) }
      });
      await b2.deleteFile(source.fileName, source.fileId);
      return json({ ok: true, video: fileToVideo(uploaded) });
    }

    if (request.method === "GET" && route === "/videos/download") {
      const key = String(url.searchParams.get("key") || "");
      if (!key.startsWith(VIDEO_PREFIX)) return json({ error: "Invalid video key." }, 400);
      const response = await b2.download(key);
      if (!response.ok) return json({ error: "Video not found." }, 404);
      return new Response(response.body, {
        headers: {
          "Content-Type": response.headers.get("content-type") || "application/octet-stream",
          "Content-Length": response.headers.get("content-length") || "",
          "Content-Disposition": `attachment; filename="${safeHeaderName(key.split("/").pop())}"`
        }
      });
    }

    if (request.method === "DELETE" && route === "/videos") {
      const key = String(url.searchParams.get("key") || "");
      if (!key.startsWith(VIDEO_PREFIX)) return json({ error: "Invalid video key." }, 400);
      const file = await b2.fileInfo(key);
      if (file) await b2.deleteFile(file.fileName, file.fileId);
      return json({ ok: true });
    }

    if (request.method === "GET" && route === "/streams") {
      const jobs = await readJobs(b2);
      return json({ streams: jobs.map(publicJob) });
    }

    if (request.method === "POST" && route === "/streams") {
      const body = await request.json();
      const videoKey = String(body.file || body.videoKey || "");
      if (!videoKey.startsWith(VIDEO_PREFIX)) return json({ error: "Select a B2 video first." }, 400);
      const video = await b2.fileInfo(videoKey);
      if (!video) return json({ error: "Selected video does not exist." }, 404);
      const destinations = Array.isArray(body.destinations) ? body.destinations : [];
      if (!destinations.length) return json({ error: "Add at least one destination." }, 400);

      const job = {
        id: crypto.randomUUID(),
        title: String(body.title || "Untitled stream").trim(),
        videoKey,
        videoName: videoToName(video),
        repeat: body.repeat === "once" ? "once" : "loop",
        destinations,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agent: null,
        log: []
      };
      const jobs = await readJobs(b2);
      jobs.unshift(job);
      await writeJobs(b2, jobs);
      await appendHistory(b2, { ...publicJob(job), event: "created" });
      return json({ id: job.id, stream: publicJob(job) }, 201);
    }

    const stopMatch = route.match(/^\/streams\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      const jobs = await readJobs(b2);
      const job = jobs.find((item) => item.id === stopMatch[1]);
      if (!job) return json({ error: "Stream not found." }, 404);
      job.status = "stopping";
      job.updatedAt = new Date().toISOString();
      await writeJobs(b2, jobs);
      return json({ ok: true });
    }

    if (request.method === "GET" && route === "/history") {
      return json({ history: await readJson(b2, `${CONTROL_PREFIX}history.json`, []) });
    }

    if (request.method === "GET" && route === "/agent/jobs") {
      const jobs = await readJobs(b2);
      return json({ jobs: jobs.filter((job) => ["queued", "stopping"].includes(job.status)) });
    }

    if (request.method === "POST" && route === "/agent/heartbeat") {
      const body = await request.json().catch(() => ({}));
      const agent = {
        name: String(body.name || "desktop-agent"),
        status: "online",
        updatedAt: new Date().toISOString(),
        details: body.details || {}
      };
      await writeJson(b2, `${CONTROL_PREFIX}agent.json`, agent);
      return json({ ok: true, agent });
    }

    const statusMatch = route.match(/^\/agent\/jobs\/([^/]+)\/status$/);
    if (request.method === "POST" && statusMatch) {
      const body = await request.json();
      const jobs = await readJobs(b2);
      const job = jobs.find((item) => item.id === statusMatch[1]);
      if (!job) return json({ error: "Stream not found." }, 404);
      job.status = String(body.status || job.status);
      job.agent = body.agent || job.agent;
      job.localJobId = body.localJobId || job.localJobId;
      job.resources = body.resources || job.resources;
      job.updatedAt = new Date().toISOString();
      if (body.message) job.log = [...(job.log || []), String(body.message)].slice(-40);
      await writeJobs(b2, jobs);
      await appendHistory(b2, { ...publicJob(job), event: job.status });
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
}

async function createB2Client(env) {
  const keyId = cleanSecret(env.B2_KEY_ID);
  const applicationKey = cleanSecret(env.B2_APPLICATION_KEY);
  const bucketName = cleanSecret(env.B2_BUCKET_NAME) || "ponytai-streamagain-videos";
  let bucketId = cleanSecret(env.B2_BUCKET_ID);
  if (!keyId || !applicationKey) throw new Error("Backblaze B2 secrets are not configured.");

  const basic = base64Encode(`${keyId}:${applicationKey}`);
  const auth = await getB2Auth(basic);
  if (!bucketId) {
    const bucket = await fetch(`${auth.apiInfo.storageApi.apiUrl}/b2api/v3/b2_list_buckets`, {
      method: "POST",
      headers: b2Headers(auth),
      body: JSON.stringify({ accountId: auth.accountId, bucketName })
    }).then(readB2);
    bucketId = bucket.buckets?.[0]?.bucketId;
  }
  if (!bucketId) throw new Error(`Backblaze B2 bucket not found: ${bucketName}`);

  return {
    auth,
    bucketId,
    bucketName,
    apiUrl: auth.apiInfo.storageApi.apiUrl,
    downloadUrl: auth.apiInfo.storageApi.downloadUrl,
    async list(prefix) {
      const files = [];
      let startFileName = null;
      do {
        const page = await fetch(`${this.apiUrl}/b2api/v3/b2_list_file_names`, {
          method: "POST",
          headers: b2Headers(auth),
          body: JSON.stringify({ bucketId, prefix, startFileName, maxFileCount: 1000 })
        }).then(readB2);
        files.push(...(page.files || []));
        startFileName = page.nextFileName || null;
      } while (startFileName);
      return files;
    },
    async uploadUrl() {
      return fetch(`${this.apiUrl}/b2api/v3/b2_get_upload_url`, {
        method: "POST",
        headers: b2Headers(auth),
        body: JSON.stringify({ bucketId })
      }).then(readB2);
    },
    async upload(upload, fileName, body, options) {
      const headers = {
        Authorization: upload.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(fileName),
        "Content-Type": options.contentType,
        "Content-Length": String(options.contentLength),
        "X-Bz-Content-Sha1": "do_not_verify"
      };
      for (const [key, value] of Object.entries(options.metadata || {})) {
        headers[`X-Bz-Info-${key}`] = String(value);
      }
      return fetch(upload.uploadUrl, { method: "POST", headers, body }).then(readB2);
    },
    async download(fileName) {
      return fetch(`${this.downloadUrl}/file/${bucketName}/${fileName}`, {
        headers: { Authorization: auth.authorizationToken }
      });
    },
    async fileInfo(fileName) {
      const list = await this.list(fileName);
      return list.find((file) => file.fileName === fileName) || null;
    },
    async deleteFile(fileName, fileId) {
      return fetch(`${this.apiUrl}/b2api/v3/b2_delete_file_version`, {
        method: "POST",
        headers: b2Headers(auth),
        body: JSON.stringify({ fileName, fileId })
      }).then(readB2);
    }
  };
}

async function getB2Auth(basic) {
  if (cachedAuth && cachedAuth.expiresAt > Date.now()) return cachedAuth.auth;
  const auth = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` }
  }).then(readB2);
  cachedAuth = {
    auth,
    expiresAt: Date.now() + 45 * 60 * 1000
  };
  return auth;
}

async function storageSummary(b2) {
  const files = await b2.list(VIDEO_PREFIX);
  const videos = files.map(fileToVideo);
  const usedBytes = videos.reduce((sum, video) => sum + video.size, 0);
  return {
    videos,
    usedBytes,
    limitBytes: STORAGE_LIMIT_BYTES,
    remainingBytes: Math.max(0, STORAGE_LIMIT_BYTES - usedBytes),
    usagePercent: STORAGE_LIMIT_BYTES ? Math.round((usedBytes / STORAGE_LIMIT_BYTES) * 1000) / 10 : 0
  };
}

async function assertStorageRoom(b2, incomingBytes) {
  const summary = await storageSummary(b2);
  if (summary.usedBytes + incomingBytes > STORAGE_LIMIT_BYTES) {
    throw new Error("Storage limit exceeded. Delete videos before uploading more.");
  }
}

async function readJobs(b2) {
  return readJson(b2, `${CONTROL_PREFIX}jobs.json`, []);
}

async function writeJobs(b2, jobs) {
  await writeJson(b2, `${CONTROL_PREFIX}jobs.json`, jobs.slice(0, 100));
}

async function appendHistory(b2, item) {
  const history = await readJson(b2, `${CONTROL_PREFIX}history.json`, []);
  history.unshift({ ...item, historyAt: new Date().toISOString() });
  await writeJson(b2, `${CONTROL_PREFIX}history.json`, history.slice(0, 200));
}

async function readJson(b2, fileName, fallback) {
  const response = await b2.download(fileName);
  if (!response.ok) return fallback;
  return JSON.parse(await response.text());
}

async function writeJson(b2, fileName, value) {
  const text = JSON.stringify(value, null, 2);
  const upload = await b2.uploadUrl();
  await b2.upload(upload, fileName, text, {
    contentLength: new TextEncoder().encode(text).length,
    contentType: "application/json; charset=utf-8",
    metadata: {}
  });
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    file: job.videoName,
    videoKey: job.videoKey,
    repeat: job.repeat,
    destinations: (job.destinations || []).map((destination) => ({
      platform: destination.platform,
      label: destination.label || destination.platform
    })),
    status: job.status,
    startedAt: job.createdAt,
    updatedAt: job.updatedAt,
    agent: job.agent,
    resources: job.resources || null,
    log: job.log || []
  };
}

function fileToVideo(file) {
  return {
    key: file.fileName,
    name: videoToName(file),
    relativePath: file.fileName,
    size: Number(file.contentLength || 0),
    updatedAt: file.uploadTimestamp ? new Date(Number(file.uploadTimestamp)).toISOString() : null
  };
}

function videoToName(file) {
  const info = file.fileInfo || {};
  return decodeURIComponent(info.originalName || file.fileName.split("/").pop());
}

function sanitizeFileName(name) {
  const cleaned = String(name).split(/[\\/]/).pop().replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  const extension = cleaned.includes(".") ? cleaned.slice(cleaned.lastIndexOf(".")).toLowerCase() : "";
  if (!cleaned || !SUPPORTED_EXTENSIONS.has(extension)) return "";
  return cleaned;
}

function safeHeaderName(name) {
  return String(name || "video").replace(/["\r\n]/g, "_");
}

function b2Headers(auth) {
  return {
    Authorization: auth.authorizationToken,
    "Content-Type": "application/json"
  };
}

function cleanSecret(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function base64Encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readB2(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.message || `Backblaze B2 HTTP ${response.status}`);
  return data;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function emptyResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
