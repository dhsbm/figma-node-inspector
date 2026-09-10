/// <reference types="plugin-typings" />
import {
  buildBooleanSubtractPunchWarning,
  collectHtmlLayoutWarnings,
  shouldMarkBooleanSubtractPunch,
} from './scripts/lib/html-layout-warnings.mjs'

/**
 * Node Inspector：读取所选节点的完整层级树与样式信息。
 * 依赖：Figma Plugin API。由 manifest 加载 code.js。
 * 不变量：仅读当前页 selection；子树递归深度不设硬上限。
 * 隐藏节点仍写入树（visible=false），便于搜索/取消隐藏；HTML 生成侧应跳过。
 * 写操作：选中子节点、改名、标记「按图片导出」、批量显隐；
 * 插件内选区同步不触发整树重读。
 */

import {resolveAutoLineHeightPx} from './scripts/lib/figma-line-height.mjs'
import {attachRootRelativeCoords} from './scripts/lib/root-relative-layout.mjs'

/** PingFang Regular 等在 Figma 常报 300；JSON/CSS 统一下限 400 */
const MIN_FONT_WEIGHT = 400

function normalizeFontWeight(
  weight: number | undefined | null,
): number | undefined {
  if (typeof weight !== 'number' || Number.isNaN(weight) || weight <= 0) {
    return undefined
  }
  return Math.max(MIN_FONT_WEIGHT, Math.round(weight))
}

type TransformMatrix = [[number, number, number], [number, number, number]]

type SerializedPaint =
  | {
      type: 'SOLID'
      color: string
      opacity: number
      visible: boolean
      blendMode?: string
    }
  | {
      type: string
      opacity: number
      visible: boolean
      stops?: Array<{position: number; color: string}>
      gradientTransform?: TransformMatrix
      /** 由 gradientTransform 推导，便于 CSS linear-gradient */
      cssAngle?: number
      blendMode?: string
      scaleMode?: string
      imageHash?: string | null
      imageTransform?: TransformMatrix
      rotation?: number
      scalingFactor?: number
    }

type SerializedEffect = {
  type: string
  visible: boolean
  radius?: number
  color?: string
  offset?: {x: number; y: number}
  spread?: number
  blendMode?: string
}

type SerializedTextSegment = {
  characters: string
  start: number
  end: number
  fills?: SerializedPaint[]
  fontSize?: number
  fontName?: FontName
  fontWeight?: number
}

type SerializedTextStyle = {
  fontSize?: number
  fontName?: FontName
  fontWeight?: number
  textAlignHorizontal?: string
  textAlignVertical?: string
  letterSpacing?: LetterSpacing | PluginAPI['mixed']
  lineHeight?: LineHeight | PluginAPI['mixed']
  /** lineHeight 为 AUTO 时：插件用单行文案探针测得的像素行高 */
  lineHeightPx?: number
  textCase?: string
  textDecoration?: string
  characters?: string
  /**
   * 字符级样式分段（混色/混字重等）。
   * 整段 fills 为 mixed 时 styles.fills 为空，以本字段为准。
   */
  segments?: SerializedTextSegment[]
  /** WIDTH_AND_HEIGHT=自适应宽高；HEIGHT=定宽换行；NONE=定宽定高；TRUNCATE=截断 */
  textAutoResize?: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE'
  /** ENDING=超出以省略号截断 */
  textTruncation?: 'DISABLED' | 'ENDING'
  maxLines?: number | null
}

type ImageAsset =
  | {
      mime: string
      dataUrl: string
      byteLength: number
      /** 被多少处 fill / 矢量节点引用 */
      refCount?: number
      source?: 'fill' | 'vector' | 'marked'
      /** 像素内容指纹，用于识别不同 hash 的相同图片 */
      contentHash?: string
    }
  | {
      duplicateOf: string
      contentHash: string
      mime?: string
      byteLength?: number
      refCount?: number
      source?: 'fill' | 'vector' | 'marked'
    }
  | {
      error: string
    }

/**
 * 选区用到的字体元数据。
 * 约束：Plugin API 无法导出字体二进制（版权与接口限制），仅记录 family/style/weight；
 * HTML 侧对 google 字体走 CDN，对 system 字体走本机 font-family 栈。
 */
type FontRef = {
  family: string
  style: string
  weight?: number
  provider: 'system' | 'google' | 'unknown'
}

/** 需要导出 SVG / 可计入矢量占比的形状类节点 */
const SVG_NODE_TYPES = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'LINE',
  'ELLIPSE',
  'RECTANGLE',
  /** Plugin API 正式名 */
  'POLYGON',
  /** REST / 旧数据兼容 */
  'REGULAR_POLYGON',
  'WASHI_TAPE',
])

/**
 * 复杂插画启发式：可见叶子数 ≥ 此值，且矢量占比达标时整组切图。
 * 避免像 Milkfish（百余片 VECTOR + 少量 ELLIPSE）被拆成上百张 <img>。
 */
const VECTOR_BAKE_MIN_LEAVES = 8
const VECTOR_BAKE_RATIO = 0.85

/**
 * 小尺寸 Instance / Frame 纳入 bakeVectorGroup 的阈值（宽或高任一超过则不自动烘焙）。
 * 覆盖返回按钮圆底（约 40px）等图标容器。
 */
const MAX_BAKE_SMALL_CONTAINER_PX = 72

/**
 * Instance 切图逻辑去重：尺寸归一化步长（px）。
 * 用较长边向下取整到该步长，使 20×20 与 22×22 等同主组件合并为一张。
 */
const BAKE_SIZE_NORMALIZE_STEP = 4

/** 用户在插件中标记「按图片导出」；持久化到节点 pluginData */
const PLUGIN_DATA_EXPORT_AS_IMAGE = 'exportAsImage'
/** 用户标记「不要自动切图」；优先于自动烘焙策略 */
const PLUGIN_DATA_SKIP_IMAGE_BAKE = 'skipImageBake'

function isMarkedExportAsImage(node: BaseNode): boolean {
  return node.getPluginData(PLUGIN_DATA_EXPORT_AS_IMAGE) === '1'
}

function isMarkedSkipImageBake(node: BaseNode): boolean {
  return node.getPluginData(PLUGIN_DATA_SKIP_IMAGE_BAKE) === '1'
}

function attachHtmlLayoutWarningMeta(
  node: SceneNode,
  info: NodeInfo,
): void {
  if (node.type !== 'BOOLEAN_OPERATION') return
  const op = node.booleanOperation
  info.booleanOperation = op
  const childCount =
    'children' in node ? node.children.length : info.childCount
  if (
    !shouldMarkBooleanSubtractPunch(
      op,
      info.layout,
      childCount,
      info.children,
    )
  ) {
    return
  }
  info.htmlLayoutWarning = buildBooleanSubtractPunchWarning(op)
}

function isVectorContainerType(type: string): boolean {
  return type === 'GROUP' || type === 'TRANSFORM_GROUP'
}

/**
 * 生成侧能忠实还原的填充/描边：实色或线性渐变。
 * 位图、径向/角向/菱形渐变等不算 CSS 友好。
 */
function isCssFriendlyPaint(paint: Paint): boolean {
  if (paint.visible === false) return true
  return paint.type === 'SOLID' || paint.type === 'GRADIENT_LINEAR'
}

function nodePaintsAreCssFriendly(node: SceneNode): boolean {
  if ('fills' in node) {
    if (node.fills === figma.mixed) return false
    for (const paint of node.fills as readonly Paint[]) {
      if (!isCssFriendlyPaint(paint)) return false
    }
  }
  if ('strokes' in node) {
    for (const paint of node.strokes as readonly Paint[]) {
      if (!isCssFriendlyPaint(paint)) return false
    }
  }
  return true
}

/**
 * CSS 友好盒子形状：RECTANGLE（+ cornerRadius）或 ELLIPSE（≈ border-radius:50%），
 * 用宽高 + background/border 即可还原，不自动切图。
 * 含 IMAGE / 非线性渐变等则仍走矢量白名单切图。
 */
function isCssFriendlyBoxShape(node: SceneNode): boolean {
  return (
    (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') &&
    nodePaintsAreCssFriendly(node)
  )
}

/**
 * 纯矢量容器整体导出，保留子路径的真实变换和组合关系。
 * 混合了文字、位图或其它非形状节点的 Group 仍按层级序列化。
 * CSS 友好 RECTANGLE / ELLIPSE 不视为需导出的矢量叶。
 */
function shouldExportSvg(node: SceneNode): boolean {
  if (isCssFriendlyBoxShape(node)) return false
  if (SVG_NODE_TYPES.has(node.type)) return true
  if (!isVectorContainerType(node.type) || !('children' in node)) return false
  if (node.children.length === 0) return false
  return node.children.every((child) => shouldExportSvg(child))
}

/** 子树是否含可见 TEXT（带字按钮应展开，不能整颗栅格化） */
function subtreeHasText(node: SceneNode): boolean {
  if (node.type === 'TEXT') return true
  if (!('children' in node)) return false
  for (const child of node.children) {
    if (!child.visible) continue
    if (subtreeHasText(child)) return true
  }
  return false
}

type VectorLeafStats = {
  leafCount: number
  vectorishCount: number
  hasText: boolean
  hasImageFill: boolean
}

/**
 * 统计可见叶子：形状/布尔整颗算一片矢量叶；GROUP/FRAME 等继续下钻。
 */
function collectVectorLeafStats(
  node: SceneNode,
  stats: VectorLeafStats,
): void {
  if (!node.visible) return

  if (node.type === 'TEXT') {
    stats.hasText = true
    stats.leafCount += 1
    return
  }

  // CSS 友好矩形/椭圆计入叶子但不算矢量占比，避免纯色/渐变块把插画启发式推过高
  if (isCssFriendlyBoxShape(node)) {
    stats.leafCount += 1
    return
  }

  if (SVG_NODE_TYPES.has(node.type)) {
    stats.leafCount += 1
    stats.vectorishCount += 1
    if (nodeHasVisibleImageFill(node)) stats.hasImageFill = true
    return
  }

  if (nodeHasVisibleImageFill(node)) stats.hasImageFill = true

  if ('children' in node && node.children.length > 0) {
    for (const child of node.children) {
      collectVectorLeafStats(child, stats)
    }
    return
  }

  stats.leafCount += 1
}

/**
 * 矢量占比高的插画容器：整组切图，而不是逐片 VECTOR。
 * - 仅 GROUP / 非 Auto Layout 的 FRAME
 * - 无文字、无位图填充
 * - 叶子数 ≥ VECTOR_BAKE_MIN_LEAVES，且矢量占比 ≥ VECTOR_BAKE_RATIO
 */
function shouldBakeDenseVectorGroup(node: SceneNode): boolean {
  if (node.type !== 'GROUP' && node.type !== 'FRAME') return false
  if (
    'layoutMode' in node &&
    node.layoutMode &&
    node.layoutMode !== 'NONE'
  ) {
    return false
  }
  if (subtreeHasText(node)) return false

  const stats: VectorLeafStats = {
    leafCount: 0,
    vectorishCount: 0,
    hasText: false,
    hasImageFill: false,
  }
  collectVectorLeafStats(node, stats)
  if (stats.hasText || stats.hasImageFill) return false
  if (stats.leafCount < VECTOR_BAKE_MIN_LEAVES) return false
  return stats.vectorishCount / stats.leafCount >= VECTOR_BAKE_RATIO
}

function hasMeaningfulRotation(node: SceneNode): boolean {
  return 'rotation' in node && Math.abs(node.rotation) > 0.01
}

function nodeHasVisibleImageFill(node: SceneNode): boolean {
  if (!('fills' in node) || node.fills === figma.mixed) return false
  return (node.fills as readonly Paint[]).some(
    (paint) => paint.visible !== false && paint.type === 'IMAGE',
  )
}

/**
 * 带旋转的节点应整颗切图烘焙。
 * exportAsync 像素已含旋转；若仍保留 layout.rotation，HTML 再叠 CSS rotate
 * 会二次变换，且 Auto Layout 下原点与 Figma 不一致。
 * imageHash 是未旋转的源图，不能代替节点切图。
 */
function shouldBakeRotatedNode(node: SceneNode): boolean {
  if (!hasMeaningfulRotation(node)) return false
  // 保留可编辑文案
  if (subtreeHasText(node)) return false
  // CSS 友好矩形/椭圆用 layout.rotation → CSS rotate，不整颗切图
  if (isCssFriendlyBoxShape(node)) return false
  // 位图填充 + 旋转：必须烘焙
  if (nodeHasVisibleImageFill(node)) return true
  // 无子层的旋转形状（矩形/椭圆等）
  if (!('children' in node) || node.children.length === 0) return true
  // 有子层的旋转容器（如返回图标 Instance 翻转）：内部常再叠相对旋转与绝对坐标，
  // CSS 无法可靠还原，整颗切图。
  if (
    node.type === 'INSTANCE' ||
    node.type === 'COMPONENT' ||
    node.type === 'FRAME' ||
    node.type === 'GROUP' ||
    node.type === 'TRANSFORM_GROUP'
  ) {
    return true
  }
  return false
}

function hasVisibleChild(node: SceneNode): boolean {
  if (!('children' in node)) return false
  return node.children.some((child) => child.visible)
}

function getVisibleChildren(node: SceneNode): SceneNode[] {
  if (!('children' in node)) return []
  return node.children.filter((child) => child.visible)
}

/**
 * 宽高都较小的 Instance / Frame：纳入 bakeVectorGroup 整组导出。
 * 无文字、有可见子层；空壳纯色框仍走 CSS。
 */
function shouldBakeSmallContainer(node: SceneNode): boolean {
  if (node.type !== 'INSTANCE' && node.type !== 'FRAME') return false
  if (!('width' in node) || !('height' in node)) return false
  if (
    node.width > MAX_BAKE_SMALL_CONTAINER_PX ||
    node.height > MAX_BAKE_SMALL_CONTAINER_PX
  ) {
    return false
  }
  if (subtreeHasText(node)) return false
  if (!hasVisibleChild(node)) return false
  return true
}

/**
 * A：子层是否为「形状单元」（形状类型 / 纯矢量 Group）。
 * 不含嵌套 Frame（嵌套由 D / 递归 all-shape 处理）。
 * CSS 友好矩形/椭圆不算形状单元，避免父 Frame 因纯色底整层切图。
 */
function isShapeUnitChild(node: SceneNode): boolean {
  if (isCssFriendlyBoxShape(node)) return false
  if (SVG_NODE_TYPES.has(node.type)) return true
  if (isVectorContainerType(node.type) && shouldExportSvg(node)) return true
  return false
}

/**
 * 含 Mask 的容器：子层 isMask 会裁切其后兄弟，CSS 无法忠实还原。
 * 整组 PNG 烘焙（尊重 skipImageBake）。
 */
function shouldBakeMaskGroup(node: SceneNode): boolean {
  if (!('children' in node)) return false
  return node.children.some(
    (child) => child.visible && 'isMask' in child && child.isMask === true,
  )
}

/**
 * D：子层是否「本就会被切成图 / 纯视觉单元」，从而应提升到父 Frame 整层切。
 * 注意：不可再调用 shouldBakeAllShapeFrame，避免与 A 递归死循环；嵌套 Frame 用深度受限递归。
 */
function childWouldBakeAsVisual(
  node: SceneNode,
  depth: number,
): boolean {
  if (isShapeUnitChild(node)) return true
  if (shouldBakeMaskGroup(node)) return true
  if (shouldBakeRotatedNode(node)) return true
  if (shouldBakeSmallContainer(node)) return true
  if (shouldBakeDenseVectorGroup(node)) return true
  // 嵌套「全形状 Frame」：与 A 同条件但下钻一层（depth 限制）
  if (depth > 0 && isAllShapeOrVisualFrame(node, depth - 1)) return true
  // 叶子位图填充（无可见子层）
  if (
    nodeHasVisibleImageFill(node) &&
    getVisibleChildren(node).length === 0
  ) {
    return true
  }
  return false
}

/**
 * A+D：无字、非 Auto Layout 的 Frame，可见子层全是形状或「本就会切图」→ 整层切。
 * 覆盖「地板」这类：矩形 + 布尔 多子层装饰块，避免拆成多张子图。
 * 也覆盖原「单子层 Frame」中子层为形状/纯矢量的情形。
 */
function isAllShapeOrVisualFrame(node: SceneNode, depth: number): boolean {
  if (node.type !== 'FRAME') return false
  if (
    'layoutMode' in node &&
    node.layoutMode &&
    node.layoutMode !== 'NONE'
  ) {
    return false
  }
  if (subtreeHasText(node)) return false
  const children = getVisibleChildren(node)
  if (children.length === 0) return false
  return children.every((child) => childWouldBakeAsVisual(child, depth))
}

function shouldBakeAllShapeFrame(node: SceneNode): boolean {
  // depth=2：允许 Frame → Frame → 形状 两层嵌套仍提升到当前节点
  return isAllShapeOrVisualFrame(node, 2)
}

type NodeInfo = {
  id: string
  name: string
  type: string
  visible: boolean
  locked: boolean
  opacity?: number
  blendMode?: string
  clipsContent?: boolean
  svg?: string
  svgError?: string
  /** 矢量节点栅格化 PNG（Data URL），HTML 生成优先使用 */
  png?: string
  /** 去重后指向顶层 images 的 key（如 v:abc123） */
  pngRef?: string
  pngError?: string
  pngByteLength?: number
  /** 整颗视觉已烘焙，HTML 侧勿再展开子层或叠加 rotation */
  flattened?: boolean
  /** 用户标记为按图片导出（pluginData 持久化） */
  exportAsImage?: boolean
  /** 用户标记跳过自动切图（pluginData）；展开子层 / 不按图烘焙 */
  skipImageBake?: boolean
  /**
   * Inspect 切图策略：宽 ≤ 页面 → full（脱离父级裁切，保留节点 layout）；
   * 宽 > 页面 → cropped（原位裁切导出，layout 对齐 PNG）。
   */
  exportInspectMode?: 'full' | 'cropped'
  /** BOOLEAN_OPERATION 的运算类型 */
  booleanOperation?: 'UNION' | 'INTERSECT' | 'SUBTRACT' | 'EXCLUDE'
  /**
   * HTML/CSS 无法自动还原的布局（如布尔减挖空）。
   * 生成侧应显著标注，提示人工调层级或背景切图。
   */
  htmlLayoutWarning?: {
    kind: 'BOOLEAN_SUBTRACT_PUNCH'
    booleanOperation: 'SUBTRACT'
    htmlSupported: false
    message: string
    suggestion: string
  }
  layout: {
    x: number
    y: number
    width: number
    height: number
    /** 相对选区根节点原点的 x（根自身为 0） */
    rootX?: number
    /** 相对选区根节点原点的 y（根自身为 0） */
    rootY?: number
    /** 始终相对直接父盒的 x，可直接当 CSS left；根自身为 0 */
    parentX?: number
    /** 始终相对直接父盒的 y，可直接当 CSS top；根自身为 0 */
    parentY?: number
    rotation?: number
    /**
     * 视觉已烘焙（PNG/SVG）时，x/y/width/height 为相对父级的
     * absoluteBoundingBox / absoluteRenderBounds，勿再叠 CSS rotate。
     * 切图像素已含节点旋转。
     */
    bakedVisual?: boolean
    constraints?: Constraints
    layoutMode?: string
    primaryAxisSizingMode?: string
    counterAxisSizingMode?: string
    primaryAxisAlignItems?: string
    counterAxisAlignItems?: string
    padding?: {
      top: number
      right: number
      bottom: number
      left: number
    }
    /**
     * Auto Layout：描边是否计入布局。
     * false（常见）时内侧描边与 padding 重叠 → HTML 保留 border，padding 减去 strokeWeight。
     */
    strokesIncludedInLayout?: boolean
    itemSpacing?: number
    layoutWrap?: 'NO_WRAP' | 'WRAP'
    counterAxisSpacing?: number
    counterAxisAlignContent?: 'AUTO' | 'SPACE_BETWEEN'
    layoutGrow?: number
    layoutAlign?: string
    layoutPositioning?: string
  }
  styles: {
    fills?: SerializedPaint[]
    strokes?: SerializedPaint[]
    strokeWeight?: number | PluginAPI['mixed']
    strokeAlign?: string
    strokeDashes?: ReadonlyArray<number>
    cornerRadius?: number | PluginAPI['mixed']
    topLeftRadius?: number
    topRightRadius?: number
    bottomLeftRadius?: number
    bottomRightRadius?: number
    effects?: SerializedEffect[]
    fillStyleId?: string
    fillStyleName?: string
    strokeStyleId?: string
    strokeStyleName?: string
    effectStyleId?: string
    effectStyleName?: string
    textStyleId?: string
    textStyleName?: string
    text?: SerializedTextStyle
  }
  component?: {
    mainComponentId?: string | null
    mainComponentName?: string | null
    variantProperties?: {[property: string]: string} | null
    isInstance: boolean
  }
  children?: NodeInfo[]
  childCount: number
}

type ExportedPng = {
  png?: string
  pngError?: string
  pngByteLength?: number
  pngDesignSize?: {width: number; height: number}
  /** PNG 相对节点几何 AABB 的实际渲染边界，用于保留子层外发光等效果。 */
  pngVisualBounds?: {x: number; y: number; width: number; height: number}
}

function rgbaToHex(color: RGB | RGBA, opacity = 1): string {
  const a = 'a' in color ? color.a : opacity
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0')
  const rgb = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`
  if (a >= 1) return rgb.toUpperCase()
  return `${rgb}${toHex(a)}`.toUpperCase()
}

/**
 * Figma gradientTransform 映射到近似 CSS linear-gradient 角度（deg）。
 * Transform 为 [[a, c, tx], [b, d, ty]]，梯度默认沿局部 +x。
 */
function gradientTransformToCssAngle(transform: TransformMatrix): number {
  const a = transform[0][0]
  const b = transform[1][0]
  const radians = Math.atan2(b, a)
  // CSS：0deg 向上，顺时针；Figma 局部 +x 对应 CSS 90deg
  const deg = (radians * 180) / Math.PI + 90
  return Math.round(((deg % 360) + 360) % 360)
}

function serializePaint(paint: Paint): SerializedPaint {
  if (paint.type === 'SOLID') {
    return {
      type: 'SOLID',
      color: rgbaToHex(paint.color, paint.opacity ?? 1),
      opacity: paint.opacity ?? 1,
      visible: paint.visible !== false,
      blendMode: paint.blendMode,
    }
  }

  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    const gradientTransform = paint.gradientTransform as TransformMatrix
    return {
      type: paint.type,
      opacity: paint.opacity ?? 1,
      visible: paint.visible !== false,
      blendMode: paint.blendMode,
      stops: paint.gradientStops.map((stop) => ({
        position: stop.position,
        color: rgbaToHex(stop.color),
      })),
      gradientTransform,
      cssAngle:
        paint.type === 'GRADIENT_LINEAR'
          ? gradientTransformToCssAngle(gradientTransform)
          : undefined,
    }
  }

  if (paint.type === 'IMAGE') {
    return {
      type: 'IMAGE',
      opacity: paint.opacity ?? 1,
      visible: paint.visible !== false,
      blendMode: paint.blendMode,
      scaleMode: paint.scaleMode,
      imageHash: paint.imageHash,
      imageTransform: paint.imageTransform as TransformMatrix | undefined,
      rotation: paint.rotation,
      scalingFactor: paint.scalingFactor,
    }
  }

  return {
    type: paint.type,
    opacity: paint.opacity ?? 1,
    visible: paint.visible !== false,
    blendMode: 'blendMode' in paint ? paint.blendMode : undefined,
  }
}

function serializeEffect(effect: Effect): SerializedEffect {
  const base: SerializedEffect = {
    type: effect.type,
    visible: effect.visible !== false,
  }

  if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
    return {
      ...base,
      radius: effect.radius,
      color: rgbaToHex(effect.color),
      offset: {x: effect.offset.x, y: effect.offset.y},
      spread: effect.spread,
      blendMode: effect.blendMode,
    }
  }

  if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
    return {...base, radius: effect.radius}
  }

  return base
}

function getLayoutInfo(node: SceneNode): NodeInfo['layout'] {
  const layout: NodeInfo['layout'] = {
    x: 'x' in node ? node.x : 0,
    y: 'y' in node ? node.y : 0,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
  }

  if ('rotation' in node) layout.rotation = node.rotation
  if ('constraints' in node) layout.constraints = node.constraints

  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    layout.layoutMode = node.layoutMode
    layout.primaryAxisSizingMode = node.primaryAxisSizingMode
    layout.counterAxisSizingMode = node.counterAxisSizingMode
    layout.primaryAxisAlignItems = node.primaryAxisAlignItems
    layout.counterAxisAlignItems = node.counterAxisAlignItems
    layout.itemSpacing = node.itemSpacing
    if ('layoutWrap' in node) layout.layoutWrap = node.layoutWrap
    if ('counterAxisSpacing' in node) {
      layout.counterAxisSpacing = node.counterAxisSpacing
    }
    if ('counterAxisAlignContent' in node) {
      layout.counterAxisAlignContent = node.counterAxisAlignContent
    }
    layout.padding = {
      top: node.paddingTop,
      right: node.paddingRight,
      bottom: node.paddingBottom,
      left: node.paddingLeft,
    }
    if ('strokesIncludedInLayout' in node) {
      layout.strokesIncludedInLayout = node.strokesIncludedInLayout
    }
  }

  if ('layoutGrow' in node) layout.layoutGrow = node.layoutGrow
  if ('layoutAlign' in node) layout.layoutAlign = node.layoutAlign
  if ('layoutPositioning' in node) {
    layout.layoutPositioning = node.layoutPositioning
  }

  return layout
}

/** PNG IHDR 宽高（像素） */
function readPngPixelSize(
  bytes: Uint8Array,
): {width: number; height: number} | null {
  if (bytes.length < 24) return null
  // signature(8) + length(4) + 'IHDR'(4) + width/height
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null
  }
  const width =
    ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>>
    0
  const height =
    ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>>
    0
  if (width <= 0 || height <= 0) return null
  return {width, height}
}

/** SVG viewBox / width×height → 设计 px */
function readSvgDesignSize(
  svg: string,
): {width: number; height: number} | null {
  const vb = svg.match(
    /viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i,
  )
  if (vb) {
    const width = parseFloat(vb[3])
    const height = parseFloat(vb[4])
    if (width > 0 && height > 0) return {width, height}
  }
  const w = svg.match(/\bwidth\s*=\s*["']([\d.]+)/i)
  const h = svg.match(/\bheight\s*=\s*["']([\d.]+)/i)
  if (w && h) {
    const width = parseFloat(w[1])
    const height = parseFloat(h[1])
    if (width > 0 && height > 0) return {width, height}
  }
  return null
}

function approxEq(a: number, b: number, eps = 0.51): boolean {
  return Math.abs(a - b) <= eps
}

/**
 * 整颗导出 PNG/SVG 后，布局改为相对父级的几何包围盒。
 * 默认优先 absoluteBoundingBox（不含阴影等 effects）；子层 effect 被烘焙时
 * 可传入其相对 AABB 的实际渲染边界。
 * 若提供导出设计尺寸且与 AABB 不一致，以切图像素为准（STAR 紧裁、
 * GROUP 透明边裁切等），避免 CSS 把图拉伸变形。
 */
function applyBakedVisualLayout(
  node: SceneNode,
  layout: NodeInfo['layout'],
  exportDesignSize?: {width: number; height: number} | null,
  visualBounds?: {x: number; y: number; width: number; height: number} | null,
): void {
  const bounds =
    ('absoluteBoundingBox' in node && node.absoluteBoundingBox) ||
    ('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null)
  if (!bounds) {
    layout.rotation = undefined
    layout.bakedVisual = true
    return
  }

  let originX = 0
  let originY = 0
  const parent = node.parent
  if (parent && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT') {
    const parentBox =
      ('absoluteBoundingBox' in parent && parent.absoluteBoundingBox) ||
      ('absoluteRenderBounds' in parent ? parent.absoluteRenderBounds : null)
    if (parentBox) {
      originX = parentBox.x
      originY = parentBox.y
    } else if ('x' in parent && 'y' in parent) {
      originX = parent.x
      originY = parent.y
    }
  }

  let x = bounds.x - originX
  let y = bounds.y - originY
  let width = bounds.width
  let height = bounds.height

  const ew = exportDesignSize?.width
  const eh = exportDesignSize?.height

  if (visualBounds) {
    x += visualBounds.x
    y += visualBounds.y
    width = typeof ew === 'number' && ew > 0 ? ew : visualBounds.width
    height = typeof eh === 'number' && eh > 0 ? eh : visualBounds.height
    layout.x = x
    layout.y = y
    layout.width = width
    layout.height = height
    layout.rotation = undefined
    layout.bakedVisual = true
    return
  }

  if (
    typeof ew === 'number' &&
    typeof eh === 'number' &&
    ew > 0 &&
    eh > 0 &&
    (!approxEq(width, ew) || !approxEq(height, eh))
  ) {
    // 父级裁剪：导出尺寸常等于 AABB∩父盒（如头图 Group）
    if (
      parent &&
      parent.type !== 'PAGE' &&
      parent.type !== 'DOCUMENT' &&
      'clipsContent' in parent &&
      parent.clipsContent &&
      'width' in parent &&
      'height' in parent
    ) {
      const ix = Math.max(x, 0)
      const iy = Math.max(y, 0)
      const iw = Math.min(x + width, parent.width) - ix
      const ih = Math.min(y + height, parent.height) - iy
      if (iw > 0 && ih > 0 && approxEq(iw, ew) && approxEq(ih, eh)) {
        x = ix
        y = iy
        width = ew
        height = eh
        layout.x = x
        layout.y = y
        layout.width = width
        layout.height = height
        layout.rotation = undefined
        layout.bakedVisual = true
        return
      }
    }

    // 否则：切图相对 AABB 居中（如 STAR 路径紧裁 vs 27×27 盒）
    x += (width - ew) / 2
    y += (height - eh) / 2
    width = ew
    height = eh
  }

  layout.x = x
  layout.y = y
  layout.width = width
  layout.height = height
  layout.rotation = undefined
  layout.bakedVisual = true
}

/**
 * 内阴影不撑大导出画布，且 CSS `box-shadow: inset` 对 `<img>` 无效，
 * 切 PNG 时保留并烘焙进像素；外阴影/模糊仍清空，交给 HTML CSS。
 */
function shouldBakeEffectIntoPng(effect: Effect): boolean {
  return effect.type === 'INNER_SHADOW'
}

function effectsForPngExport(effects: readonly Effect[]): Effect[] {
  return effects.filter(shouldBakeEffectIntoPng)
}

/**
 * 切图前临时去掉不进 PNG 的 effects，避免外阴影/模糊撑大导出像素；
 * styles 仍序列化原 effects。`keepInnerShadow`（PNG）时保留内阴影烘焙进像素。
 */
async function withNodeEffectsCleared<T>(
  node: SceneNode,
  run: () => Promise<T>,
  options: {keepInnerShadow?: boolean} = {},
): Promise<T> {
  if (!('effects' in node)) return run()
  const original = [...node.effects]
  if (original.length === 0) return run()
  const kept = options.keepInnerShadow
    ? effectsForPngExport(original)
    : []
  if (kept.length === original.length) return run()
  try {
    node.effects = kept
    return await run()
  } finally {
    node.effects = original
  }
}

/**
 * full 导出用：清空克隆子树中会撑盒的 effects，保留 INNER_SHADOW 烘焙进 PNG。
 * 克隆节点会被整体移除，无需恢复。
 */
function clearEffectsDeep(node: SceneNode): void {
  if ('effects' in node && node.effects.length > 0) {
    node.effects = effectsForPngExport(node.effects)
  }
  if ('children' in node) {
    for (const child of node.children) {
      clearEffectsDeep(child)
    }
  }
}

/** full PNG 的 wrapper 会裁掉子层外阴影/模糊；这类效果必须随子树烘焙。 */
function hasVisibleDescendantOuterEffect(node: SceneNode): boolean {
  if (!('children' in node)) return false
  for (const child of node.children) {
    if (!child.visible) continue
    if (
      'effects' in child &&
      child.effects.some(
        (effect) => effect.visible !== false && !shouldBakeEffectIntoPng(effect),
      )
    ) {
      return true
    }
    if (hasVisibleDescendantOuterEffect(child)) return true
  }
  return false
}

async function resolveStyleName(
  styleId: string | PluginAPI['mixed'] | undefined,
): Promise<string | undefined> {
  if (!styleId || styleId === figma.mixed || styleId === '') return undefined
  try {
    const style = await figma.getStyleByIdAsync(styleId)
    return style?.name
  } catch {
    return undefined
  }
}

async function getStylesInfo(node: SceneNode): Promise<NodeInfo['styles']> {
  const styles: NodeInfo['styles'] = {}

  if ('fills' in node && node.fills !== figma.mixed) {
    styles.fills = (node.fills as readonly Paint[]).map(serializePaint)
  }
  if ('strokes' in node) {
    styles.strokes = (node.strokes as readonly Paint[]).map(serializePaint)
  }
  if ('strokeWeight' in node) styles.strokeWeight = node.strokeWeight
  if ('strokeAlign' in node) styles.strokeAlign = node.strokeAlign
  if ('dashPattern' in node && node.dashPattern.length > 0) {
    styles.strokeDashes = node.dashPattern
  }

  if ('cornerRadius' in node) styles.cornerRadius = node.cornerRadius
  if ('topLeftRadius' in node) {
    styles.topLeftRadius = node.topLeftRadius
    styles.topRightRadius = node.topRightRadius
    styles.bottomLeftRadius = node.bottomLeftRadius
    styles.bottomRightRadius = node.bottomRightRadius
  }

  if ('effects' in node) {
    styles.effects = (node.effects as readonly Effect[]).map(serializeEffect)
  }

  if ('fillStyleId' in node && typeof node.fillStyleId === 'string') {
    styles.fillStyleId = node.fillStyleId || undefined
    styles.fillStyleName = await resolveStyleName(node.fillStyleId)
  }
  if ('strokeStyleId' in node && typeof node.strokeStyleId === 'string') {
    styles.strokeStyleId = node.strokeStyleId || undefined
    styles.strokeStyleName = await resolveStyleName(node.strokeStyleId)
  }
  if ('effectStyleId' in node && typeof node.effectStyleId === 'string') {
    styles.effectStyleId = node.effectStyleId || undefined
    styles.effectStyleName = await resolveStyleName(node.effectStyleId)
  }

  if (node.type === 'TEXT') {
    const textNode = node as TextNode
    styles.text = {
      characters: textNode.characters,
      fontSize:
        textNode.fontSize === figma.mixed ? undefined : textNode.fontSize,
      fontName:
        textNode.fontName === figma.mixed ? undefined : textNode.fontName,
      fontWeight:
        textNode.fontWeight === figma.mixed
          ? undefined
          : normalizeFontWeight(textNode.fontWeight),
      textAlignHorizontal: textNode.textAlignHorizontal,
      textAlignVertical: textNode.textAlignVertical,
      letterSpacing: textNode.letterSpacing,
      lineHeight: textNode.lineHeight,
      textCase:
        textNode.textCase === figma.mixed ? undefined : textNode.textCase,
      textDecoration:
        textNode.textDecoration === figma.mixed
          ? undefined
          : textNode.textDecoration,
      textAutoResize: textNode.textAutoResize,
      textTruncation: textNode.textTruncation,
      maxLines: textNode.maxLines,
      segments: serializeTextSegments(textNode),
    }
    const lineHeightPx = await resolveTextLineHeightPx(textNode)
    if (lineHeightPx != null) {
      styles.text.lineHeightPx = lineHeightPx
    }
    if (typeof textNode.textStyleId === 'string') {
      styles.textStyleId = textNode.textStyleId || undefined
      styles.textStyleName = await resolveStyleName(textNode.textStyleId)
    }
  }

  return styles
}

/** 混色/混样式文字：按字符范围导出 fills 等 */
function serializeTextSegments(
  textNode: TextNode,
): SerializedTextSegment[] | undefined {
  try {
    const raw = textNode.getStyledTextSegments([
      'fills',
      'fontSize',
      'fontName',
      'fontWeight',
    ])
    if (!raw.length) return undefined
    // 单段且与节点级 fills 一致时仍保留，便于 fills=mixed 时回退取色
    return raw.map((seg) => ({
      characters: seg.characters,
      start: seg.start,
      end: seg.end,
      fills: (seg.fills || []).map(serializePaint),
      fontSize: seg.fontSize,
      fontName: seg.fontName,
      fontWeight: normalizeFontWeight(seg.fontWeight),
    }))
  } catch {
    return undefined
  }
}

function isAutoLineHeight(
  lh: LineHeight | PluginAPI['mixed'],
): lh is {unit: 'AUTO'} {
  return lh !== figma.mixed && typeof lh === 'object' && lh.unit === 'AUTO'
}

async function loadFontsForTextNode(textNode: TextNode): Promise<void> {
  const len = textNode.characters.length
  if (len > 0) {
    const fonts = textNode.getRangeAllFontNames(0, len)
    for (const font of fonts) {
      await figma.loadFontAsync(font)
    }
    return
  }
  if (textNode.fontName !== figma.mixed) {
    await figma.loadFontAsync(textNode.fontName)
  }
}

/**
 * AUTO 行高：克隆节点写成单字 + WIDTH_AND_HEIGHT，直接读盒高。
 * 比按多行盒高 / fontSize×1.2 反推更贴近 Figma 字体内置行距。
 */
async function measureAutoLineHeightBySingleLine(
  textNode: TextNode,
): Promise<number | undefined> {
  let clone: TextNode | null = null
  try {
    await loadFontsForTextNode(textNode)
    clone = textNode.clone()
    // 立刻挪到 scratch，避免当前页 Layers 出现/消失闪烁
    moveToInspectScratch(clone)
    // scratch 页不展示；保持 visible 以便部分字体触发布局
    clone.visible = true
    const scratchParent = clone.parent
    if (
      scratchParent &&
      'layoutMode' in scratchParent &&
      scratchParent.layoutMode !== 'NONE'
    ) {
      clone.layoutGrow = 0
      clone.layoutAlign = 'INHERIT'
    }

    const raw = textNode.characters
    const sample =
      raw.replace(/\s/g, '')[0] || raw.replace(/\n/g, '')[0] || 'H'
    clone.textAutoResize = 'WIDTH_AND_HEIGHT'
    clone.characters = sample
    const h = clone.height
    if (typeof h !== 'number' || !(h > 0)) return undefined

    const originalHeight = textNode.height
    const fontSize =
      textNode.fontSize === figma.mixed ? undefined : textNode.fontSize
    // 多行原文若克隆后高度没变，视为未重排，交给盒高反推
    if (
      typeof originalHeight === 'number' &&
      typeof fontSize === 'number' &&
      originalHeight > fontSize * 1.5 &&
      Math.abs(h - originalHeight) < 0.5
    ) {
      return undefined
    }
    return Math.round(h * 1000) / 1000
  } catch {
    return undefined
  } finally {
    clone?.remove()
  }
  return undefined
}

async function resolveTextLineHeightPx(
  textNode: TextNode,
): Promise<number | undefined> {
  const fontSize =
    textNode.fontSize === figma.mixed ? undefined : textNode.fontSize
  if (typeof fontSize !== 'number') return undefined

  const lh = textNode.lineHeight
  if (lh !== figma.mixed && !isAutoLineHeight(lh)) return undefined

  const measured = await measureAutoLineHeightBySingleLine(textNode)
  if (measured != null) return measured

  const px = resolveAutoLineHeightPx(
    {
      characters: textNode.characters,
      fontSize,
      textAutoResize: textNode.textAutoResize,
      maxLines: textNode.maxLines === figma.mixed ? null : textNode.maxLines,
    },
    {width: textNode.width, height: textNode.height},
  )
  return px ?? undefined
}

async function getComponentInfo(
  node: SceneNode,
): Promise<NodeInfo['component'] | undefined> {
  if (node.type === 'INSTANCE') {
    const main = await node.getMainComponentAsync()
    return {
      isInstance: true,
      mainComponentId: main?.id ?? null,
      mainComponentName: main?.name ?? null,
      variantProperties: node.variantProperties,
    }
  }
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    return {isInstance: false}
  }
  return undefined
}

function getNodeLayoutWidth(node: SceneNode): number {
  if ('width' in node && typeof node.width === 'number' && node.width > 0) {
    return node.width
  }
  const box =
    'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null
  return box && box.width > 0 ? box.width : 0
}

/** 宽 ≤ pageWidth → 完整导出；否则原位裁切导出 */
function shouldFullExportForInspect(
  node: SceneNode,
  pageWidth: number,
): boolean {
  if (!(pageWidth > 0)) return true
  return getNodeLayoutWidth(node) <= pageWidth
}

async function exportNodePng(
  node: SceneNode,
  scale = imageExportSettings.scale,
): Promise<ExportedPng> {
  try {
    const safeScale = clampImageScale(scale)
    const options: ExportSettings =
      safeScale !== 1
        ? {format: 'PNG', constraint: {type: 'SCALE', value: safeScale}}
        : {format: 'PNG'}
    const bytes = await withNodeEffectsCleared(
      node,
      () => node.exportAsync(options),
      {keepInnerShadow: true},
    )
    const pixel = readPngPixelSize(bytes)
    return {
      png: `data:image/png;base64,${figma.base64Encode(bytes)}`,
      pngByteLength: bytes.length,
      pngDesignSize: pixel
        ? {width: pixel.width / safeScale, height: pixel.height / safeScale}
        : undefined,
    }
  } catch (error) {
    return {
      pngError: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * GROUP / BOOLEAN 子层与父级同坐标空间；有 png 时 localOffset 不再减父原点，
 * full 导出须在此预换算为相对父盒的 left/top。
 */
function applyFlatParentRelativeOffset(
  node: SceneNode,
  layout: NodeInfo['layout'],
): void {
  const parent = node.parent
  if (
    !parent ||
    parent.type === 'PAGE' ||
    parent.type === 'DOCUMENT' ||
    (parent.type !== 'GROUP' && parent.type !== 'BOOLEAN_OPERATION')
  ) {
    return
  }
  if (!('x' in parent) || !('y' in parent)) return
  layout.x = (layout.x ?? 0) - parent.x
  layout.y = (layout.y ?? 0) - parent.y
}

/**
 * Inspect 切图/测量用的临时页：避免 clone/Frame 挂到当前页导致 Layers 面板闪烁。
 * 整次 inspect 复用同一页，结束时删除。
 */
const INSPECT_SCRATCH_PAGE_NAME = '__node_inspector_scratch__'
let inspectScratchPage: PageNode | null = null

function cleanupOrphanScratchPages(): void {
  for (const page of figma.root.children) {
    if (
      page.type === 'PAGE' &&
      page.name === INSPECT_SCRATCH_PAGE_NAME &&
      page !== inspectScratchPage
    ) {
      page.remove()
    }
  }
}

function getInspectScratchPage(): PageNode {
  if (inspectScratchPage && !inspectScratchPage.removed) {
    return inspectScratchPage
  }
  cleanupOrphanScratchPages()
  const page = figma.createPage()
  page.name = INSPECT_SCRATCH_PAGE_NAME
  inspectScratchPage = page
  return page
}

function disposeInspectScratchPage(): void {
  if (inspectScratchPage && !inspectScratchPage.removed) {
    inspectScratchPage.remove()
  }
  inspectScratchPage = null
  cleanupOrphanScratchPages()
}

/**
 * 把节点立刻挪到 scratch 页，缩短其作为当前页 sibling 出现在 Layers 的窗口。
 */
function moveToInspectScratch(node: SceneNode): void {
  getInspectScratchPage().appendChild(node)
}

/**
 * 外侧 / 居中描边会超出 node.width×height；切 full PNG 时扩 wrapper，
 * 避免描边被裁或导出尺寸漂到 absoluteRenderBounds 的不确定值。
 */
function getStrokeExportInset(node: SceneNode): number {
  if (!('strokes' in node) || !('strokeWeight' in node) || !('strokeAlign' in node)) {
    return 0
  }
  const strokes = node.strokes
  if (!Array.isArray(strokes) || strokes.length === 0) return 0
  const hasVisible = strokes.some(
    (paint) => paint && paint.visible !== false,
  )
  if (!hasVisible) return 0
  const weight =
    typeof node.strokeWeight === 'number' ? node.strokeWeight : 0
  if (!(weight > 0)) return 0
  if (node.strokeAlign === 'OUTSIDE') return weight
  if (node.strokeAlign === 'CENTER') return weight / 2
  return 0
}

/**
 * 克隆到页面根再导出，避免祖先 clipsContent / 视口裁切像素。
 * 用透明 Frame 包装；有外侧/居中描边时扩盒并内移 clone，使 PNG 设计尺寸
 * = 节点盒 + 描边，与 Figma 视觉一致。
 * 临时节点放在 scratch 页，不污染当前页 Layers。
 *
 * 旋转节点不能走「local width×height + x/y=0」包装：Plugin API 的 rotation
 * 绕左上角，强制归零后 180° 等内容会翻到负象限，clipsContent 裁成全透明 PNG。
 * 此类节点改为 scratch 上直接 exportAsync（与 design.png 同源路径）。
 */
async function exportNodePngFull(
  node: SceneNode,
  scale = imageExportSettings.scale,
): Promise<ExportedPng> {
  if (hasVisibleDescendantOuterEffect(node)) {
    const clone = node.clone()
    moveToInspectScratch(clone)

    // 顶层 effect 仍由 HTML CSS 重建；子层 effect 没有独立 DOM，须保留在 PNG 中。
    if ('effects' in clone && clone.effects.length > 0) {
      clone.effects = effectsForPngExport(clone.effects)
    }

    try {
      const box =
        'absoluteBoundingBox' in clone ? clone.absoluteBoundingBox : null
      const render =
        'absoluteRenderBounds' in clone ? clone.absoluteRenderBounds : null
      const result = await exportNodePng(clone, scale)
      if (box && render && result.png) {
        result.pngVisualBounds = {
          x: render.x - box.x,
          y: render.y - box.y,
          width: render.width,
          height: render.height,
        }
      }
      return result
    } catch (error) {
      return {
        pngError: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clone.remove()
    }
  }

  if (hasMeaningfulRotation(node)) {
    const clone = node.clone()
    moveToInspectScratch(clone)
    clearEffectsDeep(clone)
    try {
      return await exportNodePng(clone, scale)
    } catch (error) {
      return {
        pngError: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clone.remove()
    }
  }

  const bounds =
    'absoluteBoundingBox' in node && node.absoluteBoundingBox
      ? node.absoluteBoundingBox
      : null
  const baseWidth =
    'width' in node && typeof node.width === 'number' && node.width > 0
      ? node.width
      : bounds?.width
  const baseHeight =
    'height' in node && typeof node.height === 'number' && node.height > 0
      ? node.height
      : bounds?.height
  if (!bounds || !baseWidth || !baseHeight) return exportNodePng(node, scale)

  const strokeInset = getStrokeExportInset(node)
  const width = baseWidth + strokeInset * 2
  const height = baseHeight + strokeInset * 2

  const wrapper = figma.createFrame()
  moveToInspectScratch(wrapper)
  wrapper.name = `__inspect_export_${node.name}`
  wrapper.resize(width, height)
  wrapper.x = 0
  wrapper.y = 0
  wrapper.fills = []
  // 已按描边扩盒，裁到精确导出尺寸，避免再被 renderBounds 撑大
  wrapper.clipsContent = true

  const clone = node.clone()
  // clone() 会先挂在原父级下，立刻挪进 wrapper，避免当前页 Layers 闪烁
  wrapper.appendChild(clone)
  if ('x' in clone && 'y' in clone) {
    clone.x = strokeInset
    clone.y = strokeInset
  }
  clearEffectsDeep(clone)

  try {
    return await exportNodePng(wrapper, scale)
  } catch (error) {
    return {
      pngError: error instanceof Error ? error.message : String(error),
    }
  } finally {
    wrapper.remove()
  }
}

async function exportNodePngForInspect(
  node: SceneNode,
  pageWidth: number,
): Promise<ExportedPng & {
  exportInspectMode?: 'full' | 'cropped'
}> {
  if (shouldFullExportForInspect(node, pageWidth)) {
    const result = await exportNodePngFull(node)
    return {...result, exportInspectMode: 'full'}
  }
  const result = await exportNodePng(node)
  return {...result, exportInspectMode: 'cropped'}
}

/** Inspect 切图后写 layout：cropped 对齐 PNG；full 保留 getLayoutInfo 尺寸 */
function applyInspectExportLayout(
  node: SceneNode,
  layout: NodeInfo['layout'],
  pageWidth: number,
  exportDesignSize?: {width: number; height: number} | null,
  visualBounds?: {x: number; y: number; width: number; height: number} | null,
): 'full' | 'cropped' {
  if (visualBounds) {
    applyBakedVisualLayout(node, layout, exportDesignSize, visualBounds)
    return shouldFullExportForInspect(node, pageWidth) ? 'full' : 'cropped'
  }

  if (shouldFullExportForInspect(node, pageWidth)) {
    const ew = exportDesignSize?.width
    const eh = exportDesignSize?.height
    const exportMismatch =
      typeof ew === 'number' &&
      typeof eh === 'number' &&
      ew > 0 &&
      eh > 0 &&
      (!approxEq(layout.width, ew) || !approxEq(layout.height, eh))
    // full 模式优先保留节点盒；但若导出像素尺寸明显不同，
    // 继续强塞原 layout 会把图缩小/放大，需回到视觉包围盒。
    if (exportMismatch) {
      applyBakedVisualLayout(node, layout, exportDesignSize)
      return 'full'
    }
    layout.rotation = undefined
    applyFlatParentRelativeOffset(node, layout)
    layout.bakedVisual = true
    return 'full'
  }
  applyBakedVisualLayout(node, layout, exportDesignSize)
  return 'cropped'
}

async function exportNodeVectorAssets(
  node: SceneNode,
  pageWidth: number,
): Promise<ExportedPng & {
  svg?: string
  svgError?: string
}> {
  const result: ExportedPng & {
    svg?: string
    svgError?: string
  } = {}

  try {
    result.svg = await withNodeEffectsCleared(node, () =>
      node.exportAsync({format: 'SVG_STRING'}),
    )
  } catch (error) {
    result.svgError = error instanceof Error ? error.message : String(error)
  }

  const png = await exportNodePngForInspect(node, pageWidth)
  if (png.png) result.png = png.png
  if (png.pngError) result.pngError = png.pngError
  if (png.pngByteLength) result.pngByteLength = png.pngByteLength
  if (png.pngDesignSize) result.pngDesignSize = png.pngDesignSize
  if (png.pngVisualBounds) result.pngVisualBounds = png.pngVisualBounds

  return result
}

async function serializeNode(
  node: SceneNode,
  options: {skipSvg?: boolean; pageWidth?: number} = {},
): Promise<NodeInfo | null> {
  try {
    // 隐藏层：保留在树中供 UI 搜索/取消隐藏，不导出矢量/图片资源
    if (!node.visible) {
      const hiddenChildren: NodeInfo[] = []
      if ('children' in node) {
        for (const child of node.children) {
          const serialized = await serializeNode(child, options)
          if (serialized) hiddenChildren.push(serialized)
        }
      }
      const hiddenInfo: NodeInfo = {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: false,
        locked: node.locked,
        layout: getLayoutInfo(node),
        styles: {},
        children: hiddenChildren.length > 0 ? hiddenChildren : undefined,
        childCount: hiddenChildren.length,
        exportAsImage: isMarkedExportAsImage(node) || undefined,
        skipImageBake: isMarkedSkipImageBake(node) || undefined,
      }
      attachHtmlLayoutWarningMeta(node, hiddenInfo)
      return hiddenInfo
    }

    const pageWidth =
      typeof options.pageWidth === 'number' && options.pageWidth > 0
        ? options.pageWidth
        : getNodeLayoutWidth(node) || 375

    const skipImageBake = isMarkedSkipImageBake(node)
    const exportAsImage = isMarkedExportAsImage(node) && !skipImageBake
    // Mask 组：子层 isMask 裁切其后兄弟，整组 PNG（优先于矢量烘焙）
    const bakeMaskGroup =
      !exportAsImage && !skipImageBake && shouldBakeMaskGroup(node)
    // 纯矢量 Group / 高密度插画 / 小尺寸 Instance·Frame → 整组 SVG+PNG 烘焙
    const bakeVectorGroup =
      !exportAsImage &&
      !skipImageBake &&
      !bakeMaskGroup &&
      !options.skipSvg &&
      (shouldBakeAllShapeFrame(node) ||
        (isVectorContainerType(node.type) && shouldExportSvg(node)) ||
        shouldBakeDenseVectorGroup(node) ||
        shouldBakeSmallContainer(node))
    const bakeRotated =
      !exportAsImage &&
      !skipImageBake &&
      !bakeVectorGroup &&
      !bakeMaskGroup &&
      shouldBakeRotatedNode(node)
    const bakeAsPng = exportAsImage || bakeRotated || bakeMaskGroup
    const exportAsVector =
      !bakeAsPng &&
      !skipImageBake &&
      !options.skipSvg &&
      (shouldExportSvg(node) || bakeVectorGroup)
    const skipChildSvg =
      options.skipSvg || exportAsVector || bakeAsPng
    const skipChildren = bakeVectorGroup || bakeAsPng
    const children: NodeInfo[] = []

    if ('children' in node && !skipChildren) {
      for (const child of node.children) {
        const serialized = await serializeNode(child, {
          skipSvg: skipChildSvg,
          pageWidth,
        })
        if (serialized) children.push(serialized)
      }
    }

    const layout = getLayoutInfo(node)

    const info: NodeInfo = {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
      locked: node.locked,
      layout,
      styles: await getStylesInfo(node),
      children: children.length > 0 ? children : undefined,
      childCount: children.length,
    }

    if ('opacity' in node) info.opacity = node.opacity
    if ('blendMode' in node) info.blendMode = node.blendMode
    if ('clipsContent' in node) info.clipsContent = node.clipsContent
    if (skipImageBake) info.skipImageBake = true

    if (bakeAsPng) {
      if (exportAsImage) info.exportAsImage = true
      const exported = await exportNodePngForInspect(node, pageWidth)
      if (exported.png) info.png = exported.png
      if (exported.pngError) info.pngError = exported.pngError
      if (exported.pngByteLength) info.pngByteLength = exported.pngByteLength

      if (exported.png) {
        info.flattened = true
        info.children = undefined
        info.childCount = 0
        info.exportInspectMode = applyInspectExportLayout(
          node,
          info.layout,
          pageWidth,
          exported.pngDesignSize,
          exported.pngVisualBounds,
        )
      } else if ('children' in node) {
        // 栅格化失败时回退为展开子层，仍保留标记便于排查
        for (const child of node.children) {
          const serialized = await serializeNode(child, {
            skipSvg: skipChildSvg,
            pageWidth,
          })
          if (serialized) children.push(serialized)
        }
        info.children = children.length > 0 ? children : undefined
        info.childCount = children.length
      }
    } else if (exportAsVector) {
      const exported = await exportNodeVectorAssets(node, pageWidth)
      if (exported.svg) info.svg = exported.svg
      if (exported.svgError) info.svgError = exported.svgError
      if (exported.png) info.png = exported.png
      if (exported.pngError) info.pngError = exported.pngError
      if (exported.pngByteLength) info.pngByteLength = exported.pngByteLength

      const bakedOk = !!(exported.png || exported.svg)
      const exportSize =
        exported.pngDesignSize ||
        (exported.svg ? readSvgDesignSize(exported.svg) : null)
      if (bakeVectorGroup && bakedOk) {
        info.flattened = true
        info.children = undefined
        info.childCount = 0
        info.exportInspectMode = applyInspectExportLayout(
          node,
          info.layout,
          pageWidth,
          exportSize,
          exported.pngVisualBounds,
        )
      } else if (bakedOk) {
        // 单矢量等：导出图为 AABB，坐标一并改为包围盒
        info.flattened = true
        info.exportInspectMode = applyInspectExportLayout(
          node,
          info.layout,
          pageWidth,
          exportSize,
          exported.pngVisualBounds,
        )
      }
    }

    const component = await getComponentInfo(node)
    if (component) info.component = component

    attachHtmlLayoutWarningMeta(node, info)

    return info
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: 'visible' in node ? node.visible : true,
      locked: 'locked' in node ? node.locked : false,
      layout: {x: 0, y: 0, width: 0, height: 0},
      styles: {},
      childCount: 0,
      children: undefined,
      // 保留失败信息，便于在 JSON 中排查单个节点
      component: {
        isInstance: false,
        mainComponentName: `serialize error: ${message}`,
      },
    }
  }
}

function collectImageHashes(
  nodes: NodeInfo[],
  hashes: Set<string> = new Set(),
): Set<string> {
  for (const node of nodes) {
    for (const paint of node.styles.fills || []) {
      if (paint.type === 'IMAGE' && paint.imageHash) {
        hashes.add(paint.imageHash)
      }
    }
    for (const paint of node.styles.strokes || []) {
      if (paint.type === 'IMAGE' && paint.imageHash) {
        hashes.add(paint.imageHash)
      }
    }
    if (node.children) collectImageHashes(node.children, hashes)
  }
  return hashes
}

/** FNV-1a，用于比对图片像素是否相同 */
function hashBytes(bytes: Uint8Array): string {
  let hash = 2166136261
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text)
  }
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff
  }
  return bytes
}

/**
 * 将 Instance 宽高归一化为逻辑尺寸键（同组件相近缩放可合并）。
 * 例：20×20 与 22×22 → 同为 `20_l_1`。
 */
function normalizeBakeSizeKey(width: number, height: number): string {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const step = BAKE_SIZE_NORMALIZE_STEP
  const longBucket = Math.max(step, Math.floor(long / step) * step)
  const ratio = Math.round((long / short) * 2) / 2
  const orient = w >= h ? 'l' : 'p'
  return `${longBucket}_${orient}_${ratio}`
}

/**
 * 矢量 PNG 池化 key：
 * - Instance（有主组件 id）→ `v:c` + hash(组件id + 归一化尺寸)
 * - 其余 → `v:` + 像素 contentHash
 */
function vectorAssetKey(node: NodeInfo, contentHash: string): string {
  const mainId = node.component?.mainComponentId
  if (node.component?.isInstance && typeof mainId === 'string' && mainId) {
    const sizeKey = normalizeBakeSizeKey(
      node.layout.width,
      node.layout.height,
    )
    const logical = hashBytes(encodeUtf8(`${mainId}\0${sizeKey}`))
    return `${VECTOR_IMAGE_PREFIX}c${logical}`
  }
  return `${VECTOR_IMAGE_PREFIX}${contentHash}`
}

function countImageFillReferences(nodes: NodeInfo[]): {
  perHash: Map<string, number>
  total: number
} {
  const perHash = new Map<string, number>()
  let total = 0

  const walk = (list: NodeInfo[]) => {
    for (const node of list) {
      for (const paint of [
        ...(node.styles.fills || []),
        ...(node.styles.strokes || []),
      ]) {
        if (paint.type === 'IMAGE' && paint.imageHash) {
          total += 1
          perHash.set(paint.imageHash, (perHash.get(paint.imageHash) || 0) + 1)
        }
      }
      if (node.children) walk(node.children)
    }
  }

  walk(nodes)
  return {perHash, total}
}

function isImageAssetWithData(
  asset: ImageAsset | undefined,
): asset is Extract<ImageAsset, {dataUrl: string}> {
  return Boolean(asset && 'dataUrl' in asset && asset.dataUrl)
}

/**
 * 相同像素只保留一份 dataUrl；其余记 duplicateOf。
 * 可识别「不同 imageHash、同一文件」的重复导入。
 */
function dedupeImagesByContent(images: Record<string, ImageAsset>): number {
  const byContent = new Map<string, string>()
  let merged = 0

  for (const key of Object.keys(images)) {
    if (key.startsWith('v:')) continue
    const asset = images[key]
    if (!isImageAssetWithData(asset)) continue

    const payload = asset.dataUrl.split(',')[1]
    if (!payload) continue
    const bytes = figma.base64Decode(payload)
    const contentHash = hashBytes(bytes)
    asset.contentHash = contentHash

    const primary = byContent.get(contentHash)
    if (primary && primary !== key) {
      images[key] = {
        duplicateOf: primary,
        contentHash,
        mime: asset.mime,
        byteLength: asset.byteLength,
        refCount: asset.refCount,
        source: asset.source,
      }
      merged += 1
    } else {
      byContent.set(contentHash, key)
    }
  }

  return merged
}

const VECTOR_IMAGE_PREFIX = 'v:'

/**
 * 矢量/标记 PNG 写入 images 池；节点只保留 pngRef。
 * Instance：按主组件 id + 归一化尺寸合并（相近缩放共用一张，保留更大像素）；
 * 其它：仍按像素 contentHash 去重。
 */
function poolVectorPngAssets(
  nodes: NodeInfo[],
  images: Record<string, ImageAsset>,
): {refs: number; unique: number} {
  let refs = 0

  const walk = (list: NodeInfo[]) => {
    for (const node of list) {
      if (node.png) {
        refs += 1
        const payload = node.png.replace(/^data:image\/png;base64,/, '')
        const bytes = figma.base64Decode(payload)
        const contentHash = hashBytes(bytes)
        const key = vectorAssetKey(node, contentHash)
        const source = node.exportAsImage ? 'marked' : 'vector'

        const existing = images[key]
        if (isImageAssetWithData(existing)) {
          existing.refCount = (existing.refCount || 1) + 1
          if (source === 'marked') existing.source = 'marked'
          // 同逻辑键保留更大图，HTML 用 layout 缩放
          if (bytes.length > (existing.byteLength || 0)) {
            existing.dataUrl = node.png
            existing.byteLength = bytes.length
            existing.contentHash = contentHash
          }
        } else {
          images[key] = {
            mime: 'image/png',
            dataUrl: node.png,
            byteLength: bytes.length,
            contentHash,
            source,
            refCount: 1,
          }
        }

        node.pngRef = key
        delete node.png
        delete node.pngByteLength
      }

      if (node.children) walk(node.children)
    }
  }

  walk(nodes)

  const unique = Object.keys(images).filter((k) =>
    k.startsWith(VECTOR_IMAGE_PREFIX),
  ).length
  return {refs, unique}
}

function countUniqueImageAssets(images: Record<string, ImageAsset>): number {
  return Object.values(images).filter((a) => isImageAssetWithData(a)).length
}

function applyImageRefCounts(
  images: Record<string, ImageAsset>,
  perHash: Map<string, number>,
): void {
  for (const [hash, count] of perHash) {
    const asset = images[hash]
    if (!asset || 'error' in asset) continue
    if ('duplicateOf' in asset) continue
    asset.refCount = count
    if (!asset.source) asset.source = 'fill'
  }
}

/** 本机/系统字体：不走 CDN，由浏览器 font-family 回退栈解析 */
function isSystemFontFamily(family: string): boolean {
  const f = family.toLowerCase()
  return (
    f.includes('sf pro') ||
    f.includes('sf compact') ||
    f.includes('sf mono') ||
    f.includes('new york') ||
    f.startsWith('.sf') ||
    f.includes('pingfang') ||
    f.includes('helvetica') ||
    f.includes('apple color emoji') ||
    f === 'system-ui'
  )
}

/**
 * Figma 字体名 → Google Fonts 族名。
 * 仅覆盖常见可公开拉取的字体；未列出的非系统字体会标为 unknown。
 */
const GOOGLE_FONT_FAMILY_MAP: {[figmaFamily: string]: string} = {
  PoetsenOne: 'Poetsen One',
  'Poetsen One': 'Poetsen One',
  Montserrat: 'Montserrat',
  Inter: 'Inter',
  Roboto: 'Roboto',
  'Open Sans': 'Open Sans',
  Lato: 'Lato',
  Poppins: 'Poppins',
  Nunito: 'Nunito',
  Raleway: 'Raleway',
  Outfit: 'Outfit',
  Manrope: 'Manrope',
  'Noto Sans': 'Noto Sans',
  'Noto Sans SC': 'Noto Sans SC',
}

function resolveFontProvider(family: string): FontRef['provider'] {
  if (isSystemFontFamily(family)) return 'system'
  if (GOOGLE_FONT_FAMILY_MAP[family]) return 'google'
  return 'unknown'
}

/** 从节点树收集去重字体（family+style） */
function collectFontsUsed(nodes: NodeInfo[]): FontRef[] {
  const map = new Map<string, FontRef>()

  const addFontRef = (
    fontName: FontName | undefined,
    fontWeight: number | undefined,
  ) => {
    if (!fontName?.family) return
    const style = fontName.style || 'Regular'
    const key = `${fontName.family}::${style}`
    if (!map.has(key)) {
      map.set(key, {
        family: fontName.family,
        style,
        weight: normalizeFontWeight(fontWeight),
        provider: resolveFontProvider(fontName.family),
      })
    }
  }

  const walk = (list: NodeInfo[]) => {
    for (const node of list) {
      if (node.visible !== false) {
        const text = node.styles?.text
        if (text) {
          addFontRef(text.fontName, text.fontWeight)
          for (const seg of text.segments || []) {
            addFontRef(seg.fontName, seg.fontWeight)
          }
        }
      }
      if (node.children) walk(node.children)
    }
  }

  walk(nodes)
  return Array.from(map.values()).sort((a, b) =>
    `${a.family}${a.style}`.localeCompare(`${b.family}${b.style}`),
  )
}

function detectImageMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'application/octet-stream'
}

function bytesToBase64(bytes: Uint8Array): string {
  return figma.base64Encode(bytes)
}

/**
 * 按 hash 去重导出图片为 Data URL。
 * 流程：getImageByHash → getBytesAsync → mime 探测 → base64
 * 约束：单图失败不中断整批；调用方可传 onProgress
 */
async function exportImagesByHash(
  hashes: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, ImageAsset>> {
  const images: Record<string, ImageAsset> = {}
  const total = hashes.length

  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i]
    onProgress?.(i + 1, total)
    try {
      const image = figma.getImageByHash(hash)
      if (!image) {
        images[hash] = {error: 'image not found for hash'}
        continue
      }
      const bytes = await image.getBytesAsync()
      const mime = detectImageMime(bytes)
      const base64 = bytesToBase64(bytes)
      images[hash] = {
        mime,
        dataUrl: `data:${mime};base64,${base64}`,
        byteLength: bytes.length,
        source: 'fill',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      images[hash] = {error: message}
    }
  }

  return images
}

let inspectGeneration = 0
/** 当前已导出树的根节点 id；画布选到其子节点时只同步高亮，不重读 */
let inspectedRootIds: string[] = []
/** UI 主动改选区时跳过 selectionchange 触发的整树重读 */
let suppressSelectionInspect = false
/** 锁定根节点：画布改选区时不更换节点树根 */
let rootLocked = false

const ROOT_LOCK_STORAGE_KEY = 'root-lock'

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== 'DOCUMENT' && node.type !== 'PAGE'
}

function isUnderInspectedRoots(node: BaseNode): boolean {
  if (inspectedRootIds.length === 0) return false
  let current: BaseNode | null = node
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (inspectedRootIds.includes(current.id)) return true
    current = current.parent
  }
  return false
}

function postSelectionSync(): void {
  figma.ui.postMessage({
    type: 'selection-sync',
    nodeIds: figma.currentPage.selection.map((n) => n.id),
  })
}

function postRootLockState(): void {
  figma.ui.postMessage({
    type: 'root-lock',
    locked: rootLocked,
  })
}

async function setRootLocked(locked: boolean): Promise<void> {
  rootLocked = Boolean(locked)
  void figma.clientStorage.setAsync(ROOT_LOCK_STORAGE_KEY, rootLocked)
  postRootLockState()
}

/**
 * 将画布选区切到指定节点（不触发整树重读）。
 * 副作用：selection、viewport、selection-sync 消息
 */
async function selectNodeById(nodeId: string): Promise<void> {
  await figma.currentPage.loadAsync()
  const node = await figma.getNodeByIdAsync(nodeId)
  if (!node || !isSceneNode(node)) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '节点不存在或已被删除',
      nodeId,
    })
    return
  }
  suppressSelectionInspect = true
  figma.currentPage.selection = [node]
  figma.viewport.scrollAndZoomIntoView([node])
  postSelectionSync()
  setTimeout(() => {
    suppressSelectionInspect = false
  }, 0)
}

/**
 * 选中当前节点的父节点。
 * 父节点仍在已导出树内 → 只改选区高亮；超出树根 → 以父节点为新树根重读。
 * 显式导航，不受根锁定影响。
 */
async function selectParentOfNode(nodeId: string): Promise<void> {
  await figma.currentPage.loadAsync()
  const node = await figma.getNodeByIdAsync(nodeId)
  if (!node || !isSceneNode(node)) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '节点不存在或已被删除',
      nodeId,
    })
    return
  }
  const parent = node.parent
  if (!parent || !isSceneNode(parent)) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '已是页面顶层，没有可选择的父节点',
      nodeId,
    })
    return
  }
  if (isUnderInspectedRoots(parent)) {
    await selectNodeById(parent.id)
    return
  }
  // 父节点超出当前树：更新树根为父节点
  suppressSelectionInspect = true
  figma.currentPage.selection = [parent]
  figma.viewport.scrollAndZoomIntoView([parent])
  // 先同步高亮，再重读，避免 result 仍按旧选中子节点保留
  postSelectionSync()
  try {
    await inspectNodes([parent])
  } finally {
    setTimeout(() => {
      suppressSelectionInspect = false
    }, 0)
  }
}

/**
 * 修改图层名称并回传 UI（不重导图片）。
 * 副作用：node.name、renamed / action-error 消息
 */
async function renameNodeById(nodeId: string, name: string): Promise<void> {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '名称不能为空',
      nodeId,
    })
    return
  }
  await figma.currentPage.loadAsync()
  const node = await figma.getNodeByIdAsync(nodeId)
  if (!node || !('name' in node)) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '节点不存在或不可重命名',
      nodeId,
    })
    return
  }
  node.name = trimmed
  figma.ui.postMessage({
    type: 'renamed',
    nodeId,
    name: node.name,
  })
}

/**
 * 从当前已导出树根重读（批量写操作后共用）。
 */
async function reinspectCurrentRoots(
  fallback?: SceneNode | null,
): Promise<void> {
  const roots: SceneNode[] = []
  for (const id of inspectedRootIds) {
    const root = await figma.getNodeByIdAsync(id)
    if (root && isSceneNode(root)) roots.push(root)
  }
  if (roots.length > 0) {
    await inspectNodes(roots)
    return
  }
  if (fallback) {
    await inspectNodes([fallback])
    return
  }
  await inspectSelection()
}

/**
 * 标记/取消「按图片导出」，写入 pluginData 后从当前树根重读。
 * 约束：不依赖画布当前选区（可能是子节点），避免丢掉整棵树
 */
async function setExportAsImageMark(
  nodeId: string,
  marked: boolean,
): Promise<void> {
  await setExportAsImageBatch([nodeId], marked)
}

/**
 * 批量标记/取消「按图片导出」，整批写完后只重读一次。
 * 标记为图片时清除 skipImageBake；取消标记时只清 exportAsImage。
 */
async function setExportAsImageBatch(
  nodeIds: string[],
  marked: boolean,
): Promise<void> {
  await figma.currentPage.loadAsync()
  let ok = 0
  let lastNode: SceneNode | null = null
  for (const nodeId of nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId)
    if (!node || !isSceneNode(node)) continue
    node.setPluginData(PLUGIN_DATA_EXPORT_AS_IMAGE, marked ? '1' : '')
    if (marked) {
      node.setPluginData(PLUGIN_DATA_SKIP_IMAGE_BAKE, '')
    }
    lastNode = node
    ok += 1
  }
  if (ok === 0) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '没有可标记的节点',
    })
    return
  }
  await reinspectCurrentRoots(lastNode)
}

/**
 * 标记/取消「非图片」：跳过自动切图并展开子层。
 * 开启时同时清除 exportAsImage。
 */
async function setSkipImageBakeBatch(
  nodeIds: string[],
  skip: boolean,
): Promise<void> {
  await figma.currentPage.loadAsync()
  let ok = 0
  let lastNode: SceneNode | null = null
  for (const nodeId of nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId)
    if (!node || !isSceneNode(node)) continue
    node.setPluginData(PLUGIN_DATA_SKIP_IMAGE_BAKE, skip ? '1' : '')
    if (skip) {
      node.setPluginData(PLUGIN_DATA_EXPORT_AS_IMAGE, '')
    }
    lastNode = node
    ok += 1
  }
  if (ok === 0) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '没有可标记的节点',
    })
    return
  }
  await reinspectCurrentRoots(lastNode)
}

/**
 * 批量设置图层可见性（Figma visible），写完后重读树。
 */
async function setNodesVisible(
  nodeIds: string[],
  visible: boolean,
): Promise<void> {
  await figma.currentPage.loadAsync()
  let ok = 0
  let lastNode: SceneNode | null = null
  for (const nodeId of nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId)
    if (!node || !isSceneNode(node)) continue
    node.visible = visible
    lastNode = node
    ok += 1
  }
  if (ok === 0) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '没有可设置可见性的节点',
    })
    return
  }
  await reinspectCurrentRoots(lastNode)
}

/**
 * 读取指定节点并回传 UI。
 * 流程：校验 → loading → 递归序列化 → 导出图片 → 回传结果
 * 约束：用 generation 丢弃过期的异步结果
 * 副作用：figma.ui.postMessage、inspectedRootIds
 */
async function inspectNodes(selection: SceneNode[]): Promise<void> {
  await imageExportSettingsReady
  const generation = ++inspectGeneration

  try {
    await figma.currentPage.loadAsync()

    if (selection.length === 0) {
      if (generation !== inspectGeneration) return
      inspectedRootIds = []
      figma.ui.postMessage({
        type: 'empty',
        message: '请先在画布中选中至少一个节点',
      })
      return
    }

    // 预创建 scratch，后续 full 切图 / 行高测量都挂在这里，避免当前页 Layers 闪烁
    getInspectScratchPage()

    figma.ui.postMessage({
      type: 'loading',
      message: `正在读取 ${selection.map((n) => n.name).join(', ')}（矢量 SVG+PNG）…`,
      selectedCount: selection.length,
    })

    const nodes: NodeInfo[] = []
    for (const node of selection) {
      const pageWidth = getNodeLayoutWidth(node) || 375
      const serialized = await serializeNode(node, {pageWidth})
      if (serialized) {
        attachRootRelativeCoords(serialized)
        nodes.push(serialized)
      }
      if (generation !== inspectGeneration) return
    }

    if (nodes.length === 0) {
      if (generation !== inspectGeneration) return
      inspectedRootIds = []
      figma.ui.postMessage({
        type: 'empty',
        message: '选中内容均为隐藏层，无可导出节点',
      })
      return
    }

    inspectedRootIds = nodes.map((n) => n.id)

    const hashes = Array.from(collectImageHashes(nodes))
    let images: Record<string, ImageAsset> = {}

    if (hashes.length > 0) {
      if (generation !== inspectGeneration) return
      figma.ui.postMessage({
        type: 'loading',
        message: `正在导出图片 0/${hashes.length}…`,
        selectedCount: selection.length,
      })

      images = await exportImagesByHash(hashes, (done, total) => {
        if (generation !== inspectGeneration) return
        figma.ui.postMessage({
          type: 'loading',
          message: `正在导出图片 ${done}/${total}…`,
          selectedCount: selection.length,
        })
      })
    }

    const fillRefs = countImageFillReferences(nodes)
    applyImageRefCounts(images, fillRefs.perHash)
    const mergedFillDupes = dedupeImagesByContent(images)
    const vectorPool = poolVectorPngAssets(nodes, images)

    if (generation !== inspectGeneration) return

    const totalCount = countNodes(nodes)
    const svgStats = countSvgNodes(nodes)
    const pngStats = countPngNodes(nodes)
    const fonts = collectFontsUsed(nodes)
    const imageUniqueCount = countUniqueImageAssets(images)
    const exportAsImageCount = countExportAsImageNodes(nodes)
    const htmlLayoutWarnings = collectHtmlLayoutWarnings(nodes)
    const data = {
      page: figma.currentPage.name,
      selectedCount: selection.length,
      totalNodeCount: totalCount,
      htmlLayoutWarningCount: htmlLayoutWarnings.length,
      htmlLayoutWarnings,
      imageCount: imageUniqueCount,
      /** 矢量/标记切图所用倍率（与配置「图片导出」一致） */
      imageExportScale: imageExportSettings.scale,
      imageFillRefCount: fillRefs.total,
      imageFillUniqueCount: hashes.length - mergedFillDupes,
      imageMergedDuplicateCount: mergedFillDupes,
      vectorPngRefCount: vectorPool.refs,
      vectorPngUniqueCount: vectorPool.unique,
      svgCount: svgStats.ok,
      svgErrorCount: svgStats.error,
      pngCount: pngStats.ok,
      pngErrorCount: pngStats.error,
      exportAsImageCount,
      fontCount: fonts.length,
      fonts,
      images,
      nodes,
    }

    // 大树用 JSON 字符串传递，避免 structured clone 对超大对象失败
    const payload = JSON.stringify(data)
    if (generation !== inspectGeneration) return
    figma.ui.postMessage({type: 'result', payload})
  } catch (error) {
    if (generation !== inspectGeneration) return
    const message = error instanceof Error ? error.message : String(error)
    figma.ui.postMessage({
      type: 'error',
      message: `读取失败：${message}`,
    })
  } finally {
    // 过期的 inspect 不清理（可能仍有进行中的序列化在用 scratch）
    if (generation === inspectGeneration) {
      disposeInspectScratchPage()
    }
  }
}

async function inspectSelection(): Promise<void> {
  await figma.currentPage.loadAsync()
  await inspectNodes(figma.currentPage.selection.slice())
}

function countNodes(nodes: NodeInfo[]): number {
  let count = 0
  for (const node of nodes) {
    count += 1
    if (node.children) count += countNodes(node.children)
  }
  return count
}

function countSvgNodes(nodes: NodeInfo[]): {ok: number; error: number} {
  let ok = 0
  let error = 0
  for (const node of nodes) {
    if (node.svg) ok += 1
    if (node.svgError) error += 1
    if (node.children) {
      const nested = countSvgNodes(node.children)
      ok += nested.ok
      error += nested.error
    }
  }
  return {ok, error}
}

function countPngNodes(nodes: NodeInfo[]): {ok: number; error: number} {
  let ok = 0
  let error = 0
  for (const node of nodes) {
    if (node.png || node.pngRef) ok += 1
    if (node.pngError && !node.png && !node.pngRef) error += 1
    if (node.children) {
      const nested = countPngNodes(node.children)
      ok += nested.ok
      error += nested.error
    }
  }
  return {ok, error}
}

function countExportAsImageNodes(nodes: NodeInfo[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.exportAsImage) count += 1
    if (node.children) count += countExportAsImageNodes(node.children)
  }
  return count
}

const UI_DEFAULT_SIZE = {width: 480, height: 800}
const UI_MIN_SIZE = {width: 360, height: 400}
const UI_MAX_SIZE = {width: 1600, height: 1200}
const UI_SIZE_STORAGE_KEY = 'ui-window-size'
const IMAGE_EXPORT_SETTINGS_KEY = 'image-export-settings'
/** 导出相关偏好（原稿对比等）；兼容读取旧键 codegen-settings */
const EXPORT_SETTINGS_KEY = 'export-settings'
const LEGACY_CODEGEN_SETTINGS_KEY = 'codegen-settings'

type ImageExportFormat = 'PNG' | 'JPG' | 'SVG'
type ImageExportSettings = {
  scale: number
  format: ImageExportFormat
}
type ExportSettings = {
  /** ZIP 是否附带 design.png 与 contrast.html（默认 true） */
  includeDesignPreview: boolean
}

const DEFAULT_IMAGE_EXPORT_SETTINGS: ImageExportSettings = {
  scale: 2,
  format: 'PNG',
}

const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  includeDesignPreview: true,
}

let imageExportSettings: ImageExportSettings = {
  ...DEFAULT_IMAGE_EXPORT_SETTINGS,
}

let resolveImageExportSettingsReady: (() => void) | null = null
const imageExportSettingsReady = new Promise<void>((resolve) => {
  resolveImageExportSettingsReady = resolve
})

let exportSettings: ExportSettings = {
  ...DEFAULT_EXPORT_SETTINGS,
}

function clampImageScale(scale: number): number {
  if (scale === 3 || scale === 2 || scale === 1) return scale
  if (scale === 0.5) return 0.5
  return DEFAULT_IMAGE_EXPORT_SETTINGS.scale
}

function normalizeImageExportSettings(raw: unknown): ImageExportSettings {
  if (!raw || typeof raw !== 'object') {
    return {...DEFAULT_IMAGE_EXPORT_SETTINGS}
  }
  const obj = raw as {scale?: unknown; format?: unknown}
  const format =
    obj.format === 'JPG' || obj.format === 'SVG' || obj.format === 'PNG'
      ? obj.format
      : DEFAULT_IMAGE_EXPORT_SETTINGS.format
  const scale =
    typeof obj.scale === 'number'
      ? clampImageScale(obj.scale)
      : DEFAULT_IMAGE_EXPORT_SETTINGS.scale
  return {scale, format}
}

function normalizeExportSettings(raw: unknown): ExportSettings {
  if (!raw || typeof raw !== 'object') {
    return {...DEFAULT_EXPORT_SETTINGS}
  }
  const obj = raw as {includeDesignPreview?: unknown}
  const includeDesignPreview =
    typeof obj.includeDesignPreview === 'boolean'
      ? obj.includeDesignPreview
      : DEFAULT_EXPORT_SETTINGS.includeDesignPreview
  return {includeDesignPreview}
}

function sanitizeExportFilename(name: string, fallback: string): string {
  const cleaned = String(name || fallback || 'export')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return cleaned || fallback || 'export'
}

/**
 * 按设置导出节点为图片文件（类 Figma Export），回传 UI 下载。
 */
async function exportNodesAsImageFiles(
  nodeIds: string[],
  settings?: Partial<ImageExportSettings>,
): Promise<void> {
  await figma.currentPage.loadAsync()
  const cfg = normalizeImageExportSettings({
    ...imageExportSettings,
    ...(settings || {}),
  })
  imageExportSettings = cfg

  const ids = (nodeIds || []).filter(Boolean)
  if (ids.length === 0) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '没有可导出的节点',
    })
    return
  }

  figma.ui.postMessage({
    type: 'image-export-progress',
    message: `正在导出图片 0/${ids.length}…`,
  })

  const files: Array<{
    name: string
    mime: string
    base64: string
  }> = []

  for (let i = 0; i < ids.length; i++) {
    figma.ui.postMessage({
      type: 'image-export-progress',
      message: `正在导出图片 ${i + 1}/${ids.length}…`,
    })
    const node = await figma.getNodeByIdAsync(ids[i])
    if (!node || !isSceneNode(node)) continue

    try {
      let bytes: Uint8Array
      let mime: string
      let ext: string

      if (cfg.format === 'SVG') {
        bytes = await node.exportAsync({format: 'SVG'})
        mime = 'image/svg+xml'
        ext = 'svg'
      } else if (cfg.format === 'JPG') {
        bytes = await node.exportAsync({
          format: 'JPG',
          constraint: {type: 'SCALE', value: cfg.scale},
        })
        mime = 'image/jpeg'
        ext = 'jpg'
      } else {
        bytes = await node.exportAsync({
          format: 'PNG',
          constraint: {type: 'SCALE', value: cfg.scale},
        })
        mime = 'image/png'
        ext = 'png'
      }

      const base = sanitizeExportFilename(node.name, `node-${i + 1}`)
      const scaleSuffix =
        cfg.format === 'SVG' || cfg.scale === 1 ? '' : `@${cfg.scale}x`
      files.push({
        name: `${base}${scaleSuffix}.${ext}`,
        mime,
        base64: figma.base64Encode(bytes),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      figma.ui.postMessage({
        type: 'action-error',
        message: `导出失败（${node.name}）：${message}`,
        nodeId: node.id,
      })
    }
  }

  if (files.length === 0) {
    figma.ui.postMessage({
      type: 'action-error',
      message: '没有成功导出的图片',
    })
    return
  }

  figma.ui.postMessage({
    type: 'image-export-result',
    files,
    scale: cfg.scale,
    format: cfg.format,
  })
}

/**
 * 导出根节点原稿 PNG，供 ZIP 内 contrast.html 对比页使用。
 */
async function exportDesignPreview(
  nodeIds: string[],
  scale?: number,
): Promise<void> {
  await figma.currentPage.loadAsync()
  const ids = (nodeIds || []).filter(Boolean)
  if (ids.length === 0) {
    figma.ui.postMessage({
      type: 'design-preview-result',
      error: '没有可导出的根节点',
    })
    return
  }

  const safeScale = clampImageScale(
    typeof scale === 'number' ? scale : imageExportSettings.scale,
  )

  figma.ui.postMessage({
    type: 'design-preview-progress',
    message: '正在导出原稿 PNG…',
  })

  try {
    const node = await figma.getNodeByIdAsync(ids[0])
    if (!node || !isSceneNode(node)) {
      figma.ui.postMessage({
        type: 'design-preview-result',
        error: '根节点不存在或已被删除',
      })
      return
    }

    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: {type: 'SCALE', value: safeScale},
    })

    figma.ui.postMessage({
      type: 'design-preview-result',
      file: {
        name: 'design.png',
        mime: 'image/png',
        base64: figma.base64Encode(bytes),
        scale: safeScale,
        nodeId: node.id,
        nodeName: node.name,
        width: 'width' in node ? node.width : undefined,
        height: 'height' in node ? node.height : undefined,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    figma.ui.postMessage({
      type: 'design-preview-result',
      error: `原稿导出失败：${message}`,
    })
  }
}

function clampUiSize(
  width: number,
  height: number,
): {width: number; height: number} {
  return {
    width: Math.min(
      UI_MAX_SIZE.width,
      Math.max(UI_MIN_SIZE.width, Math.round(width)),
    ),
    height: Math.min(
      UI_MAX_SIZE.height,
      Math.max(UI_MIN_SIZE.height, Math.round(height)),
    ),
  }
}

figma.showUI(__html__, {
  width: UI_DEFAULT_SIZE.width,
  height: UI_DEFAULT_SIZE.height,
  themeColors: true,
})

void figma.clientStorage.getAsync(UI_SIZE_STORAGE_KEY).then((saved) => {
  if (
    !saved ||
    typeof saved !== 'object' ||
    typeof (saved as {width?: unknown}).width !== 'number' ||
    typeof (saved as {height?: unknown}).height !== 'number'
  ) {
    return
  }
  const size = clampUiSize(
    (saved as {width: number}).width,
    (saved as {height: number}).height,
  )
  figma.ui.resize(size.width, size.height)
})

/** 确保首轮 inspect 前已读到本地倍率配置 */
void figma.clientStorage
  .getAsync(IMAGE_EXPORT_SETTINGS_KEY)
  .then((saved) => {
    imageExportSettings = normalizeImageExportSettings(saved)
    figma.ui.postMessage({
      type: 'image-export-settings',
      settings: imageExportSettings,
    })
  })
  .catch(() => {
    /* 保持默认倍率 */
  })
  .then(() => {
    resolveImageExportSettingsReady?.()
    resolveImageExportSettingsReady = null
  })

void figma.clientStorage
  .getAsync(EXPORT_SETTINGS_KEY)
  .then(async (saved) => {
    if (saved == null) {
      return figma.clientStorage.getAsync(LEGACY_CODEGEN_SETTINGS_KEY)
    }
    return saved
  })
  .then((saved) => {
    exportSettings = normalizeExportSettings(saved)
    figma.ui.postMessage({
      type: 'export-settings',
      settings: exportSettings,
    })
  })
  .catch(() => {
    /* 保持默认 */
  })

void figma.clientStorage.getAsync(ROOT_LOCK_STORAGE_KEY).then((saved) => {
  rootLocked = saved === true
  postRootLockState()
})

type UiMessage =
  | {type: 'ready' | 'inspect' | 'close'}
  | {type: 'select-node'; nodeId: string}
  | {type: 'select-parent'; nodeId: string}
  | {type: 'rename-node'; nodeId: string; name: string}
  | {type: 'set-export-as-image'; nodeId: string; marked: boolean}
  | {type: 'set-export-as-image-batch'; nodeIds: string[]; marked: boolean}
  | {type: 'set-skip-image-bake'; nodeId: string; skip: boolean}
  | {type: 'set-skip-image-bake-batch'; nodeIds: string[]; skip: boolean}
  | {type: 'set-visible-batch'; nodeIds: string[]; visible: boolean}
  | {type: 'set-root-lock'; locked: boolean}
  | {type: 'resize'; width: number; height: number}
  | {
      type: 'set-image-export-settings'
      scale?: number
      format?: ImageExportFormat
    }
  | {
      type: 'set-export-settings'
      includeDesignPreview?: boolean
    }
  | {
      type: 'export-as-image'
      nodeIds: string[]
      scale?: number
      format?: ImageExportFormat
    }
  | {
      type: 'export-design-preview'
      nodeIds: string[]
      scale?: number
    }

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'resize') {
    const size = clampUiSize(msg.width, msg.height)
    figma.ui.resize(size.width, size.height)
    void figma.clientStorage.setAsync(UI_SIZE_STORAGE_KEY, size)
    return
  }
  if (msg.type === 'set-image-export-settings') {
    const prevScale = imageExportSettings.scale
    imageExportSettings = normalizeImageExportSettings({
      ...imageExportSettings,
      scale: msg.scale,
      format: msg.format,
    })
    void figma.clientStorage.setAsync(
      IMAGE_EXPORT_SETTINGS_KEY,
      imageExportSettings,
    )
    figma.ui.postMessage({
      type: 'image-export-settings',
      settings: imageExportSettings,
    })
    // 倍率变化需重切矢量/标记 PNG，否则 ZIP/HTML 仍是旧倍率
    if (prevScale !== imageExportSettings.scale) {
      if (rootLocked && inspectedRootIds.length > 0) {
        await reinspectCurrentRoots()
      } else {
        await inspectSelection()
      }
    }
    return
  }
  if (msg.type === 'set-export-settings') {
    exportSettings = normalizeExportSettings({
      ...exportSettings,
      includeDesignPreview: msg.includeDesignPreview,
    })
    void figma.clientStorage.setAsync(EXPORT_SETTINGS_KEY, exportSettings)
    figma.ui.postMessage({
      type: 'export-settings',
      settings: exportSettings,
    })
    return
  }
  if (msg.type === 'export-as-image') {
    await exportNodesAsImageFiles(msg.nodeIds || [], {
      scale: msg.scale,
      format: msg.format,
    })
    return
  }
  if (msg.type === 'export-design-preview') {
    await exportDesignPreview(msg.nodeIds || [], msg.scale)
    return
  }
  if (msg.type === 'set-root-lock') {
    await setRootLocked(msg.locked)
    return
  }
  if (msg.type === 'ready' || msg.type === 'inspect') {
    figma.ui.postMessage({
      type: 'image-export-settings',
      settings: imageExportSettings,
    })
    figma.ui.postMessage({
      type: 'export-settings',
      settings: exportSettings,
    })
    postRootLockState()
    if (msg.type === 'inspect' && rootLocked && inspectedRootIds.length > 0) {
      await reinspectCurrentRoots()
    } else {
      await inspectSelection()
    }
  }
  if (msg.type === 'select-node') {
    await selectNodeById(msg.nodeId)
  }
  if (msg.type === 'select-parent') {
    await selectParentOfNode(msg.nodeId)
  }
  if (msg.type === 'rename-node') {
    await renameNodeById(msg.nodeId, msg.name)
  }
  if (msg.type === 'set-export-as-image') {
    await setExportAsImageMark(msg.nodeId, msg.marked)
  }
  if (msg.type === 'set-export-as-image-batch') {
    await setExportAsImageBatch(msg.nodeIds || [], msg.marked)
  }
  if (msg.type === 'set-skip-image-bake') {
    await setSkipImageBakeBatch([msg.nodeId], msg.skip)
  }
  if (msg.type === 'set-skip-image-bake-batch') {
    await setSkipImageBakeBatch(msg.nodeIds || [], msg.skip)
  }
  if (msg.type === 'set-visible-batch') {
    await setNodesVisible(msg.nodeIds || [], msg.visible)
  }
  if (msg.type === 'close') {
    figma.closePlugin()
  }
}

figma.on('selectionchange', () => {
  if (suppressSelectionInspect) return

  const selection = figma.currentPage.selection
  // 锁定根节点：任意选区变化都只同步高亮，不更换树根
  if (rootLocked && inspectedRootIds.length > 0) {
    postSelectionSync()
    return
  }
  // 选中已导出树内的子节点：只同步高亮，避免丢掉整棵树
  if (
    selection.length > 0 &&
    inspectedRootIds.length > 0 &&
    selection.every((n) => isUnderInspectedRoots(n))
  ) {
    postSelectionSync()
    return
  }

  void inspectSelection()
})
