import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

export type BackgroundReconcileSchedule = {
  scheduled: boolean
  reason?: string
}

type WorkerRequest = {
  root: string
  batchSize: number
}

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000

let inFlight = false
let lastStartedAt = 0

export function scheduleBackgroundReconcile(opts: {
  root: string
  minIntervalMs?: number
  batchSize?: number
}): BackgroundReconcileSchedule {
  const now = Date.now()
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  if (inFlight) return { scheduled: false, reason: "already_running" }
  if (now - lastStartedAt < minIntervalMs) return { scheduled: false, reason: "throttled" }

  const url = resolveWorkerUrl()
  try {
    const worker = new Worker(url, { type: "module" })
    inFlight = true
    lastStartedAt = now
    const cleanup = () => {
      inFlight = false
      worker.terminate()
    }
    worker.addEventListener("message", cleanup, { once: true })
    worker.addEventListener("error", cleanup, { once: true })
    const maybeUnref = worker as Worker & { unref?: () => void }
    maybeUnref.unref?.()
    const request: WorkerRequest = { root: opts.root, batchSize: opts.batchSize ?? 2000 }
    worker.postMessage(request)
    return { scheduled: true }
  } catch {
    inFlight = false
    return { scheduled: false, reason: "worker_unavailable" }
  }
}

function resolveWorkerUrl(): URL {
  const js = new URL("./export-reconcile-worker.js", import.meta.url)
  if (existsSync(fileURLToPath(js))) return js
  const ts = new URL("./export-reconcile-worker.ts", import.meta.url)
  if (existsSync(fileURLToPath(ts))) return ts
  const bundled = new URL("./lib/export-reconcile-worker.js", import.meta.url)
  if (existsSync(fileURLToPath(bundled))) return bundled
  return js
}

export function _resetBackgroundReconcileForTest(): void {
  inFlight = false
  lastStartedAt = 0
}
