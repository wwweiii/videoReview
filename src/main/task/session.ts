/**
 * 任务运行态：允许多个任务同时运行，每个任务独立持有取消控制器。
 *
 * 单独放在这里，供"任务执行"（runner/analysis/regions）与"任务管理"（manager）共享，
 * 避免互相 import 形成环。
 */

export interface ActiveRun {
  taskId: string
  abortController: AbortController
  cancelRequested: boolean
}

export const taskSession: { activeRuns: Map<string, ActiveRun> } = {
  activeRuns: new Map()
}
