/**
 * 桥接 op 注册表：op 名 → 执行函数。
 *
 * 与现有 Node Inspector 代码的关系：
 * - 读操作复用 code.ts 里已有的序列化能力时，走 ops 注入（见 bridge/index.ts）
 * - 这里只做「改文档」这类 Node Inspector 本身不需要的能力
 *
 * 一个 op 只做一件事；组合由 agent 侧串起来。
 */

import {planMove, planReorder} from './layer-order.mjs'

export type BridgeArgs = Record<string, unknown>

export type BridgeOp = (args: BridgeArgs) => Promise<unknown>

type SceneNodeLike = SceneNode

const fail = (message: string): never => {
  throw new Error(message)
}

const num = (args: BridgeArgs, key: string): number | undefined => {
  const raw = args[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

const str = (args: BridgeArgs, key: string): string | undefined => {
  const raw = args[key]
  return typeof raw === 'string' && raw ? raw : undefined
}

/** dynamic-page 下必须异步取节点 */
const getNode = async (id: string | undefined): Promise<SceneNodeLike> => {
  if (!id) return fail('缺少 nodeId')
  const node = await figma.getNodeByIdAsync(id)
  if (!node) return fail(`节点不存在: ${id}`)
  return node as SceneNode
}

const hasChildren = (node: SceneNode): node is SceneNode & ChildrenMixin =>
  'children' in node && Array.isArray((node as {children?: unknown}).children)

/**
 * 非当前页在 dynamic-page 模式下 children 为空，必须先加载。
 */
const ensurePageLoaded = async (page: BaseNode): Promise<void> => {
  if (page.type !== 'PAGE' || page === figma.currentPage) return
  const pageNode = page as PageNode
  if (typeof pageNode.loadAsync === 'function') await pageNode.loadAsync()
  else await figma.loadAllPagesAsync()
}

const clampIndex = (parent: ChildrenMixin, index: number): number =>
  Math.max(0, Math.min(index, parent.children.length))

/** 把新节点添加到容器末尾；容器信息不全时静默跳过 */
const appendTo = (parent: BaseNode | null, node: SceneNode): void => {
  if (!parent || !('children' in parent)) return
  const container = parent as unknown as ChildrenMixin
  container.insertChild(clampIndex(container, container.children.length), node)
}

/** 把 node 挪到父级的第 index 层（0=最底层） */
const moveTo = (
  parent: ChildrenMixin,
  nodeId: string,
  index: number,
): number => {
  const currentIds = parent.children.map((c) => c.id)
  const {desired} = planMove(currentIds, nodeId, index)
  for (const step of planReorder(currentIds, desired)) {
    const moving = parent.children.find((c) => c.id === step.id)
    if (moving) parent.insertChild(step.index, moving)
  }
  return parent.children.findIndex((c) => c.id === nodeId)
}

const toRgb = (hex: string): RGB => {
  const raw = hex.replace('#', '').trim()
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fail(`无法解析颜色: ${hex}`)
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  }
}

const toPaints = (value: unknown): Paint[] | undefined => {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => {
    if (typeof item === 'string') return {type: 'SOLID', color: toRgb(item)}
    return item as Paint
  })
}

const summarize = (node: SceneNode) => {
  const box = node.absoluteBoundingBox
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    box: box
      ? {x: box.x, y: box.y, width: box.width, height: box.height}
      : null,
    childCount: hasChildren(node) ? node.children.length : 0,
  }
}

const tree = (node: SceneNode, depth: number): Record<string, unknown> => {
  const item: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    box: summarize(node).box,
  }
  if (depth > 0 && hasChildren(node)) {
    item.children = node.children.map((c) => tree(c, depth - 1))
  }
  return item
}

const detail = (node: SceneNode): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    ...summarize(node),
    parentId: node.parent ? node.parent.id : null,
  }
  if ('visible' in node) base.visible = node.visible
  if ('locked' in node) base.locked = node.locked
  if ('opacity' in node) base.opacity = node.opacity
  if ('blendMode' in node) base.blendMode = node.blendMode
  if ('fills' in node) base.fills = node.fills
  if ('strokes' in node) base.strokes = node.strokes
  if ('cornerRadius' in node) {
    const radius = (node as unknown as {cornerRadius: unknown}).cornerRadius
    base.cornerRadius = radius
  }
  if ('layoutMode' in node) {
    const frame = node as FrameNode
    base.autoLayout = {
      layoutMode: frame.layoutMode,
      itemSpacing: frame.itemSpacing,
      padding: {
        top: frame.paddingTop,
        right: frame.paddingRight,
        bottom: frame.paddingBottom,
        left: frame.paddingLeft,
      },
      primaryAxisAlignItems: frame.primaryAxisAlignItems,
      counterAxisAlignItems: frame.counterAxisAlignItems,
    }
  }
  if (node.type === 'TEXT') {
    const text = node as TextNode
    base.text = {
      characters: text.characters,
      fontSize: text.fontSize,
      fontName: text.fontName,
    }
  }
  return base
}

export const createOps = () => {
  const ops: Record<string, BridgeOp> = {
    async getFileInfo() {
      return {
        fileName: figma.root.name,
        fileKey: figma.fileKey || null,
        currentPage: {id: figma.currentPage.id, name: figma.currentPage.name},
        pages: figma.root.children.map((p) => ({id: p.id, name: p.name})),
      }
    },

    async getSelection() {
      const nodes = figma.currentPage.selection
      return {count: nodes.length, nodes: nodes.map(summarize)}
    },

    async getPageTree(args) {
      const pageId = str(args, 'pageId')
      const page = pageId ? await getNode(pageId) : figma.currentPage
      await ensurePageLoaded(page)
      if (!hasChildren(page as SceneNode)) {
        return fail(`${page.type} 没有子节点`)
      }
      const depth = num(args, 'depth') ?? 1
      return {
        page: {id: page.id, name: page.name},
        children: (page as unknown as ChildrenMixin).children.map((c) =>
          tree(c, Math.max(0, depth)),
        ),
      }
    },

    async getNode(args) {
      const node = await getNode(str(args, 'nodeId'))
      const depth = num(args, 'depth') ?? 2
      return {
        ...detail(node),
        children: hasChildren(node)
          ? node.children.map((c) => tree(c, Math.max(0, depth - 1)))
          : [],
      }
    },

    async groupNodes(args) {
      const ids = (args.nodeIds as string[] | undefined) || []
      if (ids.length === 0) return fail('nodeIds 不能为空')
      const nodes = await Promise.all(ids.map((id) => getNode(id)))
      const parent = nodes[0].parent
      if (!parent) return fail('节点没有父级，无法分组')
      const wrong = nodes.find((n) => n.parent !== parent)
      if (wrong) {
        return fail(`节点 ${wrong.id} 与 ${nodes[0].id} 不在同一父级`)
      }

      // 组的落点应由原图层位置决定，而不是凭空置顶。
      // 注意用 id 定位：getNodeByIdAsync 返回的引用与 children 里的
      // 未必是同一对象，用 indexOf(node) 会拿到 -1，进而把 -1
      // 传给 figma.group 触发校验失败。
      const parentIds = (parent as ChildrenMixin).children.map((c) => c.id)
      const originalIndex = Math.min(
        ...ids.map((id) => {
          const at = parentIds.indexOf(id)
          return at < 0 ? parentIds.length : at
        }),
      )
      const group = figma.group(
        nodes,
        parent as BaseNode & ChildrenMixin,
        Math.max(0, originalIndex),
      )
      const name = str(args, 'name')
      if (name) group.name = name

      // 已经插在目标位置，只在显式给了 index 时才再挪
      const wanted = num(args, 'index')
      const placed =
        wanted === undefined
          ? originalIndex
          : moveTo(parent as ChildrenMixin, group.id, wanted)
      return {id: group.id, name: group.name, index: placed}
    },

    async ungroup(args) {
      const node = await getNode(str(args, 'nodeId'))
      const ungroupable = node as unknown as {ungroup?: () => SceneNode[]}
      if (typeof ungroupable.ungroup !== 'function') {
        return fail(`${node.type} 不支持解组`)
      }
      const released = ungroupable.ungroup()
      return {releasedIds: released.map((n) => n.id)}
    },

    async reorderNodes(args) {
      const position = str(args, 'position')
      const nodeId = str(args, 'nodeId')

      // 模式 A：单节点逐级移动
      if (position) {
        const node = await getNode(
          nodeId || ((args.nodeIds as string[] | undefined) || [])[0],
        )
        const parent = node.parent as ChildrenMixin | null
        if (!parent) return fail('根节点无法调整层级')

        const ids = parent.children.map((c) => c.id)
        const current = ids.indexOf(node.id)
        const last = ids.length - 1
        const targets: Record<string, number> = {
          front: last,
          back: 0,
          forward: Math.min(current + 1, last),
          backward: Math.max(current - 1, 0),
        }
        const target = targets[position]
        if (target === undefined) return fail(`未知 position: ${position}`)

        const placed = moveTo(parent, node.id, target)
        return {id: node.id, from: current, index: placed, total: ids.length}
      }

      // 模式 B：批量按给定顺序插入
      const ids = (args.nodeIds as string[] | undefined) || []
      if (ids.length === 0) {
        return fail('需要 nodeIds+index，或 nodeId+position')
      }
      const nodes = await Promise.all(ids.map((id) => getNode(id)))
      const parentId = str(args, 'parentId')
      const parent = parentId
        ? await getNode(parentId)
        : (nodes[0].parent as BaseNode | null)
      if (!parent || !('children' in parent)) {
        return fail('无法确定目标父级')
      }

      const container = parent as unknown as ChildrenMixin
      const base = num(args, 'index') ?? container.children.length
      const currentIds = container.children.map((c) => c.id)
      const desired = currentIds.filter((id) => !ids.includes(id))
      desired.splice(Math.min(base, desired.length), 0, ...ids)

      for (const step of planReorder(currentIds, desired)) {
        const moving = container.children.find((c) => c.id === step.id)
        if (moving) container.insertChild(step.index, moving)
      }

      return {
        parentId: parent.id,
        insertedFrom: base,
        order: container.children
          .slice(base, base + ids.length)
          .map((n) => n.id),
      }
    },

    async renameNode(args) {
      const node = await getNode(str(args, 'nodeId'))
      const name = str(args, 'name')
      if (!name) return fail('缺少 name')
      node.name = name
      return {id: node.id, name: node.name}
    },

    async moveNode(args) {
      const node = await getNode(str(args, 'nodeId'))
      const parentId = str(args, 'parentId')
      if (parentId) {
        const parent = await getNode(parentId)
        if (!('children' in parent)) return fail('目标不是容器节点')
        const container = parent as unknown as ChildrenMixin
        const index = clampIndex(container, container.children.length)
        container.insertChild(index, node)
      }
      // 必须在换父级之后再定位，否则相对坐标系会漂
      const x = num(args, 'x')
      const y = num(args, 'y')
      if (x !== undefined && 'x' in node) node.x = x
      if (y !== undefined && 'y' in node) node.y = y
      return detail(node)
    },

    async createFrame(args) {
      const frame = figma.createFrame()
      const name = str(args, 'name')
      if (name) frame.name = name
      frame.resize(num(args, 'width') ?? 100, num(args, 'height') ?? 100)

      const parentId = str(args, 'parentId')
      const parent = parentId
        ? await getNode(parentId)
        : (figma.currentPage as unknown as BaseNode)
      appendTo(parent, frame)
      const x = num(args, 'x')
      const y = num(args, 'y')
      if (x !== undefined) frame.x = x
      if (y !== undefined) frame.y = y

      const fill = args.fill
      if (fill !== undefined) {
        const paints = toPaints(fill)
        if (paints) frame.fills = paints
      }
      const layoutMode = str(args, 'layoutMode')
      if (layoutMode === 'HORIZONTAL' || layoutMode === 'VERTICAL') {
        frame.layoutMode = layoutMode
      }
      return summarize(frame)
    },

    async createRectangle(args) {
      const rect = figma.createRectangle()
      const name = str(args, 'name')
      if (name) rect.name = name
      rect.resize(num(args, 'width') ?? 100, num(args, 'height') ?? 100)

      const parentId = str(args, 'parentId')
      const parent = parentId
        ? await getNode(parentId)
        : (figma.currentPage as unknown as BaseNode)
      appendTo(parent, rect)
      const x = num(args, 'x')
      const y = num(args, 'y')
      if (x !== undefined) rect.x = x
      if (y !== undefined) rect.y = y

      const fill = args.fill
      if (fill !== undefined) {
        const paints = toPaints(fill)
        if (paints) rect.fills = paints
      }
      const cornerRadius = num(args, 'cornerRadius')
      if (cornerRadius !== undefined) rect.cornerRadius = cornerRadius
      return summarize(rect)
    },

    async createText(args) {
      const text = str(args, 'text')
      if (!text) return fail('缺少 text')
      const family = str(args, 'fontFamily') ?? 'Inter'
      const style = str(args, 'fontStyle') ?? 'Regular'
      const fontName = {family, style}
      await figma.loadFontAsync(fontName)

      const node = figma.createText()
      node.fontName = fontName
      node.fontSize = num(args, 'fontSize') ?? 14
      node.characters = text

      const parentId = str(args, 'parentId')
      const parent = parentId
        ? await getNode(parentId)
        : (figma.currentPage as unknown as BaseNode)
      appendTo(parent, node)
      const x = num(args, 'x')
      const y = num(args, 'y')
      if (x !== undefined) node.x = x
      if (y !== undefined) node.y = y

      const fill = args.fill
      if (fill !== undefined) {
        const paints = toPaints(fill)
        if (paints) node.fills = paints
      }
      return summarize(node)
    },

    async cloneNode(args) {
      const node = await getNode(str(args, 'nodeId'))
      const clone = node.clone()
      const parentId = str(args, 'parentId')
      if (parentId) {
        const parent = await getNode(parentId)
        if (!('children' in parent)) return fail('目标不是容器节点')
        appendTo(parent, clone)
      }
      const x = num(args, 'x')
      const y = num(args, 'y')
      if (x !== undefined) clone.x = x
      if (y !== undefined) clone.y = y
      return summarize(clone)
    },

    async setStyle(args) {
      const node = await getNode(str(args, 'nodeId'))

      if (args.fills !== undefined) {
        if (!('fills' in node)) return fail(`${node.type} 不支持 fills`)
        const paints = toPaints(args.fills)
        if (paints) node.fills = paints
      }
      if (args.strokes !== undefined) {
        if (!('strokes' in node)) return fail(`${node.type} 不支持 strokes`)
        const paints = toPaints(args.strokes)
        if (paints) node.strokes = paints
      }
      const strokeWeight = num(args, 'strokeWeight')
      if (strokeWeight !== undefined && 'strokeWeight' in node) {
        ;(node as unknown as {strokeWeight: number}).strokeWeight = strokeWeight
      }
      const cornerRadius = num(args, 'cornerRadius')
      if (cornerRadius !== undefined && 'cornerRadius' in node) {
        ;(node as unknown as {cornerRadius: number}).cornerRadius = cornerRadius
      }
      const opacity = num(args, 'opacity')
      if (opacity !== undefined && 'opacity' in node) {
        node.opacity = Math.min(1, Math.max(0, opacity))
      }
      const blendMode = str(args, 'blendMode')
      if (blendMode && 'blendMode' in node) {
        ;(node as unknown as {blendMode: string}).blendMode = blendMode
      }
      if (Array.isArray(args.effects) && 'effects' in node) {
        ;(node as unknown as {effects: Effect[]}).effects =
          args.effects as Effect[]
      }
      return detail(node)
    },

    async setLayout(args) {
      const node = await getNode(str(args, 'nodeId'))
      const width = num(args, 'width')
      const height = num(args, 'height')
      if (width !== undefined && height !== undefined && 'resize' in node) {
        node.resize(width, height)
      }

      const layoutMode = str(args, 'layoutMode')
      if (layoutMode && 'layoutMode' in node) {
        const frame = node as FrameNode
        if (
          layoutMode === 'NONE' ||
          layoutMode === 'HORIZONTAL' ||
          layoutMode === 'VERTICAL'
        ) {
          frame.layoutMode = layoutMode
        }
      }
      const padding = num(args, 'padding')
      if (padding !== undefined && 'paddingTop' in node) {
        const frame = node as FrameNode
        frame.paddingTop = padding
        frame.paddingRight = padding
        frame.paddingBottom = padding
        frame.paddingLeft = padding
      }
      const itemSpacing = num(args, 'itemSpacing')
      if (itemSpacing !== undefined && 'itemSpacing' in node) {
        ;(node as FrameNode).itemSpacing = itemSpacing
      }
      const primary = str(args, 'primaryAxisAlignItems')
      if (primary && 'primaryAxisAlignItems' in node) {
        ;(node as FrameNode).primaryAxisAlignItems =
          primary as FrameNode['primaryAxisAlignItems']
      }
      const counter = str(args, 'counterAxisAlignItems')
      if (counter && 'counterAxisAlignItems' in node) {
        ;(node as FrameNode).counterAxisAlignItems =
          counter as FrameNode['counterAxisAlignItems']
      }

      const x = num(args, 'x')
      const y = num(args, 'y')
      if (x !== undefined && 'x' in node) node.x = x
      if (y !== undefined && 'y' in node) node.y = y
      const rotation = num(args, 'rotation')
      if (rotation !== undefined && 'rotation' in node) {
        ;(node as unknown as {rotation: number}).rotation = rotation
      }
      return detail(node)
    },

    async setVisible(args) {
      const node = await getNode(str(args, 'nodeId'))
      node.visible = Boolean(args.visible)
      return {id: node.id, visible: node.visible}
    },

    async setLocked(args) {
      const node = await getNode(str(args, 'nodeId'))
      node.locked = Boolean(args.locked)
      return {id: node.id, locked: node.locked}
    },

    async setText(args) {
      const node = await getNode(str(args, 'nodeId'))
      if (node.type !== 'TEXT') return fail(`${node.type} 不是文本节点`)
      const text = str(args, 'text')
      if (text === undefined) return fail('缺少 text')
      const textNode = node as TextNode
      await figma.loadFontAsync(textNode.fontName as FontName)
      textNode.characters = text
      return {id: node.id, characters: textNode.characters}
    },

    async deleteNode(args) {
      const node = await getNode(str(args, 'nodeId'))
      const removed = summarize(node)
      node.remove()
      return {removed}
    },
  }

  return ops
}

export type OpsMap = ReturnType<typeof createOps>