/**
 * 桥接用的样式读取。
 *
 * Paint / Effect 的序列化统一来自 src/shared/paint.ts，
 * 与插件导出 HTML/JSON 用的是同一份实现 —— 两边不会分叉。
 *
 * 本文件只负责"从节点读出样式"这一层编排：
 * 哪些字段存在、四角半径怎么取、样式库名字怎么解析、逐段字体怎么拆。
 *
 * 与导出流程的差异（刻意的）：
 * - 不做 PNG 烘焙 / SVG 导出：那些会改文档状态且极慢
 * - 只返回样式本身，不产资源
 */

import {rgbaToHex, serializeEffect, serializePaint} from '../shared/paint'

/** 样式库 / 字体样式名：失败时返回 undefined，不让一个坏引用拖垮整次读取 */
const safeStyleName = async (
  id: string,
): Promise<string | undefined> => {
  if (!id) return undefined
  try {
    const style = await figma.getStyleByIdAsync(id)
    return style ? style.name : undefined
  } catch {
    return undefined
  }
}

const serializeTextStyle = (node: TextNode): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const pick = <K extends keyof TextNode>(key: K): void => {
    const v = node[key]
    if (v !== figma.mixed) out[key as string] = v
    else out[key as string] = 'mixed'
  }
  pick('fontSize')
  pick('fontName')
  pick('fontWeight')
  pick('lineHeight')
  pick('letterSpacing')
  pick('textAlignHorizontal')
  pick('textAlignVertical')
  pick('textCase')
  pick('textDecoration')
  out.characters = node.characters
  out.textAutoResize = node.textAutoResize

  // 逐段字体：混排节点里每种字体都可能不同，整段字体名看不出这点
  try {
    const segments = node.getStyledTextSegments([
      'fontName',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'fills',
    ])
    out.segments = segments.map((s) => ({
      characters: s.characters,
      start: s.start,
      end: s.end,
      fontName: s.fontName,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      fills: (s.fills as readonly Paint[])
        .filter((p) => p.visible !== false)
        .map((p) => (p.type === 'SOLID' ? rgbaToHex(p.color, p.opacity ?? 1) : p.type)),
    }))
  } catch {
    // 部分节点（如缺失字体）不支持分段读取，忽略即可
  }
  return out
}

/**
 * 读取一个节点的完整样式。
 * 纯读：不修改文档，不导出像素，所以可以放心高频调用。
 */
export const readNodeStyles = async (
  node: SceneNode,
): Promise<Record<string, unknown>> => {
  const styles: Record<string, unknown> = {}

  if ('fills' in node && node.fills !== figma.mixed) {
    styles.fills = (node.fills as readonly Paint[]).map(serializePaint)
  }
  if ('strokes' in node) {
    styles.strokes = (node.strokes as readonly Paint[]).map(serializePaint)
  }

  // strokeWeight 可能是 mixed（四边不同），此时导出四边值
  if ('strokeWeight' in node) {
    if (node.strokeWeight === figma.mixed) {
      const sides = node as SceneNode & {
        strokeTopWeight?: number
        strokeRightWeight?: number
        strokeBottomWeight?: number
        strokeLeftWeight?: number
      }
      styles.strokeWeight = 'mixed'
      styles.strokeTopWeight = sides.strokeTopWeight
      styles.strokeRightWeight = sides.strokeRightWeight
      styles.strokeBottomWeight = sides.strokeBottomWeight
      styles.strokeLeftWeight = sides.strokeLeftWeight
    } else {
      styles.strokeWeight = node.strokeWeight
    }
  }
  if ('strokeAlign' in node) styles.strokeAlign = node.strokeAlign
  if ('strokeCap' in node) styles.strokeCap = node.strokeCap
  if ('strokeJoin' in node) styles.strokeJoin = node.strokeJoin
  if ('dashPattern' in node && node.dashPattern.length > 0) {
    styles.strokeDashes = node.dashPattern
  }

  // 圆角：矩形给单值，Frame 给四角
  if ('cornerRadius' in node) {
    styles.cornerRadius =
      node.cornerRadius === figma.mixed ? 'mixed' : node.cornerRadius
  }
  if ('topLeftRadius' in node) {
    styles.topLeftRadius = node.topLeftRadius
    styles.topRightRadius = node.topRightRadius
    styles.bottomLeftRadius = node.bottomLeftRadius
    styles.bottomRightRadius = node.bottomRightRadius
  }

  if ('effects' in node) {
    styles.effects = (node.effects as readonly Effect[]).map(serializeEffect)
  }

  if ('opacity' in node) styles.opacity = node.opacity
  if ('blendMode' in node) styles.blendMode = node.blendMode
  if ('clipsContent' in node) styles.clipsContent = node.clipsContent
  if ('isMask' in node) styles.isMask = node.isMask

  // 样式库引用：告诉 AI 这个值来自哪个设计规范
  const fillStyleId = 'fillStyleId' in node ? node.fillStyleId : ''
  if (typeof fillStyleId === 'string' && fillStyleId) {
    styles.fillStyleId = fillStyleId
    styles.fillStyleName = await safeStyleName(fillStyleId)
  }
  const strokeStyleId = 'strokeStyleId' in node ? node.strokeStyleId : ''
  if (typeof strokeStyleId === 'string' && strokeStyleId) {
    styles.strokeStyleId = strokeStyleId
    styles.strokeStyleName = await safeStyleName(strokeStyleId)
  }
  const effectStyleId = 'effectStyleId' in node ? node.effectStyleId : ''
  if (typeof effectStyleId === 'string' && effectStyleId) {
    styles.effectStyleId = effectStyleId
    styles.effectStyleName = await safeStyleName(effectStyleId)
  }

  if (node.type === 'TEXT') {
    styles.text = serializeTextStyle(node as TextNode)
    const textStyleId = (node as TextNode).textStyleId
    if (typeof textStyleId === 'string' && textStyleId) {
      styles.textStyleId = textStyleId
      styles.textStyleName = await safeStyleName(textStyleId)
    }
  }

  // 形状的几何信息（非样式，但读样式时常常一起要）
  if ('rotation' in node && node.rotation) styles.rotation = node.rotation
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    const frame = node as FrameNode
    styles.autoLayout = {
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
      layoutSizingHorizontal: frame.layoutSizingHorizontal,
      layoutSizingVertical: frame.layoutSizingVertical,
    }
  }

  return styles
}

/**
 * 批量读样式：一次任务读多个节点，避免逐节点往返。
 * 单点失败不影响其他节点，错误挂在各自条目上。
 */
export const readNodesStyles = async (
  nodes: SceneNode[],
  options: {depth?: number} = {},
): Promise<Array<Record<string, unknown>>> => {
  const depth = Math.max(0, options.depth ?? 0)
  const out: Array<Record<string, unknown>> = []

  const walk = async (node: SceneNode, level: number): Promise<void> => {
    let styles: Record<string, unknown>
    try {
      styles = await readNodeStyles(node)
    } catch (e) {
      styles = {error: e instanceof Error ? e.message : String(e)}
    }
    const box = node.absoluteBoundingBox
    out.push({
      id: node.id,
      name: node.name,
      type: node.type,
      parentId: node.parent ? node.parent.id : null,
      box: box
        ? {x: box.x, y: box.y, width: box.width, height: box.height}
        : null,
      styles,
    })
    if (level >= depth || !('children' in node)) return
    for (const child of node.children) {
      await walk(child, level + 1)
    }
  }

  for (const node of nodes) await walk(node, 0)
  return out
}