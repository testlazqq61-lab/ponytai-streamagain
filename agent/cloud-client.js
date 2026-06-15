import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class CloudClient {
  constructor(config, manager) {
    this.config = config;
    this.manager = manager;
    this.localByCloud = new Map();
    this.cacheDir = path.join(config.dataDir, "cloud-videos");
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  start() {
    if (!this.config.cloudApiUrl) return;
    this.poll().catch((error) => console.error(`[cloud] ${error.message}`));
    setInterval(() => {
      this.poll().catch((error) => console.error(`[cloud] ${error.message}`));
    }, this.config.cloudPollMs);
  }

  async poll() {
    const streams = this.manager.list();
    await this.post("/api/agent/heartbeat", {
      name: this.config.cloudAgentName,
      details: {
        videoRoot: this.config.videoRoot,
        ffmpegPath: this.config.ffmpegPath,
        running: streams.filter((stream) => stream.status === "running").length,
        streams
      }
    });

    const { jobs } = await this.get("/api/agent/jobs");
    for (const job of jobs) {
      if (job.status === "queued") await this.startCloudJob(job);
      if (job.status === "stopping") await this.stopCloudJob(job);
    }
    await this.syncCloudStatuses(streams);
  }

  async startCloudJob(job) {
    if (this.localByCloud.has(job.id)) return;

    try {
      await this.updateJob(job.id, "downloading", "Downloading video from B2.");
      const file = await this.downloadVideo(job);
      const { id: localJobId } = this.manager.start({
        title: job.title,
        file,
        repeat: job.repeat,
        destinations: job.destinations
      });
      this.localByCloud.set(job.id, localJobId);
      await this.updateJob(job.id, "running", "FFmpeg started.", localJobId);
    } catch (error) {
      await this.updateJob(job.id, "error", error.message);
    }
  }

  async stopCloudJob(job) {
    const localJobId = this.localByCloud.get(job.id) || job.localJobId;
    if (localJobId) {
      try {
        this.manager.stop(localJobId);
      } catch {
        // The local process may already be gone; the cloud state still needs to move forward.
      }
    }
    this.localByCloud.delete(job.id);
    await this.updateJob(job.id, "stopped", "Stop requested.");
  }

  async downloadVideo(job) {
    const fileName = safeFileName(job.videoName || path.basename(job.videoKey));
    const target = path.join(this.cacheDir, `${job.id}-${fileName}`);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

    const response = await fetch(`${this.config.cloudApiUrl}/api/videos/download?key=${encodeURIComponent(job.videoKey)}`);
    if (!response.ok || !response.body) {
      throw new Error(`Video download failed with HTTP ${response.status}.`);
    }
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
    return target;
  }

  updateJob(id, status, message, localJobId = null) {
    return this.post(`/api/agent/jobs/${id}/status`, {
      status,
      message,
      localJobId,
      agent: {
        name: this.config.cloudAgentName,
        updatedAt: new Date().toISOString()
      }
    });
  }

  async syncCloudStatuses(streams) {
    const streamsById = new Map(streams.map((stream) => [stream.id, stream]));
    for (const [cloudId, localId] of this.localByCloud.entries()) {
      const stream = streamsById.get(localId);
      if (!stream) {
        this.localByCloud.delete(cloudId);
        continue;
      }
      await this.post(`/api/agent/jobs/${cloudId}/status`, {
        status: stream.status,
        message: "Resource update.",
        localJobId: localId,
        resources: stream.resources,
        agent: {
          name: this.config.cloudAgentName,
          updatedAt: new Date().toISOString()
        }
      });
      if (stream.status !== "running") this.localByCloud.delete(cloudId);
    }
  }

  async get(route) {
    const response = await fetch(`${this.config.cloudApiUrl}${route}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Cloud GET ${route} failed.`);
    return data;
  }

  async post(route, body) {
    const response = await fetch(`${this.config.cloudApiUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Cloud POST ${route} failed.`);
    return data;
  }
}

function safeFileName(name) {
  return String(name || "video.mp4").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
