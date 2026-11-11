/**
 * MCP hub 的队列状态机（插件主线程侧）。
 *
 * 为什么主线程要自己排队：
 * 插件必须串行修改文档。并发的 insertChild / group 会让父子关系错乱，
 * 而 agent 会并发发起调用，所以入口必须收敛成单通道。
 *
 * 这里只管「一次一个」，不碰 UI、不碰网络。
 */

export const createSerialQueue = () => {
  let tail = Promise.resolve()
  let depth = 0

  /**
   * 串行执行任务。前一个失败不影响后一个（各自独立结算）。
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const run = (task) => {
    depth += 1
    const start = tail.then(task, task)
    // 用 catch 兜住，避免一次失败把整条链变成 rejected
    tail = start.then(
      () => {
        depth -= 1
      },
      () => {
        depth -= 1
      },
    )
    return start
  }

  return {run, get depth() {
    return depth
  }}
}