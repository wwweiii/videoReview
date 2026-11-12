/**
 * 任务运行态：同一时刻最多一个任务在跑。
 *
 * 单独放在这里，供"任务执行"（runner/analysis/regions）与"任务管理"（manager）共享，
 * 避免互相 import 形成环。
 */

export interface ActiveRun {
  taskId: string
  abortController: AbortController
  cancelRequested: boolean
}

export const taskSession: { activeRun: ActiveRun | null } = { activeRun: null }
