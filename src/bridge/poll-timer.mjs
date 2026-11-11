/**
 * 轮询节奏控制。
 *
 * 触发暂停的条件刻意单一：`shouldPause()` 为真时不发请求。
 * 这样「导出进行中别打扰」只是一条策略，而不是散落在各处的 if。
 */
export const createPollTimer = ({
  holdMs = 20000,
  maxBackoffMs = 30000,
  shouldPause = () => false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) => {
  let failures = 0
  let stopped = false

  const backoff = () =>
    Math.min(maxBackoffMs, 1000 * 2 ** Math.min(failures, 5))

  /** 等待下一轮：被暂停时保持轮询检查，但不发请求 */
  const wait = async () => {
    if (failures > 0) await sleep(backoff())
    while (!stopped && shouldPause()) await sleep(500)
  }

  return {
    get failures() {
      return failures
    },
    get stopped() {
      return stopped
    },
    holdMs,
    recordSuccess: () => {
      failures = 0
    },
    recordFailure: () => {
      failures += 1
    },
    wait,
    stop: () => {
      stopped = true
    },
  }
}