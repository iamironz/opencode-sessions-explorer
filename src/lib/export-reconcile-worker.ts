import { runExport } from "./export.js"

type WorkerRequest = {
  root: string
  batchSize?: number
}

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: unknown) => void
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  void reconcile(event.data)
}

async function reconcile(request: WorkerRequest): Promise<void> {
  try {
    const progress = await runExport({
      root: request.root,
      batchSize: request.batchSize ?? 2000,
      skipBackgroundReconcile: true,
    })
    scope.postMessage({ ok: true, progress })
  } catch (error) {
    scope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
