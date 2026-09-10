/**
 * 识别 Figma 导出 JSON 中的重复列表项。
 * 策略：结构指纹（忽略文本内容、TEXT 动态宽高）+ 语义槽位归一。
 */

const MIN_ITEMS = 2
const MATCH_RATIO = 0.75

/** GROUP 仅包一层时视为内层 FRAME */
export function normalizeListItem(node) {
  if (!node) return null
  if (node.type === 'GROUP' && node.children?.length === 1) {
    return node.children[0]
  }
  return node
}

/** 折叠仅作透传的单子 FRAME */
export function collapsePassThrough(node) {
  const base = normalizeListItem(node)
  if (!base?.children?.length) return base

  const children = base.children.map(collapsePassThrough)
  const isPassThrough =
    base.type === 'FRAME' &&
    children.length === 1 &&
    !base.layout?.layoutMode &&
    !base.styles?.fills?.length &&
    !base.clipsContent

  return isPassThrough ? children[0] : {...base, children}
}

function textSlot(text) {
  const t = text?.styles?.text || {}
  if (t.textTruncation === 'ENDING') return 'title'
  const chars = t.characters || ''
  if (/^x\d+$/i.test(chars.trim())) return 'badge'
  if (/sold\s*out/i.test(chars)) return 'action-label'
  if (t.fontSize && t.fontSize >= 10 && /^\d+$/.test(chars.trim())) {
    return 'price'
  }
  return 'text'
}

function isActionSlot(childFps) {
  return childFps.some((fp) =>
    ['T:price', 'T:action-label', 'I:currency', 'SLOT:action'].includes(fp),
  )
}

/** 粗粒度结构指纹：同类卡片归为一组（忽略文案、动态宽高、按钮包裹层差异） */
export function coarseFingerprint(node) {
  const n = collapsePassThrough(node)
  if (!n) return ''

  if (n.type === 'TEXT') return `T:${textSlot(n)}`

  if (n.type === 'INSTANCE') return 'I:currency'

  const childFps = (n.children || []).map(coarseFingerprint)

  if (n.type === 'FRAME' && isActionSlot(childFps)) {
    const nestedAction = childFps.length === 1 && childFps[0] === 'SLOT:action'
    const flatAction = childFps.every((fp) =>
      /^(T:(price|action-label)|I:currency|SLOT:action)$/.test(fp),
    )
    if (nestedAction || flatAction) return 'SLOT:action'
  }

  if (childFps.length === 1 && childFps[0] === 'SLOT:action') {
    return 'SLOT:action'
  }

  const lm = n.layout?.layoutMode || '_'
  return `${n.type}[${lm}](${childFps.join('|')})`
}

function mode(values) {
  const counts = new Map()
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1)
  }
  let best = ''
  let max = 0
  for (const [v, c] of counts) {
    if (c > max) {
      max = c
      best = v
    }
  }
  return best
}

/** 从列表项提取可变数据 */
export function extractListItemData(node) {
  const data = {
    title: null,
    quantity: null,
    price: null,
    currency: null,
    soldOut: false,
  }

  const walk = (n) => {
    if (!n) return
    if (n.type === 'TEXT') {
      const chars = n.styles?.text?.characters || ''
      const slot = textSlot(n)
      if (slot === 'title') data.title = chars
      if (slot === 'badge') data.quantity = chars
      if (slot === 'price') data.price = chars
      if (slot === 'action-label') {
        data.soldOut = /sold\s*out/i.test(chars)
      }
    }
    if (n.type === 'INSTANCE' && n.component?.mainComponentName) {
      data.currency = n.component.mainComponentName
    }
    for (const c of n.children || []) walk(c)
  }

  walk(normalizeListItem(node))
  return data
}

/**
 * 检测单个容器是否为列表。
 * @returns {null | {
 *   containerId: string,
 *   containerName: string,
 *   fingerprint: string,
 *   itemCount: number,
 *   items: Array<{id: string, name: string, index: number, data: object}>,
 *   templateId: string,
 *   variants: Record<string, number>,
 * }}
 */
export function detectListOnNode(node, options = {}) {
  const minItems = options.minItems ?? MIN_ITEMS
  const ratio = options.matchRatio ?? MATCH_RATIO
  const children = (node.children || []).filter((c) => c.visible !== false)

  if (children.length < minItems) return null

  const normalized = children.map(normalizeListItem)
  const fingerprints = normalized.map(coarseFingerprint)
  const dominant = mode(fingerprints)
  if (!dominant) return null

  const matched = fingerprints
    .map((fp, index) => ({fp, index}))
    .filter(({fp}) => fp === dominant)

  if (matched.length / children.length < ratio) return null

  const variantCounts = {}
  for (const fp of fingerprints) {
    variantCounts[fp] = (variantCounts[fp] || 0) + 1
  }

  const templateIndex = matched[0].index
  const template = normalized[templateIndex]

  return {
    containerId: node.id,
    containerName: node.name,
    fingerprint: dominant,
    itemCount: matched.length,
    templateId: template.id,
    templateName: template.name,
    variants: variantCounts,
    items: matched.map(({index}) => ({
      id: children[index].id,
      name: children[index].name,
      index,
      data: extractListItemData(children[index]),
    })),
  }
}

/** 递归扫描整棵树，返回所有识别到的列表 */
export function detectLists(root, options = {}) {
  const lists = []

  const walk = (node) => {
    const list = detectListOnNode(node, options)
    if (list) lists.push(list)

    for (const child of node.children || []) {
      if (child.visible === false) continue
      walk(child)
    }
  }

  walk(root)
  return lists
}

/** nodeId → 所属列表元数据（含 template 节点引用） */
export function buildListIndex(root, options = {}) {
  const lists = detectLists(root, options)
  const byItemId = new Map()
  const byContainerId = new Map()

  const nodeById = new Map()
  const walk = (node) => {
    nodeById.set(node.id, node)
    for (const c of node.children || []) {
      if (c.visible === false) continue
      walk(c)
    }
  }
  walk(root)

  for (const list of lists) {
    const template = nodeById.get(list.templateId)
    byContainerId.set(list.containerId, {...list, template})

    for (const item of list.items) {
      byItemId.set(item.id, {
        list,
        template,
        itemIndex: item.index,
        data: item.data,
      })
    }
  }

  return {lists, byItemId, byContainerId, nodeById}
}

/** 遍历列表项子树，为节点标注语义槽位 */
export function annotateSlots(node, slots = {}) {
  const walk = (raw) => {
    const n = collapsePassThrough(raw)
    if (!n) return

    if (n.type === 'TEXT') {
      slots[n.id] = textSlot(n)
      return
    }

    if (n.type === 'INSTANCE') {
      slots[n.id] = 'currency'
      return
    }

    if (n.type === 'FRAME' && n.layout?.layoutMode === 'HORIZONTAL') {
      const childRoles = (n.children || []).map((c) => {
        if (c.type === 'TEXT') return textSlot(c)
        if (c.type === 'INSTANCE') return 'currency'
        return null
      })
      const isButton =
        childRoles.includes('currency') || childRoles.includes('action-label')
      if (isButton) slots[n.id] = 'action'
    }

    if (
      n.type === 'FRAME' &&
      n.layout?.layoutPositioning === 'ABSOLUTE' &&
      (n.children || []).some(
        (c) => c.type === 'TEXT' && textSlot(c) === 'badge',
      )
    ) {
      slots[n.id] = 'badge'
    }

    for (const child of n.children || []) walk(child)
  }

  walk(node)
  return slots
}

/**
 * 在导出 JSON 顶层附加 lists 元数据（不改 nodes 树与样式）。
 * @param {object} data
 * @returns {object}
 */
export function attachListsToData(data, options = {}) {
  if (!data || typeof data !== 'object') return data
  const root = data.nodes?.[0]
  if (!root) {
    return {...data, lists: [], listCount: 0}
  }

  const lists = detectLists(root, options).map((list) => ({
    ...list,
    items: list.items.map((item) => ({
      ...item,
      slots: annotateSlots(findNodeById(root, item.id)),
    })),
  }))

  return {
    ...data,
    lists,
    listCount: lists.length,
  }
}

function findNodeById(root, id) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (node.id === id) {
      found = node
      return
    }
    for (const child of node.children || []) walk(child)
  }
  walk(root)
  return found
}
