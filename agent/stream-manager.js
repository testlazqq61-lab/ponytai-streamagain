import { spawn } from "node:child_process";
import path from "node:path";

const PLATFORM_SERVERS = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  facebook: "rtmps://live-api-s.facebook.com:443/rtmp",
  twitch: "rtmp://live.twitch.tv/app",
  tiktok: "",
  rtmp: ""
};

export class StreamManager {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
  }

  list() {
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      title: job.title,
      file: path.basename(job.file),
      repeat: job.repeat,
      destinations: job.destinations.map((destination) => ({
        platform: destination.platform,
        label: destination.label || destination.platform
      })),
      startedAt: job.startedAt,
      status: job.status,
      exitCode: job.exitCode ?? null,
      log: job.log.slice(-80)
    }));
  }

  start(payload) {
    const title = String(payload.title || "").trim();
    const file = String(payload.file || "").trim();
    const repeat = payload.repeat !== "once";
    const destinations = Array.isArray(payload.destinations) ? payload.destinations : [];

    if (!title) throw new Error("Title is required.");
    if (!file) throw new Error("Video file is required.");
    if (!destinations.length) throw new Error("At least one destination is required.");

    const id = createId();
    const args = this.buildArgs(file, repeat, destinations);
    const child = spawn(this.config.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });

    const job = {
      id,
      title,
      file,
      repeat,
      destinations,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      child,
      log: [`Started ${title}`]
    };

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      job.log.push(...text.split(/\r?\n/).slice(-12));
      job.log = job.log.slice(-120);
    });

    child.on("exit", (code) => {
      job.status = code === 0 ? "ended" : "stopped";
      job.exitCode = code;
      job.log.push(`FFmpeg exited with code ${code}.`);
    });

    child.on("error", (error) => {
      job.status = "error";
      job.log.push(error.message);
    });

    this.jobs.set(id, job);
    return { id };
  }

  stop(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Stream not found.");
    if (job.status === "running") {
      job.status = "stopping";
      job.child.kill("SIGTERM");
    }
    return { ok: true };
  }

  buildArgs(file, repeat, destinations) {
    const args = [
      "-hide_banner",
      "-re"
    ];

    if (repeat) args.push("-stream_loop", "-1");

    args.push(
      "-i",
      file,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-f",
      "tee"
    );

    args.push(destinations.map((destination) => `[f=flv]${buildRtmpUrl(destination)}`).join("|"));
    return args;
  }
}

export function buildRtmpUrl(destination) {
  const platform = destination.platform || "rtmp";
  const serverUrl = String(destination.serverUrl || PLATFORM_SERVERS[platform] || "").trim().replace(/\/+$/g, "");
  const streamKey = String(destination.streamKey || "").trim();

  if (!streamKey) throw new Error("Stream key is required.");
  if (!serverUrl) throw new Error("Server URL is required for this destination.");
  return `${serverUrl}/${streamKey}`;
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
