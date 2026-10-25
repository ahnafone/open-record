import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { artistOf, BASE_ARGS, durationOf, lastError, thumbnailOf, YTDLP_BIN, type YtDlpInfo } from './ytdlp';

export type DownloadStatus = 'queued' | 'downloading' | 'processing' | 'done' | 'failed';

export interface DownloadTrack {
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  durationSec?: number;
  artworkUrl?: string;
}

export interface DownloadJob {
  id: string;
  url: string;
  status: DownloadStatus;
  progress: number;
  error?: string;
  track?: DownloadTrack;
  /** Absolute path of the finished audio file (status 'done' only). */
  filePath?: string;
  createdAt: number;
  finishedAt?: number;
}

/** Public JSON shape of a job (GET /downloads/:id). */
export function jobView(job: DownloadJob): Pick<DownloadJob, 'id' | 'status' | 'progress' | 'error' | 'track'> {
  const view: Pick<DownloadJob, 'id' | 'status' | 'progress' | 'error' | 'track'> = {
    id: job.id,
    status: job.status,
    progress: job.progress,
  };
  if (job.error) view.error = job.error;
  if (job.track) view.track = job.track;
  return view;
}

/**
 * Optional hook run after yt-dlp finishes and before the job is marked done,
 * e.g. to embed better metadata/cover art. May update `job.track`. Throwing
 * fails the job.
 */
export type PostProcessHook = (job: DownloadJob, filePath: string, info: YtDlpInfo | null) => Promise<void> | void;

let postProcess: PostProcessHook = () => undefined;

/** Replaces the post-process hook (pass undefined to restore the no-op). */
export function setPostProcess(hook: PostProcessHook | undefined): void {
  postProcess = hook ?? (() => undefined);
}

export interface DownloadOptions {
  dataDir: string;
  concurrency: number;
  timeoutMs: number;
  ttlMs: number;
  maxPending: number;
}

type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string, fallback: number, min: number, max: number): number {
  const n = Number(env[key]?.trim() || NaN);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Download settings from env: DOWNLOAD_CONCURRENCY, DOWNLOAD_TIMEOUT_SEC, DOWNLOAD_TTL_HOURS. */
export function downloadOptionsFromEnv(dataDir: string, env: Env = process.env): DownloadOptions {
  return {
    dataDir,
    concurrency: intEnv(env, 'DOWNLOAD_CONCURRENCY', 2, 1, 16),
    timeoutMs: intEnv(env, 'DOWNLOAD_TIMEOUT_SEC', 900, 30, 6 * 3600) * 1000,
    ttlMs: intEnv(env, 'DOWNLOAD_TTL_HOURS', 24, 1, 24 * 30) * 3600_000,
    maxPending: 100,
  };
}

const PROGRESS_MARK = '__ORP__';
const POSTPROCESS_LINE = /^\[(ExtractAudio|Metadata|EmbedThumbnail|Fixup\w*|Merger|MoveFiles)\]/;
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.opus', '.ogg', '.oga', '.webm', '.flac', '.wav', '.aac', '.mp4']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** In-memory job store + yt-dlp worker pool. Files live in DATA_DIR/downloads/<id>/. */
export class DownloadManager {
  private readonly jobs = new Map<string, DownloadJob>();
  private readonly queue: string[] = [];
  private readonly running = new Map<string, ChildProcess>();
  private sweepTimer?: NodeJS.Timeout;
  readonly root: string;

  constructor(private readonly opts: DownloadOptions) {
    this.root = join(opts.dataDir, 'downloads');
  }

  /** Starts the periodic cleanup (first sweep removes orphans from a previous run). */
  start(intervalMs = 15 * 60_000): void {
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const child of this.running.values()) child.kill('SIGKILL');
  }

  get(id: string): DownloadJob | undefined {
    return UUID.test(id) ? this.jobs.get(id) : undefined;
  }

  /** Queues a download of an already-validated URL. Returns undefined when the queue is full. */
  create(url: string): DownloadJob | undefined {
    if (this.queue.length >= this.opts.maxPending) return undefined;
    const job: DownloadJob = { id: randomUUID(), url, status: 'queued', progress: 0, createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  private pump(): void {
    while (this.running.size < this.opts.concurrency && this.queue.length) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (job) void this.run(job);
    }
  }

  private finish(job: DownloadJob, error?: string): void {
    job.finishedAt = Date.now();
    if (error) {
      job.status = 'failed';
      job.error = error;
    } else {
      job.status = 'done';
      job.progress = 100;
    }
  }

  private async run(job: DownloadJob): Promise<void> {
    const dir = join(this.root, job.id);
    job.status = 'downloading';
    try {
      await mkdir(dir, { recursive: true });
      await this.spawnYtDlp(job, dir);
      const filePath = await findAudio(dir);
      if (!filePath) throw new Error('no audio file was produced');
      const info = await readInfo(dir);
      job.track = info ? trackFromInfo(info) : undefined;
      job.status = 'processing';
      await postProcess(job, filePath, info);
      job.filePath = filePath;
      this.finish(job);
    } catch (err) {
      this.finish(job, err instanceof Error ? err.message : 'download failed');
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      this.running.delete(job.id);
      this.pump();
    }
  }

  private spawnYtDlp(job: DownloadJob, dir: string): Promise<void> {
    const args = [
      ...BASE_ARGS,
      '--no-playlist',
      '--newline',
      '--no-mtime',
      '--no-part',
      '--match-filter',
      '!is_live',
      '--max-filesize',
      '500M',
      '-f',
      'bestaudio[ext=m4a]/bestaudio/best',
      '-x',
      '--audio-format',
      'm4a',
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '--write-info-json',
      '--progress-template',
      `download:${PROGRESS_MARK}%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s`,
      '-o',
      join(dir, 'audio.%(ext)s'),
      '--',
      job.url,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(YTDLP_BIN, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.running.set(job.id, child);
      let stderr = '';
      let buffered = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.opts.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n|\r/);
        buffered = lines.pop() ?? '';
        for (const line of lines) handleLine(job, line);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new Error(err.code === 'ENOENT' ? 'yt-dlp is not installed on the server' : 'could not start yt-dlp'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('download timed out'));
        if (code !== 0) return reject(new Error(lastError(stderr) ?? `yt-dlp exited with code ${code}`));
        resolve();
      });
    });
  }

  /** Removes expired jobs and their files, plus directories no job owns. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt > this.opts.ttlMs) {
        this.jobs.delete(id);
        await rm(join(this.root, id), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    for (const name of entries) {
      if (UUID.test(name) && !this.jobs.has(name)) {
        await rm(join(this.root, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

/** Applies one stdout line from yt-dlp to the job's status/progress. */
export function handleLine(job: DownloadJob, line: string): void {
  const at = line.indexOf(PROGRESS_MARK);
  if (at >= 0) {
    const [done, total, estimate] = line
      .slice(at + PROGRESS_MARK.length)
      .trim()
      .split(/\s+/)
      .map(Number);
    const size = Number.isFinite(total) && total > 0 ? total : estimate;
    if (Number.isFinite(done) && Number.isFinite(size) && size > 0) {
      // Keep 100 for "done"; post-processing still has to run.
      job.progress = Math.max(job.progress, Math.min(99, Math.floor((done / size) * 100)));
    }
    return;
  }
  if (POSTPROCESS_LINE.test(line) && job.status === 'downloading') job.status = 'processing';
}

async function findAudio(dir: string): Promise<string | undefined> {
  const files = await readdir(dir);
  const audio = files.filter((f) => f.startsWith('audio.') && AUDIO_EXTS.has(extname(f).toLowerCase()));
  // Prefer the m4a yt-dlp converted to.
  const pick = audio.find((f) => f.endsWith('.m4a')) ?? audio[0];
  if (!pick) return undefined;
  const path = join(dir, pick);
  return (await stat(path)).size > 0 ? path : undefined;
}

async function readInfo(dir: string): Promise<YtDlpInfo | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'audio.info.json'), 'utf8')) as YtDlpInfo;
  } catch {
    return null;
  }
}

/** Track tags from a yt-dlp info dict. */
export function trackFromInfo(info: YtDlpInfo): DownloadTrack {
  const track: DownloadTrack = {
    title: info.track?.trim() || info.title?.trim() || 'Unknown title',
    artist: artistOf(info) || 'Unknown artist',
  };
  if (info.album?.trim()) track.album = info.album.trim();
  const year = info.release_year ?? Number(info.upload_date?.slice(0, 4));
  if (Number.isInteger(year) && year > 1000) track.year = year;
  const genre = info.genre?.trim() || info.genres?.[0]?.trim();
  if (genre) track.genre = genre;
  const durationSec = durationOf(info);
  if (durationSec !== undefined) track.durationSec = durationSec;
  const artworkUrl = thumbnailOf(info);
  if (artworkUrl) track.artworkUrl = artworkUrl;
  return track;
}
