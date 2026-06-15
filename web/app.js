const apiBase = window.location.origin.startsWith("http") ? "" : "http://localhost:8787";

const state = {
  destinations: [],
  selectedPlatform: "youtube",
  videos: [],
  history: [],
  streams: [],
  storage: {
    usedBytes: 0,
    limitBytes: 5 * 1024 * 1024 * 1024,
    remainingBytes: 5 * 1024 * 1024 * 1024,
    usagePercent: 0
  },
  agent: null,
  agentStreams: []
};

const elements = {
  agentDot: document.querySelector("#agentDot"),
  agentLabel: document.querySelector("#agentLabel"),
  agentRoot: document.querySelector("#agentRoot"),
  refreshButton: document.querySelector("#refreshButton"),
  runningCount: document.querySelector("#runningCount"),
  storageText: document.querySelector("#storageText"),
  storageBar: document.querySelector("#storageBar"),
  resourceSummary: document.querySelector("#resourceSummary"),
  titleInput: document.querySelector("#titleInput"),
  videoSelect: document.querySelector("#videoSelect"),
  streamForm: document.querySelector("#streamForm"),
  destinationList: document.querySelector("#destinationList"),
  addDestinationButton: document.querySelector("#addDestinationButton"),
  destinationDialog: document.querySelector("#destinationDialog"),
  destinationForm: document.querySelector("#destinationForm"),
  platformButtons: document.querySelector("#platformButtons"),
  serverUrlLabel: document.querySelector("#serverUrlLabel"),
  serverUrlInput: document.querySelector("#serverUrlInput"),
  streamKeyInput: document.querySelector("#streamKeyInput"),
  toast: document.querySelector("#toast"),
  viewButtons: document.querySelectorAll("[data-view-button]"),
  views: document.querySelectorAll("[data-view]"),
  videosList: document.querySelector("#videosList"),
  historyList: document.querySelector("#historyList"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  openUploadButton: document.querySelector("#openUploadButton"),
  uploadDialog: document.querySelector("#uploadDialog"),
  uploadForm: document.querySelector("#uploadForm"),
  dialogVideoInput: document.querySelector("#dialogVideoInput"),
  deviceUploadPane: document.querySelector("#deviceUploadPane"),
  urlUploadPane: document.querySelector("#urlUploadPane"),
  videoUrlInput: document.querySelector("#videoUrlInput"),
  videoUrlNameInput: document.querySelector("#videoUrlNameInput"),
  uploadModeButtons: document.querySelectorAll("[data-upload-mode]"),
  historyFilterButtons: document.querySelectorAll("[data-history-filter]")
};

const preferences = {
  historyFilter: "all",
  lastTitle: localStorage.getItem("ponytai:lastTitle") || ""
};

elements.titleInput.value = preferences.lastTitle;
elements.titleInput.addEventListener("input", () => {
  preferences.lastTitle = elements.titleInput.value;
  localStorage.setItem("ponytai:lastTitle", preferences.lastTitle);
});

elements.refreshButton.addEventListener("click", refresh);
elements.addDestinationButton.addEventListener("click", () => elements.destinationDialog.showModal());
elements.platformButtons.addEventListener("click", selectPlatform);
elements.destinationForm.addEventListener("submit", addDestination);
elements.streamForm.addEventListener("submit", startStream);
elements.dialogVideoInput.addEventListener("change", uploadVideo);
elements.openUploadButton.addEventListener("click", () => elements.uploadDialog.showModal());
elements.uploadForm.addEventListener("submit", importVideoUrl);
elements.clearHistoryButton.addEventListener("click", clearHistory);
elements.uploadModeButtons.forEach((button) => {
  button.addEventListener("click", () => setUploadMode(button.dataset.uploadMode));
});
elements.historyFilterButtons.forEach((button) => {
  button.addEventListener("click", () => setHistoryFilter(button.dataset.historyFilter));
});
elements.viewButtons.forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.viewButton));
});
setupDropUpload(elements.videosList);
setupDropUpload(elements.deviceUploadPane);

refresh();
setInterval(refreshLight, 30000);

async function refresh() {
  await Promise.all([loadHealth(), loadVideos(), refreshStreams(), loadHistory()]);
}

async function refreshLight() {
  await Promise.all([loadHealth(), refreshStreams()]);
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    state.agent = health.agent;
    state.agentStreams = health.agent?.details?.streams || [];
    renderAgent();
    renderResourceSummary();
  } catch {
    state.agent = null;
    state.agentStreams = [];
    renderAgent();
    renderResourceSummary();
  }
}

async function loadVideos() {
  try {
    const summary = await api("/api/videos");
    state.videos = summary.videos || [];
    state.storage = {
      usedBytes: summary.usedBytes,
      limitBytes: summary.limitBytes,
      remainingBytes: summary.remainingBytes,
      usagePercent: summary.usagePercent
    };
    renderStorage();
    renderVideoSelect();
    renderVideos();
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshStreams() {
  try {
    const { streams } = await api("/api/streams");
    state.streams = streams || [];
    elements.runningCount.textContent = state.streams.filter((stream) => stream.status === "running").length;
    renderResourceSummary();
    renderHistory();
  } catch {
    elements.runningCount.textContent = "0";
    renderResourceSummary();
  }
}

async function loadHistory() {
  try {
    const { history } = await api("/api/history");
    state.history = history || [];
    renderHistory();
  } catch {
    state.history = [];
    renderHistory();
  }
}

function renderAgent() {
  const isFresh = state.agent?.updatedAt && Date.now() - new Date(state.agent.updatedAt).getTime() < 30000;
  elements.agentDot.classList.toggle("online", Boolean(isFresh));
  elements.agentLabel.textContent = isFresh ? "PC agent online" : "PC agent offline";
  elements.agentRoot.textContent = isFresh ? `${state.agent.name} · ${new Date(state.agent.updatedAt).toLocaleTimeString()}` : "Waiting for the Windows startup agent";
}

function renderStorage() {
  elements.storageText.textContent = `${formatBytes(state.storage.usedBytes)} / ${formatBytes(state.storage.limitBytes)}`;
  elements.storageBar.style.width = `${Math.min(100, state.storage.usagePercent || 0)}%`;
}

function renderVideoSelect() {
  elements.videoSelect.innerHTML = "";
  if (!state.videos.length) {
    elements.videoSelect.append(new Option("No B2 videos uploaded yet", ""));
    return;
  }
  for (const video of state.videos) {
    elements.videoSelect.append(new Option(`${video.name} (${formatBytes(video.size)})`, video.key));
  }
}

function selectPlatform(event) {
  const button = event.target.closest("[data-platform]");
  if (!button) return;

  state.selectedPlatform = button.dataset.platform;
  for (const item of elements.platformButtons.querySelectorAll(".platform")) {
    item.classList.toggle("active", item === button);
  }
  elements.serverUrlLabel.classList.toggle("hidden", state.selectedPlatform !== "rtmp" && state.selectedPlatform !== "tiktok");
}

function addDestination(event) {
  event.preventDefault();
  const streamKey = elements.streamKeyInput.value.trim();
  const serverUrl = elements.serverUrlInput.value.trim();

  if (!streamKey) return;
  if ((state.selectedPlatform === "rtmp" || state.selectedPlatform === "tiktok") && !serverUrl) {
    showToast("Enter a server URL first.");
    return;
  }

  state.destinations.push({
    platform: state.selectedPlatform,
    label: platformLabel(state.selectedPlatform),
    streamKey,
    serverUrl
  });

  elements.streamKeyInput.value = "";
  elements.serverUrlInput.value = "";
  elements.destinationDialog.close();
  renderDestinations();
}

function renderDestinations() {
  elements.destinationList.innerHTML = "";
  if (!state.destinations.length) {
    elements.destinationList.innerHTML = `<p class="empty">No destination added yet.</p>`;
    return;
  }

  state.destinations.forEach((destination, index) => {
    const row = document.createElement("div");
    row.className = "destination";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(destination.label)}</strong>
        <code>${maskKey(destination.streamKey)}</code>
      </div>
      <button class="danger" type="button">Remove</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      state.destinations.splice(index, 1);
      renderDestinations();
    });
    elements.destinationList.append(row);
  });
}

async function startStream(event) {
  event.preventDefault();
  if (!state.destinations.length) {
    showToast("Add at least one destination first.");
    return;
  }

  const form = new FormData(elements.streamForm);
  const payload = {
    title: String(form.get("title") || "").trim(),
    file: form.get("file"),
    repeat: form.get("repeat") === "once" ? "once" : "loop",
    destinations: state.destinations
  };

  try {
    await api("/api/streams", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    preferences.lastTitle = payload.title;
    localStorage.setItem("ponytai:lastTitle", payload.title);
    showToast(`Livestream started: ${payload.title}`);
    elements.videoSelect.value = payload.file;
    elements.streamForm.querySelector('[name="repeat"][value="loop"]').checked = payload.repeat !== "once";
    state.destinations = [];
    renderDestinations();
    await refreshStreams();
    await loadHistory();
  } catch (error) {
    showToast(error.message);
  }
}

async function uploadVideo(event) {
  const file = event.target?.files?.[0] || event.file;
  if (!file) return;
  if (state.storage.usedBytes + file.size > state.storage.limitBytes) {
    showToast("The 5GB B2 storage limit would be exceeded.");
    return;
  }

  try {
    showToast("Uploading video to Backblaze B2...");
    await fetch(`${apiBase}/api/videos/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed.");
      return data;
    });
    showToast("Video uploaded to B2.");
    elements.uploadDialog.close();
    await loadVideos();
  } catch (error) {
    showToast(error.message);
  } finally {
    if (event.target) event.target.value = "";
  }
}

function setupDropUpload(target) {
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    target.classList.add("dragging");
  });
  target.addEventListener("dragleave", () => {
    target.classList.remove("dragging");
  });
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    target.classList.remove("dragging");
    uploadVideo({ file: event.dataTransfer?.files?.[0] });
  });
}

function renderVideos() {
  elements.videosList.innerHTML = "";
  if (!state.videos.length) {
    elements.videosList.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-box"></div>
          <strong>No video found</strong>
          <div>Upload to Backblaze B2, capped at 5GB total.</div>
          <button class="primary inline-action" type="button" data-empty-upload>Browse videos</button>
        </div>
      </div>
    `;
    elements.videosList.querySelector("[data-empty-upload]").addEventListener("click", () => elements.uploadDialog.showModal());
    return;
  }

  for (const video of state.videos) {
    const row = document.createElement("article");
    row.className = "video-card";
    row.innerHTML = `
      <div class="video-preview">
        <video muted playsinline preload="metadata" src="${videoSource(video)}"></video>
        <span>${formatDuration(video.durationSeconds)}</span>
      </div>
      <div class="video-meta">
        <strong>${escapeHtml(video.name)}</strong>
        <small>${formatBytes(video.size)} · ${new Date(video.updatedAt).toLocaleString()}</small>
      </div>
      <div class="row-actions">
        <button class="secondary" type="button" data-use>Use</button>
        <button class="secondary" type="button" data-rename>Rename</button>
        <button class="danger" type="button" data-delete>Delete</button>
      </div>
    `;
    row.querySelector("[data-use]").addEventListener("click", () => {
      elements.videoSelect.value = video.key;
      showView("stream");
    });
    row.querySelector("[data-rename]").addEventListener("click", () => renameVideo(video));
    row.querySelector("[data-delete]").addEventListener("click", () => deleteVideo(video.key));
    elements.videosList.append(row);
  }
}

async function renameVideo(video) {
  const nextName = prompt("New video name", video.name);
  if (!nextName || nextName === video.name) return;
  await api("/api/videos/rename", {
    method: "POST",
    body: JSON.stringify({ key: video.key, name: nextName })
  });
  showToast("Video renamed.");
  await loadVideos();
}

async function deleteVideo(key) {
  await api(`/api/videos?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  showToast("Video deleted.");
  await loadVideos();
}

function renderHistory() {
  elements.historyList.innerHTML = "";
  const entries = combinedHistory().filter((item) => {
    if (preferences.historyFilter === "all") return true;
    if (preferences.historyFilter === "running") return item.status === "running";
    if (preferences.historyFilter === "finished") return ["stopped", "ended", "error"].includes(item.status);
    return item.status === preferences.historyFilter;
  });

  if (!entries.length) {
    elements.historyList.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-box"></div>
          <strong>No history found</strong>
          <div>Create a new live stream from the control panel.</div>
          <button class="primary inline-action" type="button" data-new-stream>+ New live stream</button>
        </div>
      </div>
    `;
    elements.historyList.querySelector("[data-new-stream]").addEventListener("click", () => showView("stream"));
    return;
  }

  for (const item of entries) {
    const row = document.createElement("div");
    row.className = "stream-card";
    row.innerHTML = `
      <div>
        <div class="history-title">
          <strong>${escapeHtml(item.title || "Untitled stream")}</strong>
          <span class="status-pill ${statusClass(item.status)}">${statusLabel(item.status)}</span>
        </div>
        <div>${new Date(item.historyAt || item.startedAt).toLocaleString()} · ${escapeHtml(item.file || "")} · ${item.destinations?.length || item.destinationCount || 1} destination</div>
        ${renderResourceLine(item)}
      </div>
      ${item.status === "running" ? `<button class="secondary" type="button" data-stop="${escapeHtml(item.id)}">Stop</button>` : ""}
    `;
    row.querySelector("[data-stop]")?.addEventListener("click", async () => {
      await api(`/api/streams/${item.id}/stop`, { method: "POST" });
      showToast(`Stopped: ${item.title}`);
      await refreshStreams();
      await loadHistory();
    });
    elements.historyList.append(row);
  }
}

async function importVideoUrl(event) {
  event.preventDefault();
  if (elements.urlUploadPane.classList.contains("hidden")) return;
  const url = elements.videoUrlInput.value.trim();
  const name = elements.videoUrlNameInput.value.trim();
  if (!url) {
    showToast("Enter a video URL first.");
    return;
  }

  try {
    showToast("Importing video to B2...");
    await api("/api/videos/import-url", {
      method: "POST",
      body: JSON.stringify({ url, name })
    });
    elements.videoUrlInput.value = "";
    elements.videoUrlNameInput.value = "";
    elements.uploadDialog.close();
    showToast("Video imported.");
    await loadVideos();
  } catch (error) {
    showToast(error.message);
  }
}

function setUploadMode(mode) {
  elements.uploadModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.uploadMode === mode);
  });
  elements.deviceUploadPane.classList.toggle("hidden", mode !== "device");
  elements.urlUploadPane.classList.toggle("hidden", mode !== "url");
}

function setHistoryFilter(filter) {
  preferences.historyFilter = filter;
  elements.historyFilterButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.historyFilter === filter);
  });
  renderHistory();
}

async function clearHistory() {
  state.history = [];
  renderHistory();
  showToast("History is stored in Cloudflare and will rotate automatically.");
}

function showView(name) {
  elements.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.viewButton === name);
  });
  elements.views.forEach((view) => {
    view.classList.toggle("active", view.dataset.view === name);
  });
}

function renderResourceSummary() {
  if (!elements.resourceSummary) return;
  const running = activeStreamsWithResources();
  if (!running.length) {
    elements.resourceSummary.innerHTML = `
      <div class="resource-card">
        <span>Status</span>
        <strong>Idle</strong>
        <small>No active FFmpeg process</small>
      </div>
    `;
    return;
  }

  const memoryBytes = running.reduce((sum, stream) => sum + (stream.resources?.memoryBytes || 0), 0);
  const cpu = running.reduce((sum, stream) => sum + (stream.resources?.cpuPercent || 0), 0);
  const encoder = running.find((stream) => stream.resources?.encoder)?.resources?.encoder || "GPU/CPU";
  elements.resourceSummary.innerHTML = `
    <div class="resource-card">
      <span>Live streams</span>
      <strong>${running.length}</strong>
      <small>${running.map((stream) => escapeHtml(stream.title)).join(", ")}</small>
    </div>
    <div class="resource-card">
      <span>CPU</span>
      <strong>${cpu ? `${cpu.toFixed(1)}%` : "Measuring"}</strong>
      <small>Total FFmpeg CPU load</small>
    </div>
    <div class="resource-card">
      <span>Memory</span>
      <strong>${memoryBytes ? formatBytes(memoryBytes) : "Measuring"}</strong>
      <small>Total FFmpeg memory</small>
    </div>
    <div class="resource-card">
      <span>Encoder</span>
      <strong>${escapeHtml(encoder)}</strong>
      <small>Current stream encoder</small>
    </div>
  `;
}

function combinedHistory() {
  const live = state.streams.map((stream) => ({
    ...stream,
    resources: stream.resources || findAgentStream(stream)?.resources || null,
    historyAt: stream.startedAt,
    destinationCount: stream.destinations?.length || 0
  }));
  const liveIds = new Set(live.map((item) => item.id));
  return [...live, ...state.history.filter((item) => !liveIds.has(item.id))];
}

function activeStreamsWithResources() {
  const cloudStreams = state.streams
    .filter((stream) => stream.status === "running")
    .map((stream) => ({
      ...stream,
      resources: stream.resources || findAgentStream(stream)?.resources || null
    }));

  if (cloudStreams.length) return cloudStreams;
  return state.agentStreams.filter((stream) => stream.status === "running");
}

function findAgentStream(stream) {
  return state.agentStreams.find((agentStream) => {
    return agentStream.id === stream.localJobId
      || agentStream.title === stream.title
      || agentStream.file === stream.file;
  });
}

function renderResourceLine(item) {
  const resources = item.resources;
  if (!resources) return "";
  const parts = [];
  if (resources.cpuPercent) parts.push(`CPU ${resources.cpuPercent.toFixed(1)}%`);
  if (resources.memoryBytes) parts.push(`Memory ${formatBytes(resources.memoryBytes)}`);
  if (resources.encoder) parts.push(resources.encoder);
  if (!parts.length) return "";
  return `<div class="resource-line">${parts.map(escapeHtml).join(" · ")}</div>`;
}

function statusClass(status) {
  if (status === "running") return "live";
  if (status === "scheduled") return "scheduled";
  return "stopped";
}

function statusLabel(status) {
  if (status === "running") return "LIVE";
  if (status === "scheduled") return "SCHEDULED";
  return "STOP";
}

function videoSource(video) {
  return `${apiBase}/api/videos/file?key=${encodeURIComponent(video.key)}`;
}

function formatDuration(seconds) {
  if (!seconds) return "Preview";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function platformLabel(platform) {
  return {
    youtube: "YouTube",
    facebook: "Facebook",
    twitch: "Twitch",
    tiktok: "TikTok",
    rtmp: "Custom RTMP"
  }[platform] || platform;
}

function maskKey(key) {
  if (key.length <= 8) return "masked";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function formatBytes(bytes = 0) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

renderDestinations();
renderHistory();
