/**
 * 桥接主线程。
 *
 * 职责边界：
 * - 只接收 ui.html 转发来的 {op, args}，执行后回 {ok, result}
 * - 不联网（插件主线程没有 fetch），网络全在 ui.html
 * - 不干扰 Node Inspector 现有流程：导出、inspect、选区同步都照旧
 *
 * 串行化：所有 op 进同一个队列，避免并发修改文档导致父子关系错乱。
 */

import {createOps} from './ops'
import {createSerialQueue} from './queue.mjs'

export type BridgeJob = {id: string; op: string; args?: Record<string, unknown>}

export type BridgeResult =
  | {id: string; ok: true; result: unknown}
  | {id: string; ok: false; error: string}

type BridgeHooks = {
  /** 会改动文档的 op，执行后需要让 Inspector 刷新当前树 */
  onDocumentChanged?: () => void
  /** 执行期间暂停其他重活（如导出） */
  onBusyChange?: (busy: boolean) => void
}

/** 只读 op：不改文档，不必触发重读 */
const READ_ONLY_OPS = new Set([
  'getFileInfo',
  'getSelection',
  'getPageTree',
  'getNode',
  'getNodeStyles',
  'getNodesStyles',
  'exportNodeImage',
  'exportNodeThumbnail',
  'exportNodeSlices',
  'exportNodesImages',
])

export const createBridge = (hooks: BridgeHooks = {}) => {
  const ops = createOps()
  const queue = createSerialQueue()

  const run = async (job: BridgeJob): Promise<BridgeResult> => {
    const handler = ops[job.op]
    if (!handler) {
      return {id: job.id, ok: false, error: `未知 op: ${job.op}`}
    }

    const mutating = !READ_ONLY_OPS.has(job.op)
    if (mutating) hooks.onBusyChange?.(true)

    try {
      const result = await handler(job.args || {})
      if (mutating) hooks.onDocumentChanged?.()
      return {id: job.id, ok: true, result: result ?? null}
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return {id: job.id, ok: false, error}
    } finally {
      if (mutating) hooks.onBusyChange?.(false)
    }
  }

  /**
   * 入队执行。返回 Promise，但调用方（消息处理）不需要 await，
   * 结果通过 onResult 回调推回 UI。
   */
  const enqueue = (
    job: BridgeJob,
    onResult: (payload: BridgeResult) => void,
  ): void => {
    void queue.run(() => run(job)).then(onResult)
  }

  return {enqueue, depth: () => queue.depth, opNames: Object.keys(ops)}
}