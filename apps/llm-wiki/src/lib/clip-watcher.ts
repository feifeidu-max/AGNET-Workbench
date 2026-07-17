import { useWikiStore } from "@/stores/wiki-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, triggers auto-ingest and refreshes the file tree.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running

  intervalId = setInterval(async () => {
    try {
      const res = await fetch("http://127.0.0.1:19827/clips/pending", { method: "GET" })
      const data = await res.json()

      if (!data.ok || !data.clips || data.clips.length === 0) return

      const store = useWikiStore.getState()
      const project = store.project

      for (const clip of data.clips) {
        const clipProjectPath: string = clip.projectPath
        const draftId: string | undefined = clip.draftId

        // Refresh file tree if clip is for current project
        if (project && clipProjectPath === project.path) {
          await refreshProjectFileTree(project.path, { projectId: project.id })

          // Current clip-server versions submit directly to the strict draft
          // gate. Do not enqueue the proposed page as a trusted raw source.
          if (draftId) continue

          const clipFilePath: string = clip.filePath

          // Enqueue (not auto-ingest directly) so the task lands in the
          // persisted queue, shows up in the activity panel, and survives
          // a UI refresh. Same path used by file imports from sources-view.
          // Pass the project's stable UUID — the queue looks up the
          // current filesystem path from the registry at run time.
          console.warn(
            "Ignored legacy Web Clipper payload without a strict draft id",
            clipFilePath,
          )
        }
      }
    } catch {
      // Server not running or network error — silently ignore
    }
  }, POLL_INTERVAL)
}

export function stopClipWatcher() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
