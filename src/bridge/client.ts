/**
 * 桥接 UI 侧：唯一的网络出口。
 *
 * 与主线程的分工：
 *   ui.html ──http──▶ hub:3999
 *      │  ▲
 *   job│  │result     两个方向都走 pluginMessage
 *      ▼  │
 *   code.ts ──执行 op──▶ Figma 文档
 *
 * 关键约束：
 * 1. 不自动开始轮询。开关关着时零网络请求，导出性能不受影响。
 * 2. 导出进行中自动跳过请求（shouldPause），避免抢占主线程。
 * 3. 同一时刻只跑一个 job。主线程也用队列兜底，这里是第一道闸。
 */

/**
 * 必须用 localhost，不能用 127.0.0.1：
 * Figma 的 Manifest 校验拒绝 IP 字面量作为 allowedDomains，
 * 而且 localhost 还能覆盖 IPv6（::1）那条路径。
 */
const HUB = 'http://localhost:3999'

export type BridgeState = 'off' | 'connecting' | 'idle' | 'busy' | 'error'

export type BridgeStatus = {
  state: BridgeState
  detail: string
  calls: number
  lastOp: string | null
}

type Hooks = {
  post: (message: Record<string, unknown>) => void
  onChange: (status: BridgeStatus) => void
  /** 导出等重活进行中时返回 true，轮询会静默跳过 */
  shouldPause: () => boolean
}

const POLL_HOLD_MS = 20000
const MAX_BACKOFF_MS = 30000
const JOB_TIMEOUT_MS = 60000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const createBridgeClient = (hooks: Hooks) => {
  let enabled = false
  let running = false
  let inFlight = false
  let calls = 0
  let lastOp: string | null = null
  let failures = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let status: BridgeStatus = {
    state: 'off',
    detail: '未启用',
    calls: 0,
    lastOp: null,
  }

  const setStatus = (patch: Partial<BridgeStatus>) => {
    status = {...status, ...patch, calls, lastOp}
    hooks.onChange(status)
  }

  const post = async (path: string, body: unknown) => {
    const res = await fetch(HUB + path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    })
    return res
  }

  /** 主线程执行完 → 回传 hub，然后允许领下一个 */
  const finish = async (payload: {
    id: string
    ok: boolean
    result?: unknown
    error?: string
  }) => {
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }
    inFlight = false
    setStatus({
      state: enabled ? 'idle' : 'off',
      detail: payload.ok
        ? `${status.lastOp ?? ''} 完成`
        : String(payload.error),
    })
    await post('/result', payload).catch(() => undefined)
  }

  const runJob = (job: {id: string; op: string; args?: unknown}) => {
    inFlight = true
    calls += 1
    lastOp = job.op
    setStatus({state: 'busy', detail: job.op})
    hooks.post({type: 'bridge-job', job})

    // 主线程同步抛错时可能不回包，别让 inFlight 卡死整个轮询
    watchdog = setTimeout(() => {
      void finish({
        id: job.id,
        ok: false,
        error: `主线程 ${JOB_TIMEOUT_MS}ms 未响应`,
      })
    }, JOB_TIMEOUT_MS)
  }

  const loop = async () => {
    if (running) return
    running = true

    while (enabled) {
      if (inFlight || hooks.shouldPause()) {
        await sleep(250)
        continue
      }

      if (failures > 0) {
        await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)))
        if (!enabled) break
      }

      try {
        const res = await fetch(`${HUB}/next?wait=${POLL_HOLD_MS}`)
        if (!enabled) break

        failures = 0
        if (res.status === 204) {
          setStatus({state: 'idle', detail: '已连接 · 空闲'})
          continue
        }
        if (!res.ok) throw new Error(`hub ${res.status}`)

        const job = await res.json()
        if (!enabled) {
          // 关闭瞬间领到任务也要还回去，否则调用方会超时
          await post('/result', {
            id: job.id,
            ok: false,
            error: '插件已关闭桥接',
          }).catch(() => undefined)
          break
        }
        runJob(job)
      } catch (e) {
        failures += 1
        const detail = e instanceof Error ? e.message : String(e)
        setStatus({state: 'error', detail: `未连接 hub（${detail}）`})
        await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)))
      }
    }

    running = false
  }

  return {
    get status() {
      return status
    },
    get enabled() {
      return enabled
    },

    /** UI 收到主线程结果时转进来 */
    handleResult: (payload: {
      id: string
      ok: boolean
      result?: unknown
      error?: string
    }) => {
      void finish(payload)
    },

    start: () => {
      if (enabled) return
      enabled = true
      failures = 0
      setStatus({state: 'connecting', detail: '连接中…'})
      void loop()
    },

    stop: () => {
      if (!enabled) return
      enabled = false
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      inFlight = false
      setStatus({state: 'off', detail: '已关闭'})
    },

    toggle: () => {
      if (enabled) {
        return {enabled: false as const}
      }
      return {enabled: true as const}
    },
  }
}