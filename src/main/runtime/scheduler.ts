import { AsyncLocalStorage } from 'node:async_hooks'

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort: () => void
}

/** 按任务轮转，重试重新排队；等待许可不消耗网络超时预算。 */
export class FairScheduler {
  private queues = new Map<string, Waiter[]>()
  private order: string[] = []
  private active = 0
  private lastKey = ''
  private peak = 0

  constructor(private limit: number) {}

  setLimit(value: number): void {
    this.limit = Math.max(1, Math.floor(value) || 1)
    this.pump()
  }

  snapshot(): { active: number; queued: number; limit: number; peak: number } {
    return { active: this.active, queued: [...this.queues.values()].reduce((n, q) => n + q.length, 0), limit: this.limit, peak: this.peak }
  }

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('操作已取消'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        const queue = this.queues.get(key)
        if (!queue) return
        const index = queue.indexOf(waiter)
        if (index < 0) return
        queue.splice(index, 1)
        if (!queue.length) this.removeKey(key)
        signal?.removeEventListener('abort', waiter.abort)
        reject(new Error('操作已取消'))
        this.pump()
      } }
      if (!this.queues.has(key)) {
        this.queues.set(key, [])
        this.order.push(key)
      }
      this.queues.get(key)!.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this.pump()
    })
  }

  async run<T>(key: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key, signal)
    try {
      if (signal?.aborted) throw new Error('操作已取消')
      return await work()
    } finally { release() }
  }

  private removeKey(key: string): void {
    this.queues.delete(key)
    this.order = this.order.filter((item) => item !== key)
  }

  private pump(): void {
    while (this.active < this.limit && this.order.length) {
      if (this.order.length > 1 && this.order[0] === this.lastKey) this.order.push(this.order.shift()!)
      const key = this.order.shift()!
      const queue = this.queues.get(key)!
      const waiter = queue.shift()!
      if (queue.length) this.order.push(key)
      else this.queues.delete(key)
      waiter.signal?.removeEventListener('abort', waiter.abort)
      this.lastKey = key
      this.active++
      this.peak = Math.max(this.peak, this.active)
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active--
        this.pump()
      })
    }
  }
}

const taskContext = new AsyncLocalStorage<string>()
export const withTaskContext = <T>(taskId: string, work: () => T): T => taskContext.run(taskId, work)
export const schedulingKey = (): string => taskContext.getStore() ?? 'interactive'
export const modelScheduler = new FairScheduler(2)
export const extractionScheduler = new FairScheduler(1)
export const imageScheduler = new FairScheduler(2)
