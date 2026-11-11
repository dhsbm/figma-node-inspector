/**
 * Hub 状态机：任务队列 + 在途请求。
 *
 * 刻意不含任何 HTTP 代码，传输层（http.mjs）只做协议编解码。
 * 这样队列语义（入队、认领、结算、超时）可以独立验证。
 */

import {randomUUID} from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 60_000

export const createCore = ({timeoutMs = DEFAULT_TIMEOUT_MS} = {}) => {
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const inflight = new Map()
  /** @type {Array<{id: string, op: string, args: object}>} */
  const queue = []
  /** @type {Array<Function>} 空队列时挂起的 waiters，收到任务后被唤醒 */
  const waiters = []

  const stats = {enqueued: 0, settled: 0, dropped: 0}

  const notifyWaiters = () => {
    if (queue.length === 0) return
    const waiter = waiters.shift()
    if (!waiter) return
    clearTimeout(waiter.timer)
    waiter.resolve(queue.shift())
  }

  /**
   * 入队并等待结果。
   * 超时会同时清理队列与在途表，避免任务被插件领走后无人接收。
   */
  const call = (op, args = {}, {timeout = timeoutMs} = {}) =>
    new Promise((resolve, reject) => {
      const id = randomUUID()

      const timer = setTimeout(() => {
        inflight.delete(id)
        const idx = queue.findIndex((j) => j.id === id)
        if (idx >= 0) {
          queue.splice(idx, 1)
          stats.dropped += 1
        }
        reject(
          new Error(
            `超时 ${timeout}ms：插件未响应。` +
              '确认 Figma 里 Node Inspector 已打开，且 hub 端口一致',
          ),
        )
      }, timeout)

      inflight.set(id, {resolve, reject, timer})
      queue.push({id, op, args})
      stats.enqueued += 1
      notifyWaiters()
    })

  /**
   * 认领一个任务，最多等 waitMs。
   * 超时必须把 waiter 移除，否则它会在下一次 call 时取走任务却无人接收
   * （静默丢单）。
   */
  const next = (waitMs) => {
    if (queue.length > 0) return Promise.resolve(queue.shift())

    return new Promise((resolve) => {
      const waiter = {resolve, timer: null}

      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        resolve(null)
      }, waitMs)

      waiters.push(waiter)
    })
  }

  /** 插件回传结果。未知 id 返回 false，让 transport 报 404。 */
  const settle = ({id, ok, result, error}) => {
    const entry = inflight.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    inflight.delete(id)
    stats.settled += 1
    if (ok) entry.resolve(result === undefined ? null : result)
    else entry.reject(new Error(error || '插件执行失败'))
    return true
  }

  const status = () => ({
    pluginConnected: waiters.length > 0,
    queueLength: queue.length,
    inflightCount: inflight.size,
    ...stats,
  })

  /** 关停时清空等待者，避免进程挂住 */
  const shutdown = () => {
    for (const entry of inflight.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('hub 已关闭'))
    }
    inflight.clear()
    queue.length = 0
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
  }

  return {call, next, settle, status, shutdown}
}