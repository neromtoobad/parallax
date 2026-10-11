import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { env } from './env.ts';
import type { Job, JobEvent } from './types.ts';

const jobsDir = join(env.dataDir, 'jobs');
mkdirSync(jobsDir, { recursive: true });

const bus = new EventEmitter();
bus.setMaxListeners(200);
const cache = new Map<string, Job>();

export function saveJob(job: Job) {
  job.updatedAt = Date.now();
  if (job.status === 'running') job.lease = { pid: process.pid, host: hostname(), at: Date.now() };
  cache.set(job.id, job);
  const file = join(jobsDir, `${job.id}.json`);
  // Write then rename, so a crash mid-write never leaves a half-written checkpoint.
  writeFileSync(file + '.tmp', JSON.stringify(job, null, 2));
  renameSync(file + '.tmp', file);
  bus.emit('job', job);
}

export function getJob(id: string): Job | undefined {
  if (cache.has(id)) return cache.get(id);
  const file = join(jobsDir, `${id}.json`);
  if (!existsSync(file)) return undefined;
  const job = JSON.parse(readFileSync(file, 'utf8')) as Job;
  cache.set(id, job);
  return job;
}

export function listJobs(): Job[] {
  return readdirSync(jobsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => getJob(f.slice(0, -5)))
    .filter((j): j is Job => !!j)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function emit(job: Job, e: Omit<JobEvent, 'at' | 'seq'>) {
  const event: JobEvent = { ...e, at: Date.now(), seq: (job.eventCount = (job.eventCount ?? 0) + 1) };
  appendFileSync(join(jobsDir, `${job.id}.events.jsonl`), JSON.stringify(event) + '\n');
  bus.emit(`event:${job.id}`, event);
  return event;
}

export function readEvents(id: string): JobEvent[] {
  const file = join(jobsDir, `${id}.events.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function onEvent(id: string, fn: (e: JobEvent) => void) {
  bus.on(`event:${id}`, fn);
  return () => bus.off(`event:${id}`, fn);
}

export function onJob(fn: (j: Job) => void) {
  bus.on('job', fn);
  return () => bus.off('job', fn);
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Is another live process still working this job? */
export function leaseHeld(job: Job) {
  const l = job.lease;
  if (!l || l.pid === process.pid) return false;
  if (Date.now() - l.at > 5 * 60_000) return false; // no checkpoint for 5 minutes: treat as dead
  if (l.host !== hostname()) return true;
  try {
    process.kill(l.pid, 0);
    return true;
  } catch {
    return false;
  }
}
