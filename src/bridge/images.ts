/**
 * 桥接用的图像导出。
 *
 * 三个层次，按"看清程度"递增：
 *   exportNodeImage     原样导出 / 指定缩放
 *   exportNodeThumbnail 缩略图，用于判断"这块是什么"
 *   exportNodeSlices    长图切片，用于读文字细节
 *
 * 为什么需要切片：
 * 长图（如 375×3141）无论怎么缩都矛盾——按长边缩放会把宽度压成 61px
 * 导致文字全糊；按宽度缩放则高度高达 3141，单张图太大。
 * 唯一既能看清又不超阈值的方式是切成多段，每段保持可读的宽度。
 *
 * 注意：切片会临时创建/删除节点（视口 frame + 克隆），
 * 所以必须在桥接的串行队列里执行，不能并发。
 */

export type ImageFormat = 'PNG' | 'JPG' | 'SVG'

export type ImageOptions = {
  format?: ImageFormat
  /** 缩放倍数，1 = 原始像素 */
  scale?: number
  /** 限制最长边像素（旧参数，保留兼容） */
  maxSize?: number
  /** 限制宽度像素 */
  maxWidth?: number
  /** 限制高度像素 */
  maxHeight?: number
  /** JPG 质量，仅对 JPG 有效 */
  quality?: number
}

export type SliceOptions = ImageOptions & {
  /** 每片在原图中的高度像素，默认按宽度比例推算 */
  sliceHeight?: number
  /** 每次最多切几片，防止长图炸成一堆请求 */
  maxSlices?: number
}

const MIME: Record<ImageFormat, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  SVG: 'image/svg+xml',
}

/** 长图判定：高宽比超过这个值就该考虑切片 */
export const LONG_IMAGE_RATIO = 4

/** 默认每片的高度像素 */
const DEFAULT_SLICE_HEIGHT = 1200

/** 默认最多片数 */
const DEFAULT_MAX_SLICES = 8

/**
 * base64 编码。
 *
 * 优先用 figma.base64Encode：它处理 UTF-8 与字节边界更稳妥，
 * 也是插件环境推荐做法。测试环境（Node）没有 figma，
 * 退化为 Buffer 实现，便于纯逻辑单测。
 */
const toBase64 = (bytes: Uint8Array): string => {
  const api = (globalThis as {
    figma?: {base64Encode?: (b: Uint8Array) => string}
  }).figma
  if (api && typeof api.base64Encode === 'function') {
    return api.base64Encode(bytes)
  }
  const buf = (globalThis as {
    Buffer?: {from: (b: Uint8Array) => {toString: (e: string) => string}}
  }).Buffer
  if (buf) return buf.from(bytes).toString('base64')
  throw new Error('当前环境不支持 base64 编码')
}

const clampScale = (value: number): number =>
  Math.max(0.01, Math.min(4, value))

/**
 * 综合各约束求实际缩放。
 *
 * 关键语义：所有约束都只用来"缩小"，不放大。
 * 取最严格的那个，避免"限制了宽度却因高度约束反而放大"。
 */
export const resolveScale = (
  box: {width: number; height: number} | null,
  options: ImageOptions,
): number => {
  if (!box) return clampScale(options.scale ?? 1)

  const candidates: number[] = []
  if (typeof options.scale === 'number') {
    candidates.push(clampScale(options.scale))
  }
  if (typeof options.maxSize === 'number' && options.maxSize > 0) {
    const longest = Math.max(box.width, box.height)
    if (longest > options.maxSize) candidates.push(options.maxSize / longest)
  }
  if (typeof options.maxWidth === 'number' && options.maxWidth > 0) {
    if (box.width > options.maxWidth) candidates.push(options.maxWidth / box.width)
  }
  if (typeof options.maxHeight === 'number' && options.maxHeight > 0) {
    if (box.height > options.maxHeight) {
      candidates.push(options.maxHeight / box.height)
    }
  }

  // 没给任何约束就原尺寸
  if (candidates.length === 0) return 1
  return clampScale(Math.min(...candidates))
}

const buildSettings = (
  format: ImageFormat,
  scale: number,
  quality?: number,
): ExportSettings => {
  if (format === 'SVG') return {format: 'SVG'}
  const base = {constraint: {type: 'SCALE' as const, value: scale}}
  if (format === 'JPG') {
    return {
      format: 'JPG',
      ...base,
      ...(typeof quality === 'number'
        ? {quality: Math.max(0, Math.min(1, quality))}
        : {}),
    }
  }
  return {format: 'PNG', ...base}
}

export type ExportedImage = {
  nodeId: string
  name: string
  format: ImageFormat
  mimeType: string
  /** base64，不含 data: 前缀 */
  data: string
  /** 解码后的字节数，用于判断是否超阈值 */
  byteLength: number
  width: number | null
  height: number | null
  scale: number
  /** 切片时的序号与范围（原图坐标） */
  slice?: {index: number; total: number; from: number; to: number}
}

/** 导出单节点为图片，返回 base64 */
export const exportNodeImage = async (
  node: SceneNode,
  options: ImageOptions = {},
): Promise<ExportedImage> => {
  const format: ImageFormat = options.format ?? 'PNG'
  const box = node.absoluteBoundingBox
  const scale = resolveScale(box, options)
  const bytes = await node.exportAsync(
    buildSettings(format, scale, options.quality),
  )

  return {
    nodeId: node.id,
    name: node.name,
    format,
    mimeType: MIME[format],
    data: toBase64(bytes),
    byteLength: bytes.length,
    width: box ? Math.round(box.width * scale) : null,
    height: box ? Math.round(box.height * scale) : null,
    scale,
  }
}

/**
 * 缩略图：默认 JPG、宽度上限 512。
 *
 * 刻意按"宽度"而非"长边"约束——缩略图的用途是判断内容，
 * 宽度决定横向可辨识度，长图不该因为太高而把宽度压没。
 */
export const exportNodeThumbnail = async (
  node: SceneNode,
  options: ImageOptions = {},
): Promise<ExportedImage> =>
  exportNodeImage(node, {
    format: options.format ?? 'JPG',
    maxWidth: options.maxWidth ?? 512,
    maxHeight: options.maxHeight,
    maxSize: options.maxSize,
    quality: options.quality ?? 0.8,
    scale: options.scale,
  })

/**
 * 长图切片导出。
 *
 * 做法：建一个和原节点等宽的临时 frame 当视口，把克隆挂进去并上下平移，
 * 每次只露出一个切片高度，然后对 frame 截图。这样每片都是"原始宽度 ×
 * 切片高度"，文字保持清晰。
 *
 * 非长图（高宽比 < LONG_IMAGE_RATIO）直接走普通导出，不多此一举。
 */
export const exportNodeSlices = async (
  node: SceneNode,
  options: SliceOptions = {},
): Promise<ExportedImage[]> => {
  const box = node.absoluteBoundingBox
  if (!box) return [await exportNodeImage(node, options)]

  const ratio = box.height / Math.max(1, box.width)
  if (ratio < LONG_IMAGE_RATIO) {
    return [await exportNodeImage(node, options)]
  }

  const format: ImageFormat = options.format ?? 'JPG'
  const sliceHeight = Math.max(
    100,
    Math.round(options.sliceHeight ?? DEFAULT_SLICE_HEIGHT),
  )
  const total = Math.min(
    options.maxSlices ?? DEFAULT_MAX_SLICES,
    Math.ceil(box.height / sliceHeight),
  )
  // 片数被 maxSlices 截断时，把每片高度放大到能覆盖全图
  const step = Math.ceil(box.height / total)

  const scale = resolveScale(
    {width: box.width, height: step},
    {maxWidth: options.maxWidth ?? 750, scale: options.scale},
  )

  const slices: ExportedImage[] = []

  for (let i = 0; i < total; i++) {
    const from = i * step
    const to = Math.min(from + step, box.height)
    const visibleHeight = to - from

    // 视口：等宽、够高，clipsContent 裁掉超出部分
    const viewport = figma.createFrame()
    viewport.name = `ni-slice-${node.id}-${i}`
    viewport.resize(box.width, visibleHeight)
    viewport.clipsContent = true
    viewport.fills = []

    let clone: SceneNode | null = null
    try {
      clone = node.clone()
      viewport.appendChild(clone)
      clone.x = 0
      // 上移，让第 from 像素对齐视口顶部
      clone.y = -from

      const bytes = await viewport.exportAsync(
        buildSettings(format, scale, options.quality ?? 0.8),
      )
      slices.push({
        nodeId: node.id,
        name: `${node.name} [${i + 1}/${total}]`,
        format,
        mimeType: MIME[format],
        data: toBase64(bytes),
        byteLength: bytes.length,
        width: Math.round(box.width * scale),
        height: Math.round(visibleHeight * scale),
        scale,
        slice: {index: i, total, from, to},
      })
    } finally {
      // 无论成功失败都要清掉临时节点，否则会污染文档
      if (clone) clone.remove()
      viewport.remove()
    }
  }

  return slices
}

/**
 * 批量导出。逐个失败不影响其他，错误按节点记录。
 * 单次任务完成，避免逐节点往返的开销。
 */
export const exportNodesImages = async (
  nodes: SceneNode[],
  options: ImageOptions & {thumbnail?: boolean} = {},
): Promise<{
  images: ExportedImage[]
  errors: Array<{nodeId: string; name: string; error: string}>
}> => {
  const images: ExportedImage[] = []
  const errors: Array<{nodeId: string; name: string; error: string}> = []

  for (const node of nodes) {
    try {
      images.push(
        options.thumbnail
          ? await exportNodeThumbnail(node, options)
          : await exportNodeImage(node, options),
      )
    } catch (e) {
      errors.push({
        nodeId: node.id,
        name: node.name,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return {images, errors}
}