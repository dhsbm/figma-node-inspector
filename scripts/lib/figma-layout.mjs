/**
 * Figma 导出 JSON → 布局/样式公共逻辑（HTML 生成与面板预览共用）。
 */

import {resolveLineHeightCssValue} from './figma-line-height.mjs'
import {localOffsetInParent} from './root-relative-layout.mjs'

/** Figma 中不建立本地坐标系的容器：子节点 x/y 与自身同属父级空间 */
const FLAT_COORD_TYPES = new Set(['GROUP', 'BOOLEAN_OPERATION'])

/**
 * 与 HTML localOffset 一致：子节点在父盒内的 left/top。
 */
function localOffsetForMeasure(node, parent) {
  return localOffsetInParent(node, parent)
}

/**
 * 根坐标系下内容包围盒（含子层负偏移，如外侧描边胀出的切图）。
 */
export function measureRootContentBounds(root) {
  const rootW = root?.layout?.width || 0
  const rootH = root?.layout?.height || 0
  const bounds = {minX: 0, minY: 0, maxX: rootW, maxY: rootH}

  function visit(node, parent, originX, originY) {
    if (!node || node.visible === false) return
    let x = 0
    let y = 0
    if (!parent) {
      x = 0
      y = 0
    } else {
      const {left, top} = localOffsetForMeasure(node, parent)
      x = originX + left
      y = originY + top
    }
    const w = node.layout?.width || 0
    const h = node.layout?.height || 0
    bounds.minX = Math.min(bounds.minX, x)
    bounds.minY = Math.min(bounds.minY, y)
    bounds.maxX = Math.max(bounds.maxX, x + w)
    bounds.maxY = Math.max(bounds.maxY, y + h)

    if (node.flattened) return
    for (const child of node.children || []) {
      visit(child, node, x, y)
    }
  }

  visit(root, null, 0, 0)
  return bounds
}

/**
 * 若子层溢出根 AABB（常见：外侧描边切图），计算画布扩容与平移。
 */
export function contentOverflowPad(root) {
  const b = measureRootContentBounds(root)
  const rootW = root?.layout?.width || 0
  const rootH = root?.layout?.height || 0
  const padLeft = Math.max(0, round(-b.minX))
  const padTop = Math.max(0, round(-b.minY))
  const canvasWidth = round(b.maxX - Math.min(0, b.minX))
  const canvasHeight = round(b.maxY - Math.min(0, b.minY))
  const needed =
    padLeft > 0.01 ||
    padTop > 0.01 ||
    canvasWidth > rootW + 0.01 ||
    canvasHeight > rootH + 0.01
  return {
    needed,
    padLeft,
    padTop,
    canvasWidth: needed ? Math.max(canvasWidth, rootW) : rootW,
    canvasHeight: needed ? Math.max(canvasHeight, rootH) : rootH,
  }
}

/**
 * 把渲染好的根 HTML 包进扩容画布，避免负坐标描边被父级/对比框裁切。
 */
export function wrapHtmlForContentOverflow(bodyHtml, root, uxFn = (n) => `${round(n)}px`) {
  const pad = contentOverflowPad(root)
  if (!pad.needed) {
    return {
      body: bodyHtml,
      canvasWidth: root?.layout?.width || 0,
      canvasHeight: root?.layout?.height || 0,
      pad,
    }
  }
  const rootW = root?.layout?.width || 0
  const rootH = root?.layout?.height || 0
  const wrapped = `<div style="width:${uxFn(pad.canvasWidth)};height:${uxFn(pad.canvasHeight)};box-sizing:border-box;position:relative;overflow:visible"><div style="position:absolute;left:${uxFn(pad.padLeft)};top:${uxFn(pad.padTop)};width:${uxFn(rootW)};height:${uxFn(rootH)};box-sizing:border-box">${bodyHtml}</div></div>`
  return {
    body: wrapped,
    canvasWidth: pad.canvasWidth,
    canvasHeight: pad.canvasHeight,
    pad,
  }
}

export function round(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0
  return Math.round(n * 1000) / 1000
}

/** CSS 无法把 linear-gradient 当作 border-color */
function cssLooksLikeGradient(value) {
  return typeof value === 'string' && value.includes('gradient(')
}

function solidColorAsGradientLayer(color) {
  return `linear-gradient(${color}, ${color})`
}

/**
 * CSS font-weight 下限 400。
 * PingFang SC Regular 等在 Figma 常报 300，直接透传会偏细。
 */
export const MIN_CSS_FONT_WEIGHT = 400

export function cssFontWeight(weight) {
  if (typeof weight !== 'number' || Number.isNaN(weight) || weight <= 0) {
    return null
  }
  return Math.max(MIN_CSS_FONT_WEIGHT, Math.round(weight))
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 解析 images 条目，跟随 duplicateOf 指向唯一像素资源。
 * @param {Record<string, object>} images
 * @param {string} key
 */
export function resolveImageAsset(images, key) {
  if (!key || !images) return null
  const seen = new Set()
  let k = key
  while (k && images[k] && !seen.has(k)) {
    seen.add(k)
    const asset = images[k]
    if (asset.error) return null
    if (asset.duplicateOf) {
      k = asset.duplicateOf
      continue
    }
    if (asset.dataUrl) return asset
    return null
  }
  return null
}

/** 矢量节点 png / pngRef → dataUrl */
export function resolveNodePng(node, images) {
  if (node.png) return node.png
  if (node.pngRef)
    return resolveImageAsset(images, node.pngRef)?.dataUrl || null
  return null
}

/** 格式化 CSS 渐变 stop 百分比 */
function formatGradientStopPercent(value) {
  return Number((value * 100).toFixed(2)).toString()
}

function inverseTransform2x3(matrix) {
  const [a, c, e] = matrix[0]
  const [b, d, f] = matrix[1]
  const det = a * d - b * c
  if (Math.abs(det) < 1e-6) return null
  const invDet = 1 / det
  return [
    [d * invDet, -c * invDet, (c * f - d * e) * invDet],
    [-b * invDet, a * invDet, (b * e - a * f) * invDet],
  ]
}

function applyTransform2x3(matrix, x, y) {
  return {
    x: matrix[0][0] * x + matrix[0][1] * y + matrix[0][2],
    y: matrix[1][0] * x + matrix[1][1] * y + matrix[1][2],
  }
}

function projectPointOntoLine(point, lineStart, lineEnd) {
  const lineVecX = lineEnd.x - lineStart.x
  const lineVecY = lineEnd.y - lineStart.y
  const pointVecX = point.x - lineStart.x
  const pointVecY = point.y - lineStart.y
  const lineLengthSq = lineVecX ** 2 + lineVecY ** 2
  if (lineLengthSq < 1e-6) return {...lineStart}
  const projectionRatio =
    (pointVecX * lineVecX + pointVecY * lineVecY) / lineLengthSq
  return {
    x: lineStart.x + lineVecX * projectionRatio,
    y: lineStart.y + lineVecY * projectionRatio,
  }
}

/**
 * Figma gradientTransform → CSS linear-gradient。
 * 参考 Figma 标准句柄 (0,0.5)→(1,0.5)，将 stop 映射到 CSS 渐变线。
 */
export function linearGradientPaintToCss(paint, width, height) {
  if (!paint?.stops?.length) return null
  if (paint.stops.length === 1) return paint.stops[0].color

  const w = typeof width === 'number' && width > 0 ? width : 100
  const h = typeof height === 'number' && height > 0 ? height : 100
  const transform = paint.gradientTransform

  if (!transform || transform.length !== 2) {
    const angle = paint.cssAngle ?? 180
    const stops = paint.stops
      .map((s) => `${s.color} ${formatGradientStopPercent(s.position)}%`)
      .join(', ')
    return `linear-gradient(${angle}deg, ${stops})`
  }

  const inverse = inverseTransform2x3(transform)
  if (!inverse) {
    const angle = paint.cssAngle ?? 180
    const stops = paint.stops
      .map((s) => `${s.color} ${formatGradientStopPercent(s.position)}%`)
      .join(', ')
    return `linear-gradient(${angle}deg, ${stops})`
  }

  const normalizedStart = applyTransform2x3(inverse, 0, 0.5)
  const normalizedEnd = applyTransform2x3(inverse, 1, 0.5)
  const figmaStart = {
    x: normalizedStart.x * w,
    y: normalizedStart.y * h,
  }
  const figmaEnd = {
    x: normalizedEnd.x * w,
    y: normalizedEnd.y * h,
  }

  const dx = figmaEnd.x - figmaStart.x
  const dy = figmaEnd.y - figmaStart.y
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return paint.stops[0].color

  let cssAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
  cssAngleDeg = ((cssAngleDeg % 360) + 360) % 360
  if (cssAngleDeg === 360) cssAngleDeg = 0

  const mathAngleRad = (cssAngleDeg * Math.PI) / 180
  const cssGradientLength =
    Math.abs(w * Math.sin(mathAngleRad)) + Math.abs(h * Math.cos(mathAngleRad))
  const center = {x: w / 2, y: h / 2}
  const lineAngleRad = ((cssAngleDeg - 90) * Math.PI) / 180
  const half = cssGradientLength / 2
  const cssStart = {
    x: center.x - half * Math.cos(lineAngleRad),
    y: center.y - half * Math.sin(lineAngleRad),
  }
  const cssEnd = {
    x: center.x + half * Math.cos(lineAngleRad),
    y: center.y + half * Math.sin(lineAngleRad),
  }

  const cssVecX = cssEnd.x - cssStart.x
  const cssVecY = cssEnd.y - cssStart.y
  const cssLength = Math.hypot(cssVecX, cssVecY)
  if (cssLength < 1e-6) return paint.stops[0].color

  const mappedStops = paint.stops.map((stop) => {
    const figmaPoint = {
      x: figmaStart.x + (figmaEnd.x - figmaStart.x) * stop.position,
      y: figmaStart.y + (figmaEnd.y - figmaStart.y) * stop.position,
    }
    const projected = projectPointOntoLine(figmaPoint, cssStart, cssEnd)
    const projectedVecX = projected.x - cssStart.x
    const projectedVecY = projected.y - cssStart.y
    const dotProduct = projectedVecX * cssVecX + projectedVecY * cssVecY
    const projectedLength = Math.hypot(projectedVecX, projectedVecY)
    const signedDistance = Math.sign(dotProduct || 1) * projectedLength
    return {
      color: stop.color,
      position: signedDistance / cssLength,
    }
  })

  const stops = mappedStops
    .map((s) => `${s.color} ${formatGradientStopPercent(s.position)}%`)
    .join(', ')
  return `linear-gradient(${Math.round(cssAngleDeg)}deg, ${stops})`
}

/**
 * @param {Record<string, {dataUrl?: string}>} [imageMap]
 * @param {object} [options]
 */
export function createFigmaLayout(imageMap = {}, options = {}) {
  const images = imageMap
  void options

  /** 设计稿长度（px）→ CSS px */
  function ux(pxValue) {
    return `${round(pxValue)}px`
  }

  function visiblePaints(paints = []) {
    return paints.filter((p) => p && p.visible !== false)
  }

  function paintBackground(paint, width, height) {
    if (!paint) return null
    if (paint.type === 'SOLID') {
      return paint.color
    }
    if (paint.type === 'GRADIENT_LINEAR' && paint.stops?.length) {
      return linearGradientPaintToCss(paint, width, height)
    }
    if (paint.type === 'GRADIENT_RADIAL' && paint.stops?.length) {
      const stops = paint.stops
        .map((s) => `${s.color} ${round(s.position * 100)}%`)
        .join(', ')
      return `radial-gradient(circle, ${stops})`
    }
    if (paint.type === 'IMAGE' && paint.imageHash) {
      const asset = resolveImageAsset(images, paint.imageHash)
      if (asset?.dataUrl) {
        const placement = imagePlacementFromPaint(paint, width, height)
        return {
          image: asset.dataUrl,
          size: placement.size,
          position: placement.position,
          repeat: placement.repeat,
        }
      }
    }
    return null
  }

  /**
   * Figma fills/strokes：数组靠前 = 底层，靠后 = 顶层（与 children 一致）。
   * CSS background-image：列表靠前 = 顶层。转换时需反转。
   */
  function topmostBackground(paints, width, height) {
    const visible = visiblePaints(paints)
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const bg = paintBackground(visible[i], width, height)
      if (bg) return bg
    }
    return null
  }

  /**
   * 非位图填充层（SOLID / 渐变）→ CSS background-image 列表（顶层在前）。
   * 实色转成同色 linear-gradient，便于与渐变叠层。
   */
  function colorBackgroundLayers(paints, width, height) {
    const layers = []
    for (const paint of visiblePaints(paints)) {
      const bg = paintBackground(paint, width, height)
      if (!bg || typeof bg !== 'string') continue
      if (bg.includes('gradient(')) {
        layers.push(bg)
      } else {
        layers.push(`linear-gradient(${bg}, ${bg})`)
      }
    }
    // Figma 底层→顶层，CSS 要顶层在前
    return layers.reverse()
  }

  function imageBackgrounds(paints, width, height) {
    return visiblePaints(paints)
      .map((paint) => paintBackground(paint, width, height))
      .filter((bg) => bg && typeof bg === 'object' && bg.image)
      .reverse()
  }

  /**
   * Figma IMAGE scaleMode / imageTransform → CSS background-size/position。
   *
   * CROP 的 imageTransform [[a,c,e],[b,d,f]] 把节点归一化坐标映到图片归一化坐标：
   * 无旋转时节点显示图片区域 [e, e+a] × [f, f+d]。
   * 用像素 background-size/position 精确还原，避免 cover+近似 position 裁错。
   */
  function imagePlacementFromPaint(paint, width, height) {
    const scaleMode = paint.scaleMode || 'FILL'
    if (scaleMode === 'FIT') {
      return {size: 'contain', position: 'center', repeat: 'no-repeat'}
    }
    if (scaleMode === 'TILE') {
      const factor =
        typeof paint.scalingFactor === 'number' && paint.scalingFactor > 0
          ? paint.scalingFactor
          : 1
      // TILE 无天然像素时用 auto；有 scalingFactor 时仍交给浏览器按图固有尺寸缩放
      return {
        size: factor === 1 ? 'auto' : `${round(factor * 100)}%`,
        position: '0 0',
        repeat: 'repeat',
      }
    }
    if (scaleMode !== 'CROP') {
      return {size: 'cover', position: 'center', repeat: 'no-repeat'}
    }

    const transform = paint.imageTransform
    const w = typeof width === 'number' && width > 0 ? width : 0
    const h = typeof height === 'number' && height > 0 ? height : 0
    if (!Array.isArray(transform) || transform.length < 2 || !w || !h) {
      return {size: 'cover', position: 'center', repeat: 'no-repeat'}
    }

    const a = transform[0]?.[0]
    const c = transform[0]?.[1] || 0
    const e = transform[0]?.[2]
    const b = transform[1]?.[0] || 0
    const d = transform[1]?.[1]
    const f = transform[1]?.[2]
    const axisAligned =
      typeof a === 'number' &&
      typeof d === 'number' &&
      typeof e === 'number' &&
      typeof f === 'number' &&
      Math.abs(a) > 1e-6 &&
      Math.abs(d) > 1e-6 &&
      Math.abs(b) < 1e-4 &&
      Math.abs(c) < 1e-4

    if (axisAligned) {
      const sizeW = w / a
      const sizeH = h / d
      const posX = -e * sizeW
      const posY = -f * sizeH
      return {
        size: `${ux(round(sizeW))} ${ux(round(sizeH))}`,
        position: `${ux(round(posX))} ${ux(round(posY))}`,
        repeat: 'no-repeat',
      }
    }

    // 含旋转/斜切时 background 无法完整表达，退回 cover
    return {size: 'cover', position: 'center', repeat: 'no-repeat'}
  }

  /**
   * @param {object[]} effects
   * @param {{skipInnerShadow?: boolean, useDropShadowFilter?: boolean}} [opts]
   * skipInnerShadow：节点已切 PNG（内阴影已烘焙进像素），勿再写 inset。
   * useDropShadowFilter：透明容器 / `<img>` / 文字等应按 alpha 投影，
   * 用 filter:drop-shadow，避免 box-shadow 画出矩形「色块」。
   */
  function shadowCss(effects = [], opts = {}) {
    const boxParts = []
    const dropFilters = []
    for (const e of effects) {
      if (!e || e.visible === false) continue
      if (e.type === 'INNER_SHADOW') {
        if (opts.skipInnerShadow) continue
        const x = round(e.offset?.x || 0)
        const y = round(e.offset?.y || 0)
        const blur = round(e.radius || 0)
        const spread = round(e.spread || 0)
        boxParts.push(
          `inset ${ux(x)} ${ux(y)} ${ux(blur)} ${ux(spread)} ${e.color || '#000'}`,
        )
        continue
      }
      if (e.type !== 'DROP_SHADOW') continue
      const x = round(e.offset?.x || 0)
      const y = round(e.offset?.y || 0)
      const blur = round(e.radius || 0)
      const spread = round(e.spread || 0)
      const color = e.color || '#000'
      if (opts.useDropShadowFilter) {
        // drop-shadow 无 spread；有扩散时并入 blur 近似
        const filterBlur = spread > 0 ? round(blur + spread) : blur
        dropFilters.push(
          `drop-shadow(${ux(x)} ${ux(y)} ${ux(filterBlur)} ${color})`,
        )
      } else {
        boxParts.push(
          `${ux(x)} ${ux(y)} ${ux(blur)} ${ux(spread)} ${color}`,
        )
      }
    }
    return {
      boxShadow: boxParts.length ? boxParts.join(', ') : null,
      dropFilters,
    }
  }

  /** 投影应按内容 alpha 而非盒子矩形 */
  function shouldUseDropShadowFilter(node, styles, visualBaked) {
    if (
      visualBaked ||
      node.png ||
      node.pngRef ||
      node.svg ||
      node.svgRef ||
      node.flattened
    ) {
      return true
    }
    if (
      node.type === 'GROUP' ||
      node.type === 'BOOLEAN_OPERATION' ||
      node.type === 'TEXT'
    ) {
      return true
    }
    return visiblePaints(styles.fills).length === 0
  }

  /** 用一圈 text-shadow 近似文字描边（兼容无 paint-order 的环境） */
  function textStrokeShadow(color, weight) {
    const w = round(weight)
    if (!color || w <= 0) return null
    const offsets = [
      [-w, 0],
      [w, 0],
      [0, -w],
      [0, w],
      [-w, -w],
      [w, -w],
      [-w, w],
      [w, w],
    ]
    return offsets.map(([x, y]) => `${ux(x)} ${ux(y)} 0 ${color}`).join(', ')
  }

  /** Figma blur radius ≈ 2 × CSS filter blur 标准差 */
  function blurFilters(effects = []) {
    const layer = []
    const backdrop = []
    for (const e of effects) {
      if (!e || e.visible === false) continue
      const r = round((e.radius || 0) / 2)
      if (r <= 0) continue
      if (e.type === 'LAYER_BLUR') layer.push(`blur(${ux(r)})`)
      if (e.type === 'BACKGROUND_BLUR') backdrop.push(`blur(${ux(r)})`)
    }
    return {
      filter: layer.length ? layer.join(' ') : null,
      backdrop: backdrop.length ? backdrop.join(' ') : null,
    }
  }

  function radiusCss(styles = {}, nodeType) {
    if (nodeType === 'ELLIPSE') return '50%'
    const tl = styles.topLeftRadius
    const tr = styles.topRightRadius
    const br = styles.bottomRightRadius
    const bl = styles.bottomLeftRadius
    if (
      [tl, tr, br, bl].every((v) => typeof v === 'number') &&
      (tl !== tr || tr !== br || br !== bl)
    ) {
      return `${ux(tl)} ${ux(tr)} ${ux(br)} ${ux(bl)}`
    }
    if (typeof styles.cornerRadius === 'number' && styles.cornerRadius > 0) {
      return ux(styles.cornerRadius)
    }
    return null
  }

  function alignMain(value) {
    switch (value) {
      case 'CENTER':
        return 'center'
      case 'MAX':
        return 'flex-end'
      case 'SPACE_BETWEEN':
        return 'space-between'
      default:
        return 'flex-start'
    }
  }

  function alignCross(value) {
    switch (value) {
      case 'CENTER':
        return 'center'
      case 'MAX':
        return 'flex-end'
      case 'BASELINE':
        return 'baseline'
      default:
        return 'flex-start'
    }
  }

  /**
   * 节点级 fontName/fontWeight 为 mixed 时，从 segments 首段推导基准样式。
   */
  function resolveTextBaseline(text) {
    if (!text) return {}
    const segments = text.segments
    const firstSeg =
      Array.isArray(segments) && segments.length ? segments[0] : null
    return {
      fontSize: text.fontSize ?? firstSeg?.fontSize,
      fontName: text.fontName ?? firstSeg?.fontName,
      fontWeight: text.fontWeight ?? firstSeg?.fontWeight,
    }
  }

  function textStyleCss(node) {
    const text = node.styles?.text
    if (!text) return []
    const baseline = resolveTextBaseline(text)
    const css = []
    if (baseline.fontSize) css.push(`font-size:${ux(baseline.fontSize)}`)
    const weight = cssFontWeight(baseline.fontWeight)
    if (weight != null) css.push(`font-weight:${weight}`)
    if (baseline.fontName) {
      css.push(`font-family:${fontFamily(baseline.fontName)}`)
    }
    if (text.textAlignHorizontal === 'CENTER') css.push('text-align:center')
    if (text.textAlignHorizontal === 'RIGHT') css.push('text-align:right')
    if (text.textAlignHorizontal === 'JUSTIFIED') css.push('text-align:justify')
    if (text.letterSpacing && text.letterSpacing !== 'mixed') {
      const ls = text.letterSpacing
      if (ls.unit === 'PIXELS') css.push(`letter-spacing:${ux(ls.value)}`)
      if (ls.unit === 'PERCENT') {
        css.push(`letter-spacing:${round(ls.value / 100)}em`)
      }
    }
    const lineHeight = resolveLineHeightCssValue(
      {...text, fontSize: baseline.fontSize},
      node.layout,
      ux,
    )
    if (lineHeight != null) {
      css.push(`line-height:${lineHeight}`)
    }
    if (text.textDecoration === 'UNDERLINE')
      css.push('text-decoration:underline')
    if (text.textCase === 'UPPER') css.push('text-transform:uppercase')
    if (text.textCase === 'LOWER') css.push('text-transform:lowercase')
    if (text.textCase === 'TITLE') css.push('text-transform:capitalize')
    return css
  }

  /**
   * 计算节点在父级 HTML 盒模型内的 left/top。
   * GROUP/BOOLEAN 子节点：Figma 原生 x/y 与父节点同空间，需减去父级原点。
   * 但 applyBakedVisualLayout 后的坐标已是相对父级包围盒，不能再减一次。
   */
  function localOffset(node, parent) {
    return localOffsetInParent(node, parent)
  }

  /**
   * Figma Plugin API `rotation` = atan2(-m10, m00)。
   * Y 向下时正角为逆时针；CSS `rotate()` 正角为顺时针。生成 CSS 时取反。
   */
  function cssRotateDeg(figmaRotation) {
    return typeof figmaRotation === 'number' ? -figmaRotation : 0
  }

  /**
   * CSS rotate（Y 向下、正角顺时针）绕 top-left 后的轴对齐包围盒。
   * 用于：旧 JSON 已带 png 但仍残留 rotation 时，把坐标改成与像素一致。
   * `deg` 须为 CSS 角度（即 `-layout.rotation`），不是 Figma 原值。
   */
  function aabbAfterCssRotate(x, y, w, h, deg) {
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const corners = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [dx, dy] of corners) {
      // CSS matrix(cos, sin, -sin, cos)
      const rx = x + dx * cos - dy * sin
      const ry = y + dx * sin + dy * cos
      minX = Math.min(minX, rx)
      minY = Math.min(minY, ry)
      maxX = Math.max(maxX, rx)
      maxY = Math.max(maxY, ry)
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    }
  }

  /** 已烘焙视觉的节点：用 AABB 尺寸/位置，不再叠 rotate */
  function effectiveLayout(node) {
    const layout = {...(node.layout || {})}
    const visualBaked = !!(
      node.flattened ||
      node.png ||
      node.pngRef ||
      node.svg ||
      layout.bakedVisual
    )
    if (!visualBaked) return {layout, visualBaked: false}

    if (
      !layout.bakedVisual &&
      typeof layout.rotation === 'number' &&
      Math.abs(layout.rotation) > 0.01
    ) {
      const box = aabbAfterCssRotate(
        layout.x ?? 0,
        layout.y ?? 0,
        layout.width ?? 0,
        layout.height ?? 0,
        cssRotateDeg(layout.rotation),
      )
      layout.x = box.x
      layout.y = box.y
      layout.width = box.width
      layout.height = box.height
    }
    layout.rotation = undefined
    return {layout, visualBaked: true}
  }

  function needsPositioningContext(node) {
    if (!node?.children?.length) return false
    if (FLAT_COORD_TYPES.has(node.type)) return true
    if (node.layout?.layoutMode) {
      return node.children.some(
        (c) => c.layout?.layoutPositioning === 'ABSOLUTE',
      )
    }
    return true
  }

  function isTopPackedAutoLayout(node) {
    const layout = node.layout
    if (!layout?.layoutMode || layout.primaryAxisAlignItems !== 'CENTER') {
      return false
    }
    const children = (node.children || []).filter((c) => c.visible !== false)
    if (!children.length) return false
    const isVert = layout.layoutMode === 'VERTICAL'
    const padStart = isVert
      ? (layout.padding?.top ?? 0)
      : (layout.padding?.left ?? 0)
    const childStart = isVert
      ? (children[0].layout?.y ?? 0)
      : (children[0].layout?.x ?? 0)
    return Math.abs(childStart - padStart) < 1
  }

  /**
   * 定宽文本框（可换行 / 多行）：HEIGHT、NONE、TRUNCATE，或 maxLines>1。
   * WIDTH_AND_HEIGHT 为内容撑开，不做宽高限制。
   */
  function isMultilineTextBox(node) {
    const text = node.styles?.text || {}
    const autoResize = text.textAutoResize
    if (
      autoResize === 'HEIGHT' ||
      autoResize === 'NONE' ||
      autoResize === 'TRUNCATE'
    ) {
      return true
    }
    if (typeof text.maxLines === 'number' && text.maxLines > 1) return true
    return false
  }

  function buildStyle(
    node,
    {isRoot = false, parent = null, parentAutoLayout = false} = {},
  ) {
    const {layout, visualBaked} = effectiveLayout(node)
    const styleNode = visualBaked ? {...node, layout} : node
    const styles = node.styles || {}
    const css = []

    const isText = node.type === 'TEXT'
    if (isText) {
      // 定宽/定高文本框：对齐 Figma 文本框尺寸
      if (isMultilineTextBox(node)) {
        if (typeof layout.width === 'number') {
          css.push(`width:${ux(layout.width)}`)
        }
        if (typeof layout.height === 'number') {
          css.push(`height:${ux(layout.height)}`)
        }
      }
    } else {
      css.push(`width:${ux(layout.width)}`)
      css.push(`height:${ux(layout.height)}`)
    }
    css.push('box-sizing:border-box')

    if (typeof node.opacity === 'number' && node.opacity < 1) {
      css.push(`opacity:${round(node.opacity)}`)
    }

    if (node.clipsContent) css.push('overflow:hidden')

    const isAuto = !!layout.layoutMode
    if (isAuto) {
      css.push('display:flex')
      css.push(
        `flex-direction:${layout.layoutMode === 'VERTICAL' ? 'column' : 'row'}`,
      )
      // SPACE_BETWEEN 时主轴间距由剩余空间均分，Figma 残留的 itemSpacing 不应写成 gap。
      const distributedMain = layout.primaryAxisAlignItems === 'SPACE_BETWEEN'
      const isWrap = layout.layoutWrap === 'WRAP'
      const isHorizontal = layout.layoutMode === 'HORIZONTAL'
      if (isWrap) {
        css.push('flex-wrap:wrap')
        const mainGap =
          !distributedMain && layout.itemSpacing
            ? round(layout.itemSpacing)
            : null
        const crossGap = layout.counterAxisSpacing
          ? round(layout.counterAxisSpacing)
          : null
        if (isHorizontal) {
          if (mainGap !== null) css.push(`column-gap:${ux(mainGap)}`)
          if (crossGap !== null) css.push(`row-gap:${ux(crossGap)}`)
        } else {
          if (mainGap !== null) css.push(`row-gap:${ux(mainGap)}`)
          if (crossGap !== null) css.push(`column-gap:${ux(crossGap)}`)
        }
        if (layout.counterAxisAlignContent === 'SPACE_BETWEEN') {
          css.push('align-content:space-between')
        }
      } else if (layout.itemSpacing && !distributedMain) {
        css.push(`gap:${ux(layout.itemSpacing)}`)
      }
      if (layout.padding) {
        const p = layout.padding
        // 内侧描边未计入布局时，Figma padding 从外框起算并与描边重叠；
        // CSS border 占宽，需从 padding 中扣掉 strokeWeight，内容起点才一致。
        const strokeForPad =
          !node.svg &&
          !node.png &&
          !node.pngRef &&
          !layout.strokesIncludedInLayout &&
          styles.strokeAlign !== 'CENTER' &&
          styles.strokeAlign !== 'OUTSIDE' &&
          typeof styles.strokeWeight === 'number' &&
          visiblePaints(styles.strokes).length > 0
            ? round(styles.strokeWeight)
            : 0
        const top = Math.max(0, round(p.top) - strokeForPad)
        const right = Math.max(0, round(p.right) - strokeForPad)
        const bottom = Math.max(0, round(p.bottom) - strokeForPad)
        const left = Math.max(0, round(p.left) - strokeForPad)
        css.push(`padding:${ux(top)} ${ux(right)} ${ux(bottom)} ${ux(left)}`)
      }
      css.push(
        `justify-content:${
          isTopPackedAutoLayout(node)
            ? 'flex-start'
            : alignMain(layout.primaryAxisAlignItems)
        }`,
      )
      css.push(`align-items:${alignCross(layout.counterAxisAlignItems)}`)
    }

    const useAbsolute =
      !isRoot && (!parentAutoLayout || layout.layoutPositioning === 'ABSOLUTE')

    if (isRoot) {
      css.push('position:relative')
      css.push('margin:0 auto')
    } else if (useAbsolute) {
      const {left, top} = localOffset(styleNode, parent)
      css.push('position:absolute')
      css.push(`left:${ux(left)}`)
      css.push(`top:${ux(top)}`)
    } else if (needsPositioningContext(node)) {
      // flex 子项同时作为绝对定位容器
      css.push('position:relative')
    }

    if (parentAutoLayout && !useAbsolute && layout.layoutGrow) {
      css.push(`flex-grow:${layout.layoutGrow}`)
    }
    if (parentAutoLayout && !useAbsolute) {
      // Figma 固定尺寸子项不会因父容器空间不足而收缩。
      css.push('flex-shrink:0')
    }
    if (parentAutoLayout && !useAbsolute && layout.layoutAlign === 'STRETCH') {
      css.push('align-self:stretch')
    }

    const transforms = []
    // 切图（png/svg/flattened）像素已含旋转；effectiveLayout 已改包围盒并清 rotation。
    // 未烘焙时：位图填充的 imageHash 是源图，节点旋转应靠导出侧切图烘焙，
    // 这里不再用 CSS rotate 去「猜」——AL 原点与 Figma 不一致，易旋出裁剪区。
    // 仅对无位图填充的未烘焙节点保留 CSS rotate 兜底。
    const hasImageFill = (styles.fills || []).some(
      (paint) =>
        paint &&
        paint.visible !== false &&
        paint.type === 'IMAGE' &&
        paint.imageHash,
    )
    let rotateAroundCenter = false
    if (
      !visualBaked &&
      !hasImageFill &&
      typeof layout.rotation === 'number' &&
      Math.abs(layout.rotation) > 0.01
    ) {
      transforms.push(`rotate(${round(cssRotateDeg(layout.rotation))}deg)`)
      // Auto Layout 子项由 flex 占位（不用 x/y），绕中心以免旋出布局槽
      rotateAroundCenter = parentAutoLayout && !useAbsolute
    }

    const strokes =
      node.svg || node.png || node.pngRef ? [] : visiblePaints(styles.strokes)
    const strokeWeight =
      strokes.length && typeof styles.strokeWeight === 'number'
        ? round(styles.strokeWeight)
        : 0
    const strokeBg =
      strokeWeight > 0
        ? paintBackground(
            strokes[strokes.length - 1],
            layout.width,
            layout.height,
          )
        : null
    const strokeColor = typeof strokeBg === 'string' ? strokeBg : null
    const strokeIsGradient = cssLooksLikeGradient(strokeColor)
    // border-color 不支持渐变；内侧描边用透明 border + 底层渐变 clip 到边框区
    const useGradientBorder =
      strokeIsGradient &&
      !isText &&
      styles.strokeAlign !== 'OUTSIDE' &&
      styles.strokeAlign !== 'CENTER'

    // 导出的 SVG/PNG 已含 fill/stroke，重复映射会把图标覆盖成色块。
    if (!node.svg && !node.png && !node.pngRef) {
      const imageLayers = imageBackgrounds(
        styles.fills,
        layout.width,
        layout.height,
      )
      const fillPaints =
        visiblePaints(styles.fills).length > 0
          ? styles.fills
          : textFallbackFills(node) || []
      const bg = topmostBackground(fillPaints, layout.width, layout.height)
      const colorLayers = colorBackgroundLayers(
        fillPaints,
        layout.width,
        layout.height,
      )
      if (imageLayers.length) {
        const images = imageLayers.map(
          (layer) => `url("${layer.image}")`,
        )
        const sizes = imageLayers.map((layer) => layer.size)
        const positions = imageLayers.map(
          (layer) => layer.position || 'center',
        )
        const repeats = imageLayers.map((layer) => layer.repeat)
        const clips = imageLayers.map(() => 'padding-box')
        const origins = imageLayers.map(() => 'border-box')
        if (useGradientBorder) {
          images.push(strokeColor)
          sizes.push('auto')
          positions.push('0 0')
          repeats.push('no-repeat')
          clips.push('border-box')
          origins.push('border-box')
        }
        css.push(`background-image:${images.join(',')}`)
        css.push(`background-size:${sizes.join(',')}`)
        css.push(`background-position:${positions.join(',')}`)
        css.push(`background-repeat:${repeats.join(',')}`)
        if (useGradientBorder) {
          css.push(`background-origin:${origins.join(',')}`)
          css.push(`background-clip:${clips.join(',')}`)
        }
      } else if (useGradientBorder) {
        const fillLayers = colorLayers.length
          ? colorLayers
          : typeof bg === 'string'
            ? [
                cssLooksLikeGradient(bg)
                  ? bg
                  : solidColorAsGradientLayer(bg),
              ]
            : [solidColorAsGradientLayer('transparent')]
        const layers = [...fillLayers, strokeColor]
        css.push(`background-image:${layers.join(',')}`)
        css.push(
          `background-origin:${layers.map(() => 'border-box').join(',')}`,
        )
        css.push(
          `background-clip:${[
            ...fillLayers.map(() => 'padding-box'),
            'border-box',
          ].join(',')}`,
        )
      } else if (colorLayers.length > 1) {
        if (node.type === 'TEXT') {
          // 顶层实色直接上色；顶层/叠层含渐变时再 clip 到字形
          if (typeof bg === 'string' && !cssLooksLikeGradient(bg)) {
            css.push(`color:${bg}`)
          } else {
            css.push(`background-image:${colorLayers.join(',')}`)
            css.push('-webkit-background-clip:text')
            css.push('background-clip:text')
            css.push('-webkit-text-fill-color:transparent')
            css.push('color:transparent')
          }
        } else {
          css.push(`background-image:${colorLayers.join(',')}`)
        }
      } else if (typeof bg === 'string') {
        if (node.type === 'TEXT' && cssLooksLikeGradient(bg)) {
          css.push(`background-image:${bg}`)
          css.push('-webkit-background-clip:text')
          css.push('background-clip:text')
          css.push('-webkit-text-fill-color:transparent')
          css.push('color:transparent')
        } else if (node.type === 'TEXT') {
          css.push(`color:${bg}`)
        } else {
          css.push(`background:${bg}`)
        }
      }
    }

    const radius = radiusCss(styles, node.type)
    // 切图像素已含圆角；再套 border-radius 会与路径半径不一致，胶囊边框易出棱角
    const skipCssRadius = !!(
      visualBaked ||
      node.png ||
      node.pngRef ||
      node.svg ||
      node.svgRef ||
      node.flattened
    )
    if (radius && !skipCssRadius) css.push(`border-radius:${radius}`)

    if (strokeColor && isText) {
      // 文字描边：box-shadow 对字形无效，用一圈 text-shadow 近似
      const ts = textStrokeShadow(strokeColor, strokeWeight)
      if (ts) css.push(`text-shadow:${ts}`)
    } else if (useGradientBorder) {
      css.push(`border:${ux(strokeWeight)} solid transparent`)
    } else if (strokeColor && styles.strokeAlign === 'CENTER') {
      css.push(`outline:${ux(strokeWeight)} solid ${strokeColor}`)
      css.push(`outline-offset:-${ux(strokeWeight / 2)}`)
    } else if (strokeColor && styles.strokeAlign !== 'OUTSIDE') {
      // 内侧描边统一用 border；未计入布局时已在上方扣减 padding
      css.push(`border:${ux(strokeWeight)} solid ${strokeColor}`)
    }

    const shadowParts = []
    const useDropShadowFilter = shouldUseDropShadowFilter(
      node,
      styles,
      visualBaked,
    )
    // PNG 切图已烘焙 INNER_SHADOW；外阴影仍由 CSS 绘制
    const shadow = shadowCss(styles.effects, {
      skipInnerShadow: !!(node.png || node.pngRef),
      useDropShadowFilter,
    })
    if (shadow.boxShadow) shadowParts.push(shadow.boxShadow)
    if (
      strokeColor &&
      !isText &&
      styles.strokeAlign === 'OUTSIDE' &&
      !strokeIsGradient
    ) {
      shadowParts.push(`0 0 0 ${ux(strokeWeight)} ${strokeColor}`)
    }
    if (shadowParts.length) css.push(`box-shadow:${shadowParts.join(', ')}`)

    const blurs = blurFilters(styles.effects)
    const filterParts = [...shadow.dropFilters]
    if (blurs.filter) filterParts.push(blurs.filter)
    if (filterParts.length) css.push(`filter:${filterParts.join(' ')}`)
    if (blurs.backdrop) {
      css.push(`backdrop-filter:${blurs.backdrop}`)
      css.push(`-webkit-backdrop-filter:${blurs.backdrop}`)
    }

    if (transforms.length) {
      css.push(`transform:${transforms.join(' ')}`)
      // AL flex 子项：center（对齐 Figma 布局槽内视觉）
      // 绝对定位：top left（对齐 relativeTransform / node.x·y）
      css.push(
        rotateAroundCenter
          ? 'transform-origin:center'
          : 'transform-origin:top left',
      )
    }

    if (node.type === 'TEXT') {
      // p 有默认 margin，设计稿还原必须清零
      css.push('margin:0')
      css.push(...textStyleCss(node))
      css.push(...textWrapCss(node))
    }

    return css.join(';')
  }

  /**
   * TEXT 节点标签选择：
   * - 可换行 / 多行截断 → p
   * - 单行自适应短文案 → span
   */
  function textTagName(node) {
    const text = node.styles?.text || {}
    const chars = text.characters || ''
    const hasHardBreak = chars.includes('\n')
    const autoResize = text.textAutoResize
    const truncate =
      text.textTruncation === 'ENDING' || autoResize === 'TRUNCATE'
    const maxLines =
      typeof text.maxLines === 'number' && text.maxLines > 0 ? text.maxLines : 1

    if (truncate && maxLines > 1) return 'p'
    if (autoResize === 'HEIGHT' || autoResize === 'NONE') return 'p'
    if (hasHardBreak) return 'p'
    return 'span'
  }

  /**
   * 文本换行 / 截断：Figma textTruncation + maxLines → CSS ellipsis / line-clamp。
   */
  function resolveTruncateLines(text) {
    if (typeof text.maxLines === 'number' && text.maxLines > 0) {
      return text.maxLines
    }
    return 1
  }

  function shouldTruncateText(text) {
    return (
      text.textTruncation === 'ENDING' || text.textAutoResize === 'TRUNCATE'
    )
  }

  function textTruncateCss(node) {
    const text = node.styles?.text || {}
    if (!shouldTruncateText(text)) return []

    const lines = resolveTruncateLines(text)
    const hasHardBreak = (text.characters || '').includes('\n')

    if (lines <= 1) {
      return ['overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']
    }

    const css = [
      'display:-webkit-box',
      '-webkit-box-orient:vertical',
      `-webkit-line-clamp:${lines}`,
      'overflow:hidden',
    ]
    css.push(hasHardBreak ? 'white-space:pre-wrap' : 'white-space:normal')
    css.push('overflow-wrap:break-word')
    return css
  }

  function textWrapCss(node) {
    const truncateCss = textTruncateCss(node)
    if (truncateCss.length) return truncateCss

    const text = node.styles?.text || {}
    const chars = text.characters || ''
    const hasHardBreak = chars.includes('\n')
    const autoResize = text.textAutoResize

    let wrap = false
    if (autoResize === 'HEIGHT' || autoResize === 'NONE') {
      wrap = true
    } else if (autoResize === 'WIDTH_AND_HEIGHT') {
      wrap = hasHardBreak
    }

    if (!wrap) {
      return ['white-space:nowrap']
    }

    const css = []
    css.push(hasHardBreak ? 'white-space:pre-wrap' : 'white-space:normal')
    css.push('overflow-wrap:anywhere')
    return css
  }

  function classNameFor(node) {
    return `n-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  }

  /** 与插件侧 GOOGLE_FONT_FAMILY_MAP 保持一致：Figma 名 → Google Fonts 族名 */
  const GOOGLE_FONT_FAMILY_MAP = {
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

  function isSystemFontFamily(family) {
    const f = String(family || '').toLowerCase()
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
   * 从 node.json.fonts 或节点树收集需 CDN 加载的字体。
   * 按 Google 族名聚合字重，避免单字重字体请求多余 wght 失败。
   */
  function resolveGoogleFontImports(root, fontRefs) {
    const byGoogleFamily = new Map()
    const sfProWeights = new Set()

    const addRef = (ref) => {
      if (!ref?.family) return
      const weight = cssFontWeight(ref.weight) ?? MIN_CSS_FONT_WEIGHT
      if (
        isSystemFontFamily(ref.family) &&
        String(ref.family).toLowerCase().includes('sf pro')
      ) {
        sfProWeights.add(weight)
        return
      }
      if (isSystemFontFamily(ref.family)) return
      if (ref.provider && ref.provider !== 'google') return
      const googleFamily = GOOGLE_FONT_FAMILY_MAP[ref.family]
      if (!googleFamily) return
      if (!byGoogleFamily.has(googleFamily)) {
        byGoogleFamily.set(googleFamily, new Set())
      }
      byGoogleFamily.get(googleFamily).add(weight)
    }

    if (Array.isArray(fontRefs) && fontRefs.length) {
      for (const ref of fontRefs) addRef(ref)
    } else {
      // 兼容旧 node.json：无 fonts 字段时从树推导
      const walk = (node) => {
        if (node.visible === false) return
        const fontName = node.styles?.text?.fontName
        if (fontName?.family) {
          addRef({
            family: fontName.family,
            style: fontName.style,
            weight: node.styles?.text?.fontWeight,
            provider: GOOGLE_FONT_FAMILY_MAP[fontName.family]
              ? 'google'
              : 'unknown',
          })
        }
        for (const child of node.children || []) walk(child)
      }
      walk(root)
    }

    // SF Pro 无法外链：额外加载 Inter 作为栈内回退（font-family 中排在 SF Pro 之后）
    if (sfProWeights.size) {
      if (!byGoogleFamily.has('Inter')) {
        byGoogleFamily.set('Inter', new Set())
      }
      for (const w of sfProWeights) {
        byGoogleFamily.get('Inter').add(w)
      }
    }

    return [...byGoogleFamily.entries()].map(([family, weights]) => ({
      family,
      weights: [...weights].sort((a, b) => a - b),
    }))
  }

  function googleFontsLinkFromImports(imports) {
    if (!imports.length) return ''
    const q = imports
      .map(({family, weights}) => {
        const name = encodeURIComponent(family).replace(/%20/g, '+')
        const wght = weights.join(';')
        return `family=${name}:wght@${wght}`
      })
      .join('&')
    return `<link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?${q}&display=swap" rel="stylesheet" />`
  }

  /**
   * CSS font-family 栈：
   * 1. 始终以 Figma 上的 family 名为第一候选
   * 2. 兼容/回退字体只能排在后面，不得覆盖设计字体
   */
  function fontFamily(fontName) {
    if (!fontName?.family) {
      return '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'
    }
    const family = fontName.family
    const lower = family.toLowerCase()
    const stack = []
    const pushUnique = (name) => {
      if (!name) return
      const key = name.toLowerCase()
      if (stack.some((s) => s.toLowerCase() === key)) return
      stack.push(name)
    }

    // 1. Figma 设计字体名始终第一
    pushUnique(family)

    // 2. Google Fonts CDN 别名（与 Figma 名不同时，便于匹配已加载字体）
    const googleFamily = GOOGLE_FONT_FAMILY_MAP[family]
    if (googleFamily && googleFamily.toLowerCase() !== lower) {
      pushUnique(googleFamily)
    }

    // 3. 系统/跨平台兼容回退（仅排在设计字体之后）
    if (lower.includes('sf pro')) {
      pushUnique('-apple-system')
      pushUnique('BlinkMacSystemFont')
      pushUnique('Inter')
      pushUnique('Segoe UI')
    } else if (isSystemFontFamily(family)) {
      pushUnique('-apple-system')
      pushUnique('BlinkMacSystemFont')
      pushUnique('Segoe UI')
    }

    // 4. 中文及通用回退
    pushUnique('PingFang SC')
    pushUnique('Hiragino Sans GB')
    pushUnique('Microsoft YaHei')
    pushUnique('Noto Sans SC')
    pushUnique('system-ui')
    pushUnique('sans-serif')

    return stack
      .map((name) =>
        name === 'sans-serif' ||
        name === 'system-ui' ||
        name === '-apple-system' ||
        name === 'BlinkMacSystemFont'
          ? name
          : `"${name}"`,
      )
      .join(', ')
  }

  /** 取可见 SOLID 填色；无则 null */
  function solidColorFromFills(fills) {
    for (const paint of visiblePaints(fills)) {
      if (paint.type === 'SOLID' && paint.color) return paint.color
    }
    return null
  }

  /**
   * 节点级无 fills（mixed）时：
   * - 单段 → 用该段 fills 作默认色
   * - 多段混色 → 不设父级 color，由 span 着色
   */
  function textFallbackFills(node) {
    const segments = node.styles?.text?.segments
    if (!Array.isArray(segments) || !segments.length) return null
    if (segments.length > 1) return null
    return segments[0].fills || null
  }

  /**
   * TEXT 内容：多段混色时输出带 color 的 span；单段则纯文本。
   * @param {(s: string) => string} [escapeHtml]
   */
  function renderTextHtmlContent(node, escapeHtml = esc) {
    const text = node.styles?.text || {}
    const segments = text.segments
    if (!Array.isArray(segments) || segments.length === 0) {
      return escapeHtml(text.characters || '')
    }
    if (segments.length === 1) {
      return escapeHtml(segments[0].characters || text.characters || '')
    }
    const baseline = resolveTextBaseline(text)
    return segments
      .map((seg) => {
        const parts = []
        const color = solidColorFromFills(seg.fills)
        if (color) parts.push(`color:${color}`)
        if (
          typeof seg.fontSize === 'number' &&
          typeof baseline.fontSize === 'number' &&
          seg.fontSize !== baseline.fontSize
        ) {
          parts.push(`font-size:${ux(seg.fontSize)}`)
        }
        {
          const segW = cssFontWeight(seg.fontWeight)
          const baseW = cssFontWeight(baseline.fontWeight)
          if (segW != null && baseW != null && segW !== baseW) {
            parts.push(`font-weight:${segW}`)
          }
        }
        if (
          seg.fontName?.family &&
          (!baseline.fontName?.family ||
            seg.fontName.family !== baseline.fontName.family ||
            seg.fontName.style !== baseline.fontName.style)
        ) {
          parts.push(`font-family:${fontFamily(seg.fontName)}`)
        }
        const body = escapeHtml(seg.characters || '')
        if (!parts.length) return body
        return `<span style="${escapeHtml(parts.join(';'))}">${body}</span>`
      })
      .join('')
  }

return {
    buildStyle,
    classNameFor,
    textTagName,
    round,
    ux,
    esc,
    cssUnit: 'px',
    resolveGoogleFontImports,
    googleFontsLinkFromImports,
    renderTextHtmlContent,
    solidColorFromFills,
  }
}
