/**
 * 为 layout 写入归一化坐标（不改 x/y 旧语义）：
 * - parentX/parentY：始终相对直接父盒，可直接当 CSS left/top
 * - rootX/rootY：相对选区根节点原点（根为 0,0）
 * GROUP / BOOLEAN 未烘焙子层会按父原点换算；已烘焙则 x/y 已是父盒偏移。
 */

const FLAT_COORD_TYPES = new Set(['GROUP', 'BOOLEAN_OPERATION'])

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * 由 Figma 本地 x/y 换算成相对直接父盒的 left/top。
 * 仅 attach 时使用；生成侧优先读已写入的 parentX/parentY。
 */
export function parentOffsetFromLegacyXY(node, parent) {
  const x = node.layout?.x ?? 0
  const y = node.layout?.y ?? 0
  if (parent && FLAT_COORD_TYPES.has(parent.type)) {
    const alreadyParentRelative = !!(
      node.layout?.bakedVisual ||
      node.flattened ||
      node.png ||
      node.pngRef
    )
    if (alreadyParentRelative) return {left: x, top: y}
    return {
      left: x - (parent.layout?.x ?? 0),
      top: y - (parent.layout?.y ?? 0),
    }
  }
  return {left: x, top: y}
}

/**
 * 子节点在父盒内的 left/top。
 * 有 parentX/parentY 时直接用（语义统一，不必再减父）；
 * 否则回退到 x/y 的 GROUP / baked 换算。
 */
export function localOffsetInParent(node, parent) {
  const px = node.layout?.parentX
  const py = node.layout?.parentY
  if (isFiniteNumber(px) && isFiniteNumber(py)) {
    return {left: px, top: py}
  }
  return parentOffsetFromLegacyXY(node, parent)
}

function visit(node, parent, originX, originY) {
  if (!node) return
  if (!node.layout) {
    node.layout = {x: 0, y: 0, width: 0, height: 0}
  }

  const {left, top} = parent
    ? parentOffsetFromLegacyXY(node, parent)
    : {left: 0, top: 0}
  const x = originX + left
  const y = originY + top

  node.layout.parentX = left
  node.layout.parentY = top
  node.layout.rootX = x
  node.layout.rootY = y

  for (const child of node.children || []) {
    visit(child, node, x, y)
  }
}

/** 为一棵选区根树写入 parentX/Y 与 rootX/Y；根自身均为 0,0 */
export function attachRootRelativeCoords(root) {
  if (!root) return root
  visit(root, null, 0, 0)
  return root
}

export function attachRootRelativeCoordsToNodes(nodes) {
  for (const root of nodes || []) {
    attachRootRelativeCoords(root)
  }
  return nodes
}

export function attachRootRelativeCoordsToData(data) {
  if (data?.nodes) attachRootRelativeCoordsToNodes(data.nodes)
  return data
}
