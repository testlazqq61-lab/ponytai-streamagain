let agentUrl = localStorage.getItem("agentUrl") || "http://localhost:8787";
const state = {
  destinations: [],
  selectedPlatform: "youtube",
  videos: [],
  history: JSON.parse(localStorage.getItem("streamHistory") || "[]")
};

const elements = {
  agentDot: document.querySelector("#agentDot"),
  agentLabel: document.querySelector("#agentLabel"),
  agentRoot: document.querySelector("#agentRoot"),
  refreshButton: document.querySelector("#refreshButton"),
  runningCount: document.querySelector("#runningCount"),
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
  streamsList: document.querySelector("#streamsList"),
  toast: document.querySelector("#toast")
};

elements.offlineNotice = document.querySelector("#offlineNotice");
elements.viewButtons = document.querySelectorAll("[data-view-button]");
elements.views = document.querySelectorAll("[data-view]");
elements.videoUploadInput = document.querySelector("#videoUploadInput");
elements.videosList = document.querySelector("#videosList");
elements.historyList = document.querySelector("#historyList");
elements.clearHistoryButton = document.querySelector("#clearHistoryButton");
elements.settingsForm = document.querySelector("#settingsForm");
elements.agentUrlInput = document.querySelector("#agentUrlInput");

elements.refreshButton.addEventListener("click", refresh);
elements.addDestinationButton.addEventListener("click", () => elements.destinationDialog.showModal());
elements.platformButtons.addEventListener("click", selectPlatform);
elements.destinationForm.addEventListener("submit", addDestination);
elements.streamForm.addEventListener("submit", startStream);
elements.videoUploadInput.addEventListener("change", uploadVideo);
elements.clearHistoryButton.addEventListener("click", clearHistory);
elements.settingsForm.addEventListener("submit", saveSettings);
elements.viewButtons.forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.viewButton));
});
elements.agentUrlInput.value = agentUrl;

refresh();
setInterval(refreshStreams, 4000);

async function refresh() {
  await Promise.all([checkAgent(), loadVideos(), refreshStreams()]);
}

async function checkAgent() {
  try {
    const health = await api("/api/health");
    elements.agentDot.classList.add("online");
    elements.agentLabel.textContent = "Agent online";
    elements.agentRoot.textContent = health.videoRoot;
    elements.offlineNotice.hidden = true;
  } catch {
    elements.agentDot.classList.remove("online");
    elements.agentLabel.textContent = "Agent offline";
    elements.agentRoot.textContent = agentUrl;
    elements.offlineNotice.hidden = false;
  }
}

async function loadVideos() {
  try {
    const { videos } = await api("/api/videos");
    state.videos = videos;
    elements.videoSelect.innerHTML = "";
    if (!videos.length) {
      elements.videoSelect.append(new Option("ยังไม่มีวิดีโอใน VIDEO_ROOT", ""));
      renderVideos();
      return;
    }
    for (const video of videos) {
      elements.videoSelect.append(new Option(`${video.name} (${formatBytes(video.size)})`, video.relativePath));
    }
    renderVideos();
  } catch {
    state.videos = [];
    elements.videoSelect.innerHTML = "";
    elements.videoSelect.append(new Option("เปิด local agent ก่อน", ""));
    renderVideos();
  }
}

async function refreshStreams() {
  try {
    const { streams } = await api("/api/streams");
    elements.runningCount.textContent = streams.filter((stream) => stream.status === "running").length;
    renderStreams(streams);
  } catch {
    elements.runningCount.textContent = "0";
    elements.streamsList.innerHTML = `<p class="empty">ยังเชื่อม local agent ไม่ได้</p>`;
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
    showToast("ใส่ Server URL ก่อน");
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
    elements.destinationList.innerHTML = `<p class="empty">ยังไม่มี destination</p>`;
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
    showToast("เพิ่ม destination ก่อน");
    return;
  }

  const form = new FormData(elements.streamForm);
  const payload = {
    title: form.get("title"),
    file: form.get("file"),
    repeat: form.get("repeat") === "once" ? "once" : "loop",
    destinations: state.destinations
  };

  try {
    await api("/api/streams", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    addHistory({
      title: payload.title,
      file: payload.file,
      destinations: payload.destinations.map((destination) => destination.label),
      repeat: payload.repeat,
      startedAt: new Date().toISOString()
    });
    showToast("เริ่มไลฟ์แล้ว");
    elements.streamForm.reset();
    state.destinations = [];
    renderDestinations();
    await refreshStreams();
  } catch (error) {
    showToast(error.message);
  }
}

async function uploadVideo(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    showToast("กำลังอัพโหลดวิดีโอเข้า local agent...");
    await fetch(`${agentUrl}/api/videos/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed.");
      return data;
    });
    showToast("อัพโหลดวิดีโอแล้ว");
    await loadVideos();
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = "";
  }
}

function renderVideos() {
  elements.videosList.innerHTML = "";
  if (!state.videos.length) {
    elements.videosList.innerHTML = `<p class="empty">ยังไม่มีวิดีโอ เปิด agent แล้วอัพโหลดไฟล์ หรือวางไฟล์ไว้ในโฟลเดอร์ videos</p>`;
    return;
  }

  for (const video of state.videos) {
    const row = document.createElement("div");
    row.className = "stream-card";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(video.name)}</strong>
        <div>${formatBytes(video.size)} · ${escapeHtml(video.relativePath)}</div>
      </div>
      <button class="secondary" type="button">Use</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      elements.videoSelect.value = video.relativePath;
      showView("stream");
    });
    elements.videosList.append(row);
  }
}

function addHistory(item) {
  state.history.unshift(item);
  state.history = state.history.slice(0, 50);
  localStorage.setItem("streamHistory", JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  elements.historyList.innerHTML = "";
  if (!state.history.length) {
    elements.historyList.innerHTML = `<p class="empty">ยังไม่มี history</p>`;
    return;
  }

  for (const item of state.history) {
    const row = document.createElement("div");
    row.className = "stream-card";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <div>${new Date(item.startedAt).toLocaleString()} · ${escapeHtml(item.file)} · ${item.destinations.length} destination</div>
      </div>
    `;
    elements.historyList.append(row);
  }
}

function clearHistory() {
  state.history = [];
  localStorage.removeItem("streamHistory");
  renderHistory();
}

function saveSettings(event) {
  event.preventDefault();
  agentUrl = elements.agentUrlInput.value.trim() || "http://localhost:8787";
  localStorage.setItem("agentUrl", agentUrl);
  showToast("บันทึก Agent URL แล้ว");
  refresh();
}

function showView(name) {
  elements.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.viewButton === name);
  });
  elements.views.forEach((view) => {
    view.classList.toggle("active", view.dataset.view === name);
  });
}

function renderStreams(streams) {
  elements.streamsList.innerHTML = "";
  if (!streams.length) {
    elements.streamsList.innerHTML = `<p class="empty">ยังไม่มี stream ที่รันอยู่</p>`;
    return;
  }

  for (const stream of streams) {
    const card = document.createElement("div");
    card.className = "stream-card";
    card.innerHTML = `
      <div>
        <strong>${escapeHtml(stream.title)}</strong>
        <div>${escapeHtml(stream.file)} · ${escapeHtml(stream.status)} · ${stream.destinations.length} destination</div>
      </div>
      <button class="secondary" type="button" ${stream.status !== "running" ? "disabled" : ""}>Stop</button>
    `;
    card.querySelector("button").addEventListener("click", async () => {
      await api(`/api/streams/${stream.id}/stop`, { method: "POST" });
      await refreshStreams();
    });
    elements.streamsList.append(card);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${agentUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
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
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function formatBytes(bytes) {
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
  }, 3200);
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
