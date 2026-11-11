/**
 * 层级重排纯逻辑。
 *
 * 不依赖 figma 全局：把「目标顺序」和「当前顺序」都当数组算，
 * 再输出 [{index, id}] 指令交给调用方执行。
 * 这样最容易出错的索引计算可以单测（scripts/test-bridge.mjs）。
 */

/**
 * 计算把 node 移到 index（0=最底层）后的目标顺序。
 * @param {string[]} currentIds 父级当前子节点 id，按底→顶
 * @param {string} nodeId 要移动的节点
 * @param {number} index 目标层
 */
export const planMove = (currentIds, nodeId, index) => {
  const rest = currentIds.filter((id) => id !== nodeId)
  const target = Math.max(0, Math.min(index, rest.length))
  const desired = [...rest]
  desired.splice(target, 0, nodeId)
  return {desired, target}
}

/**
 * 从当前顺序重排到目标顺序，生成指令序列。
 *
 * 从底层往上逐位校正：处理第 i 位时，desired[i] 一定还在 i 之后，
 * 因此 insertChild(i, x) 的索引语义无歧义。
 *
 * desired 允许包含「还不在 current 里的节点」（跨父级搬入）：
 * 它们按插入处理，insertChild 会同时完成 reparent。
 */
export const planReorder = (currentIds, desiredIds) => {
  const ops = []
  const working = [...currentIds]

  for (let i = 0; i < desiredIds.length; i += 1) {
    if (working[i] === desiredIds[i]) continue

    const from = working.indexOf(desiredIds[i])
    if (from >= 0) working.splice(from, 1)
    working.splice(i, 0, desiredIds[i])
    ops.push({index: i, id: desiredIds[i]})
  }

  return ops
}

/** 校验重排结果：没有多出、也没有丢失节点 */
export const assertPermutation = (before, after) => {
  const extra = after.filter((id) => !before.includes(id))
  const missing = before.filter((id) => !after.includes(id))
  return extra.length === 0 && missing.length === 0
}