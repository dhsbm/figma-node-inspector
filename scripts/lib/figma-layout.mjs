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
export function wrapHtmlForContentOverflow(
  bodyHtml,
  root,
  uxFn = (n) => `${round(n)}px`,
) {
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

/** Figma fontName.style 含 Italic / Oblique 时视为斜体 */
export function isItalicFontStyle(style) {
  if (!style || typeof style !== 'string') return false
  const s = style.toLowerCase()
  return s.includes('italic') || s.includes('oblique')
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
    // ZIP 落盘后常只剩 path；inspect 内存里则有 dataUrl
    if (asset.dataUrl || asset.path) return asset
    return null
  }
  return null
}

/** 矢量节点 png / pngRef → 可用 src（dataUrl 或相对 path） */
export function resolveNodePng(node, images) {
  if (node.png) return node.png
  if (node.pngRef) {
    const asset = resolveImageAsset(images, node.pngRef)
    return asset?.dataUrl || asset?.path || null
  }
  return null
}

/** 格式化 CSS 渐变 stop 百分比 */
function formatGradientStopPercent(value) {
  return Number((value * 100).toFixed(2)).toString()
}

/**
 * 将 paint.opacity 乘进 #RRGGBB / #RRGGBBAA。
 * 渐变色标序列化时未烘焙 paint 级透明度，CSS 侧需补上。
 */
export function multiplyHexAlpha(hex, opacity = 1) {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return hex
  if (typeof opacity !== 'number' || !(opacity < 1)) return hex
  const raw = hex.slice(1)
  let r
  let g
  let b
  let a = 1
  if (raw.length === 3 || raw.length === 4) {
    r = parseInt(raw[0] + raw[0], 16)
    g = parseInt(raw[1] + raw[1], 16)
    b = parseInt(raw[2] + raw[2], 16)
    if (raw.length === 4) a = parseInt(raw[3] + raw[3], 16) / 255
  } else if (raw.length === 6 || raw.length === 8) {
    r = parseInt(raw.slice(0, 2), 16)
    g = parseInt(raw.slice(2, 4), 16)
    b = parseInt(raw.slice(4, 6), 16)
    if (raw.length === 8) a = parseInt(raw.slice(6, 8), 16) / 255
  } else {
    return hex
  }
  if ([r, g, b].some((n) => Number.isNaN(n))) return hex
  a = Math.max(0, Math.min(1, a * opacity))
  const toHex = (n) => Math.round(n).toString(16).padStart(2, '0').toUpperCase()
  const rgb = `#${toHex(r)}${toHex(g)}${toHex(b)}`
  if (a >= 1) return rgb
  return `${rgb}${toHex(a * 255)}`
}

function gradientStopColor(stop, paintOpacity = 1) {
  return multiplyHexAlpha(stop?.color, paintOpacity)
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
  const paintOpacity = typeof paint.opacity === 'number' ? paint.opacity : 1
  if (paint.stops.length === 1) {
    return gradientStopColor(paint.stops[0], paintOpacity)
  }

  const w = typeof width === 'number' && width > 0 ? width : 100
  const h = typeof height === 'number' && height > 0 ? height : 100
  const transform = paint.gradientTransform

  if (!transform || transform.length !== 2) {
    const angle = paint.cssAngle ?? 180
    const stops = paint.stops
      .map(
        (s) =>
          `${gradientStopColor(s, paintOpacity)} ${formatGradientStopPercent(s.position)}%`,
      )
      .join(', ')
    return `linear-gradient(${angle}deg, ${stops})`
  }

  const inverse = inverseTransform2x3(transform)
  if (!inverse) {
    const angle = paint.cssAngle ?? 180
    const stops = paint.stops
      .map(
        (s) =>
          `${gradientStopColor(s, paintOpacity)} ${formatGradientStopPercent(s.position)}%`,
      )
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
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return gradientStopColor(paint.stops[0], paintOpacity)
  }

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
  if (cssLength < 1e-6) {
    return gradientStopColor(paint.stops[0], paintOpacity)
  }

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
      color: gradientStopColor(stop, paintOpacity),
      position: signedDistance / cssLength,
    }
  })

  const stops = mappedStops
    .map((s) => `${s.color} ${formatGradientStopPercent(s.position)}%`)
    .join(', ')
  return `linear-gradient(${Math.round(cssAngleDeg)}deg, ${stops})`
}

/**
 * Figma GRADIENT_RADIAL → CSS radial-gradient。
 * 句柄约定：梯度空间 (0.5,0.5) 为圆心，(1,0.5)/(0.5,1) 为椭圆轴端点。
 */
export function radialGradientPaintToCss(paint, width, height) {
  if (!paint?.stops?.length) return null
  const paintOpacity = typeof paint.opacity === 'number' ? paint.opacity : 1
  const stops = paint.stops
    .map(
      (s) =>
        `${gradientStopColor(s, paintOpacity)} ${formatGradientStopPercent(s.position)}%`,
    )
    .join(', ')

  const w = typeof width === 'number' && width > 0 ? width : 0
  const h = typeof height === 'number' && height > 0 ? height : 0
  const transform = paint.gradientTransform
  if (!transform || transform.length !== 2 || !w || !h) {
    return `radial-gradient(circle, ${stops})`
  }

  const inverse = inverseTransform2x3(transform)
  if (!inverse) return `radial-gradient(circle, ${stops})`

  const center = applyTransform2x3(inverse, 0.5, 0.5)
  const rxPoint = applyTransform2x3(inverse, 1, 0.5)
  const ryPoint = applyTransform2x3(inverse, 0.5, 1)
  const cx = center.x * w
  const cy = center.y * h
  const rx = Math.hypot((rxPoint.x - center.x) * w, (rxPoint.y - center.y) * h)
  const ry = Math.hypot((ryPoint.x - center.x) * w, (ryPoint.y - center.y) * h)
  if (!(rx > 0) || !(ry > 0)) return `radial-gradient(circle, ${stops})`

  const at = `${round(cx)}px ${round(cy)}px`
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.02) {
    return `radial-gradient(${round(rx)}px at ${at}, ${stops})`
  }
  return `radial-gradient(${round(rx)}px ${round(ry)}px at ${at}, ${stops})`
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

  /** 填充是否半透明：半透明时不能把描边渐变铺满整盒当底层，否则会透出来变成大光团 */
  function fillsLookTranslucent(paints = []) {
    const visible = visiblePaints(paints)
    if (!visible.length) return true
    return visible.some((paint) => {
      const op = typeof paint.opacity === 'number' ? paint.opacity : 1
      if (op < 0.999) return true
      if (paint.type === 'SOLID' && typeof paint.color === 'string') {
        const raw = paint.color.slice(1)
        if (raw.length === 8) {
          const a = parseInt(raw.slice(6, 8), 16) / 255
          if (a < 0.999) return true
        }
        if (raw.length === 4) {
          const a = parseInt(raw[3] + raw[3], 16) / 255
          if (a < 0.999) return true
        }
      }
      if (paint.stops?.length) {
        return paint.stops.some((stop) => {
          const c = stop?.color
          if (typeof c !== 'string' || !c.startsWith('#')) return false
          const raw = c.slice(1)
          if (raw.length === 8) {
            return parseInt(raw.slice(6, 8), 16) / 255 < 0.999
          }
          if (raw.length === 4) {
            return parseInt(raw[3] + raw[3], 16) / 255 < 0.999
          }
          return false
        })
      }
      return false
    })
  }

  /**
   * 矮装饰光条（标题下橙光等）：PNG 栅格 + 再 blur/opacity 容易发糊发暗，
   * 有渐变 fills 时改走 CSS，更接近稿面软光。
   */
  function shouldPreferCssBlurGradient(node) {
    const styles = node.styles || {}
    const h = node.layout?.height
    if (!(typeof h === 'number' && h > 0 && h <= 32)) return false
    const hasBlur = (styles.effects || []).some(
      (e) =>
        e &&
        e.visible !== false &&
        e.type === 'LAYER_BLUR' &&
        (e.radius || 0) > 0,
    )
    if (!hasBlur) return false
    return visiblePaints(styles.fills).some(
      (p) => p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL',
    )
  }

  /** 标题下光条：稿面小团柔光；用满 radius（常规层是 /2），勿再放大以免光团过大 */
  function titleGlowBlurCss(effects = []) {
    for (const e of effects) {
      if (
        !e ||
        e.visible === false ||
        e.type !== 'LAYER_BLUR' ||
        !(e.radius > 0)
      ) {
        continue
      }
      return `blur(${ux(round(e.radius))})`
    }
    return null
  }

  /**
   * 单边描边（列表分割线等）：border / box-shadow 都会被等高子层或
   * 父级 overflow:hidden 吃掉，需在 HTML 里插绝对定位细线。
   * 返回 null 表示不是「仅单边」场景，走常规 border。
   */
  function singleSideStrokeOverlay(weights, color) {
    if (!weights || !color) return null
    const t = weights.top || 0
    const r = weights.right || 0
    const b = weights.bottom || 0
    const l = weights.left || 0
    const sides = [
      t > 0 ? ['top', t] : null,
      r > 0 ? ['right', r] : null,
      b > 0 ? ['bottom', b] : null,
      l > 0 ? ['left', l] : null,
    ].filter(Boolean)
    if (sides.length !== 1) return null
    const [side, w] = sides[0]
    return {side, width: w, color}
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
      return radialGradientPaintToCss(paint, width, height)
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
        boxParts.push(`${ux(x)} ${ux(y)} ${ux(blur)} ${ux(spread)} ${color}`)
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

  /**
   * Figma 图层 blendMode → CSS mix-blend-mode。
   * LINEAR_DODGE（Add）对应 plus-lighter；光效/粒子常用，漏掉会明显发暗。
   */
  function mixBlendModeCss(blendMode) {
    if (!blendMode || blendMode === 'PASS_THROUGH' || blendMode === 'NORMAL') {
      return null
    }
    switch (blendMode) {
      case 'MULTIPLY':
        return 'multiply'
      case 'SCREEN':
        return 'screen'
      case 'OVERLAY':
        return 'overlay'
      case 'DARKEN':
        return 'darken'
      case 'LIGHTEN':
        return 'lighten'
      case 'COLOR_DODGE':
        return 'color-dodge'
      case 'COLOR_BURN':
      case 'LINEAR_BURN':
        return 'color-burn'
      case 'HARD_LIGHT':
        return 'hard-light'
      case 'SOFT_LIGHT':
        return 'soft-light'
      case 'DIFFERENCE':
        return 'difference'
      case 'EXCLUSION':
        return 'exclusion'
      case 'HUE':
        return 'hue'
      case 'SATURATION':
        return 'saturation'
      case 'COLOR':
        return 'color'
      case 'LUMINOSITY':
        return 'luminosity'
      case 'LINEAR_DODGE':
      case 'ADD':
        return 'plus-lighter'
      default:
        return null
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
    if (isItalicFontStyle(baseline.fontName?.style)) {
      css.push('font-style:italic')
    }
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
   * layout.transform = Figma [[m00,m01],[m10,m11]]（单位轴，可含 skew）。
   * CSS matrix(a,b,c,d) 对应 x'=ax+cy, y'=bx+dy → matrix(m00, m10, m01, m11)。
   */
  function cssMatrixFromLayoutTransform(transform) {
    if (!Array.isArray(transform) || transform.length !== 2) return null
    const row0 = transform[0]
    const row1 = transform[1]
    if (!Array.isArray(row0) || !Array.isArray(row1)) return null
    if (row0.length < 2 || row1.length < 2) return null
    const m00 = round(row0[0])
    const m01 = round(row0[1])
    const m10 = round(row1[0])
    const m11 = round(row1[1])
    return `matrix(${m00}, ${m10}, ${m01}, ${m11}, 0, 0)`
  }

  function hasLayoutSkew(layout) {
    if (cssMatrixFromLayoutTransform(layout?.transform)) return true
    if (typeof layout?.skewX === 'number' && Math.abs(layout.skewX) > 0.01) {
      return true
    }
    if (typeof layout?.skewY === 'number' && Math.abs(layout.skewY) > 0.01) {
      return true
    }
    return false
  }

  /**
   * 无 transform 矩阵时的兜底：按 Figma 单位轴形式重建纯 skew
   *（θ → matrix(1,0,sinθ,cosθ)；与 CSS skewX 的 tan 形式不同）。
   */
  function cssMatrixFromSkewAngles(skewXDeg, skewYDeg) {
    const sx =
      typeof skewXDeg === 'number' && Math.abs(skewXDeg) > 0.01
        ? (skewXDeg * Math.PI) / 180
        : 0
    const sy =
      typeof skewYDeg === 'number' && Math.abs(skewYDeg) > 0.01
        ? (skewYDeg * Math.PI) / 180
        : 0
    if (!sx && !sy) return null
    // 水平 skew：y 轴倾倒；垂直 skew：x 轴倾倒（单位轴）
    const m00 = sy ? Math.cos(sy) : 1
    const m10 = sy ? Math.sin(sy) : 0
    const m01 = sx ? Math.sin(sx) : 0
    const m11 = sx ? Math.cos(sx) : 1
    return `matrix(${round(m00)}, ${round(m10)}, ${round(m01)}, ${round(m11)}, 0, 0)`
  }

  function layoutTransformMatrix2x2(layout) {
    if (Array.isArray(layout?.transform) && layout.transform.length === 2) {
      const row0 = layout.transform[0]
      const row1 = layout.transform[1]
      if (
        Array.isArray(row0) &&
        Array.isArray(row1) &&
        row0.length >= 2 &&
        row1.length >= 2
      ) {
        return [
          [Number(row0[0]) || 0, Number(row0[1]) || 0],
          [Number(row1[0]) || 0, Number(row1[1]) || 0],
        ]
      }
    }
    const sx =
      typeof layout?.skewX === 'number' ? (layout.skewX * Math.PI) / 180 : 0
    const sy =
      typeof layout?.skewY === 'number' ? (layout.skewY * Math.PI) / 180 : 0
    if (!sx && !sy) return null
    return [
      [sy ? Math.cos(sy) : 1, sx ? Math.sin(sx) : 0],
      [sy ? Math.sin(sy) : 0, sx ? Math.cos(sx) : 1],
    ]
  }

  /**
   * skew 后局部盒角点超出 width×height；再叠加字号>行高时 p/g/y 字脚溢出。
   * CSS transform 与 background-clip:text 易按未变换盒裁切 → padding 扩绘制区，
   * 负 margin 保持锚点；原点须对齐内容区左上（见 transform-origin）。
   */
  function skewPaintInset(layout, node) {
    const m = layoutTransformMatrix2x2(layout)
    if (!m) return null
    const [[m00, m01], [m10, m11]] = m
    const w = typeof layout.width === 'number' ? layout.width : 0
    const h = typeof layout.height === 'number' ? layout.height : 0
    if (!(w > 0 || h > 0)) return null

    let minX = 0
    let maxX = w
    let minY = 0
    let maxY = h
    for (const [x, y] of [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]) {
      const xp = m00 * x + m01 * y
      const yp = m10 * x + m11 * y
      minX = Math.min(minX, xp)
      maxX = Math.max(maxX, xp)
      minY = Math.min(minY, yp)
      maxY = Math.max(maxY, yp)
    }

    const fontSize = node?.styles?.text?.fontSize
    const isText = node?.type === 'TEXT'
    const base =
      typeof fontSize === 'number' && fontSize > 0
        ? fontSize
        : Math.max(h, 12)
    // 水平：剪切外溢 + sidebearing
    const fudgeX = Math.max(3, Math.ceil(base * 0.12))
    // 垂直：字号大于行盒时的上下溢出 + 字脚（p/g/y ≈0.25em）
    let glyphTop = 0
    let glyphBottom = 0
    if (isText && typeof fontSize === 'number') {
      const tight = Math.max(0, fontSize - (h || fontSize))
      glyphTop = tight / 2 + fontSize * 0.12
      glyphBottom = tight / 2 + fontSize * 0.35
    }
    const fudgeY = Math.max(2, Math.ceil(base * 0.08))

    const left = Math.max(0, round(-minX)) + fudgeX
    const right = Math.max(0, round(maxX - w)) + fudgeX
    const top = Math.max(0, round(-minY)) + round(glyphTop) + fudgeY
    const bottom = Math.max(0, round(maxY - h)) + round(glyphBottom) + fudgeY
    if (left === 0 && right === 0 && top === 0 && bottom === 0) return null
    return {left, right, top, bottom}
  }

  /**
   * Skew 文字若 line-height < font-size，background-clip:text 会裁掉字脚。
   * 行高抬到 fontSize，并用 shiftY 把行盒中心钉回原稿行盒。
   */
  function skewedTextLineBoxFix(node, layout) {
    if (node?.type !== 'TEXT' || !hasLayoutSkew(layout)) return null
    const text = node.styles?.text
    const fs = text?.fontSize
    if (typeof fs !== 'number' || !(fs > 0)) return null
    const lhCss = resolveLineHeightCssValue(
      {...text, fontSize: fs},
      layout,
      (n) => n,
    )
    let lh = typeof layout.height === 'number' ? layout.height : fs
    if (typeof lhCss === 'number') lh = lhCss
    else if (typeof lhCss === 'string' && lhCss.endsWith('px')) {
      const n = parseFloat(lhCss)
      if (Number.isFinite(n)) lh = n
    }
    if (!(fs > lh + 0.5)) return null
    return {
      lineHeightPx: fs,
      shiftY: round((lh - fs) / 2),
    }
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

  /** 已烘焙视觉的节点：用 AABB 尺寸/位置，不再叠 rotate/skew */
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
      Math.abs(layout.rotation) > 0.01 &&
      !hasLayoutSkew(layout)
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
    layout.skewX = undefined
    layout.skewY = undefined
    layout.transform = undefined
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

  /** Auto Layout 中参与主轴排布的子项（绝对定位不占位） */
  function flowAutoLayoutChildren(node) {
    return (node.children || []).filter(
      (c) => c.visible !== false && c.layout?.layoutPositioning !== 'ABSOLUTE',
    )
  }

  /**
   * SPACE_BETWEEN 子项总尺寸相对内容盒的溢出量（>0 表示放不下）。
   * 超出时 CSS space-between / margin:auto 都会失效（负自由空间当 0），
   * 而 Figma 仍把首尾钉在 padding 内缘，允许子项重叠。
   */
  function spaceBetweenOverflowAmount(node, layout) {
    if (layout?.primaryAxisAlignItems !== 'SPACE_BETWEEN') return 0
    const kids = flowAutoLayoutChildren(node)
    if (kids.length < 2) return 0
    const isVert = layout.layoutMode === 'VERTICAL'
    const pad = layout.padding || {}
    const padStart = isVert ? (pad.top ?? 0) : (pad.left ?? 0)
    const padEnd = isVert ? (pad.bottom ?? 0) : (pad.right ?? 0)
    const inner = (isVert ? layout.height : layout.width) - padStart - padEnd
    if (!(inner > 0)) return 0
    let total = 0
    for (const child of kids) {
      const size = isVert
        ? (child.layout?.height ?? 0)
        : (child.layout?.width ?? 0)
      total += size
    }
    const overflow = total - inner
    return overflow > 0.5 ? overflow : 0
  }

  /**
   * 主轴 justify-content。
   * CSS 的 space-between 在仅 1 个子项时等价于 flex-start；
   * Figma SPACE_BETWEEN（Gap: Auto）单子项时实际位置多为居中，需对齐画布。
   * 子项溢出内容盒时改 flex-start，末项用负 margin 钉尾（见下）。
   */
  function autoLayoutMainJustify(node, layout) {
    if (isTopPackedAutoLayout(node)) return 'flex-start'
    if (layout.primaryAxisAlignItems === 'SPACE_BETWEEN') {
      const flow = flowAutoLayoutChildren(node)
      if (flow.length <= 1) return 'center'
      if (spaceBetweenOverflowAmount(node, layout) > 0) return 'flex-start'
    }
    return alignMain(layout.primaryAxisAlignItems)
  }

  /**
   * 溢出的 SPACE_BETWEEN：末个流式子项加负 margin，使其右/下缘对齐 padding 内缘。
   * （margin:auto 在负剩余空间时会被当成 0，不能用。）
   */
  function appendSpaceBetweenOverflowMargin(
    css,
    node,
    parent,
    parentAutoLayout,
  ) {
    if (!parentAutoLayout || !parent?.layout) return
    const overflow = spaceBetweenOverflowAmount(parent, parent.layout)
    if (!(overflow > 0)) return
    const flow = flowAutoLayoutChildren(parent)
    if (flow.length < 2) return
    if (flow[flow.length - 1]?.id !== node.id) return
    const pull = round(overflow)
    if (parent.layout.layoutMode === 'VERTICAL') {
      css.push(`margin-top:-${ux(pull)}`)
    } else {
      css.push(`margin-left:-${ux(pull)}`)
    }
  }

  /**
   * 子树内是否存在「会被渲成 position:absolute」的节点（含嵌套，不含自身）。
   * 自由定位父级下 layoutPositioning=AUTO 的子项在 HTML 里也是 absolute，
   * 不能只看 ABSOLUTE 标记。
   */
  function subtreeHasRenderedAbsolute(node) {
    const parentIsAuto = !!node.layout?.layoutMode
    for (const child of node.children || []) {
      if (child.visible === false) continue
      const childAbsolute =
        !parentIsAuto || child.layout?.layoutPositioning === 'ABSOLUTE'
      if (childAbsolute) return true
      if (subtreeHasRenderedAbsolute(child)) return true
    }
    return false
  }

  /**
   * 按 Figma 图层顺序写 z-index（先声明在下、后声明在上）。
   *
   * 1) Auto Layout 内混有 ABSOLUTE 子项，或流式子项**子树**里会渲成 absolute：
   *    嵌套 abspos（如 logo 内铺满卡片的 Frame）写了 z-index 后会泄漏到 AL
   *    祖先，盖住后面的流式兄弟（footer 被头像区挡住）。给 AL 流式兄弟都
   *    写 z-index + position:relative，把子树层级关进各自 stacking context。
   * 2) 自由定位（非 AL）父级：子项虽均为 absolute，但若某子树内部又写了
   *    z-index，而该子项自身 z-index:auto，则同样会泄漏；给自由定位兄弟
   *    都写上 z-index，对齐 Figma。
   */
  function appendSiblingStackOrder(
    css,
    node,
    parent,
    parentAutoLayout,
    useAbsolute,
  ) {
    if (!parent?.children?.length) return
    const siblings = parent.children.filter((c) => c.visible !== false)
    if (siblings.length <= 1) return

    if (parentAutoLayout) {
      const needsStackOrder = siblings.some(
        (c) =>
          c.layout?.layoutPositioning === 'ABSOLUTE' ||
          subtreeHasRenderedAbsolute(c),
      )
      if (!needsStackOrder) return
    }

    const index = siblings.findIndex((c) => c.id === node.id)
    if (index < 0) return
    if (parentAutoLayout && !useAbsolute) {
      const hasPos = css.some((s) => s.startsWith('position:'))
      if (!hasPos) css.push('position:relative')
    }
    css.push(`z-index:${index}`)
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

    // mix-blend 与 filter 同元素会隔离合成，导致 LINEAR_DODGE 等加亮失效；
    // filter 延后到 isolatedFilter，由 HTML 包一层再画。
    const preferCssBlurGradient = shouldPreferCssBlurGradient(node)
    let mixBlend = mixBlendModeCss(node.blendMode)
    // 标题下暖色光条在深色底上需加亮混合才接近稿面
    if (!mixBlend && preferCssBlurGradient) {
      mixBlend = 'plus-lighter'
    }
    if (typeof node.opacity === 'number' && node.opacity < 1) {
      css.push(`opacity:${round(node.opacity)}`)
    }
    if (mixBlend) css.push(`mix-blend-mode:${mixBlend}`)

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
      css.push(`justify-content:${autoLayoutMainJustify(node, layout)}`)
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

    appendSiblingStackOrder(css, node, parent, parentAutoLayout, useAbsolute)

    if (parentAutoLayout && !useAbsolute && layout.layoutGrow) {
      css.push(`flex-grow:${layout.layoutGrow}`)
    }
    if (parentAutoLayout && !useAbsolute) {
      // Figma 固定尺寸子项不会因父容器空间不足而收缩。
      css.push('flex-shrink:0')
    }
    if (parentAutoLayout && !useAbsolute) {
      appendSpaceBetweenOverflowMargin(css, node, parent, parentAutoLayout)
    }
    if (parentAutoLayout && !useAbsolute && layout.layoutAlign === 'STRETCH') {
      css.push('align-self:stretch')
    }

    const transforms = []
    // 切图（png/svg/flattened）像素已含旋转/剪切；effectiveLayout 已改包围盒并清仿射字段。
    // 未烘焙时：位图填充的 imageHash 是源图，节点变换应靠导出侧切图烘焙，
    // 这里不再用 CSS 去「猜」——AL 原点与 Figma 不一致，易旋出裁剪区。
    // 仅对无位图填充的未烘焙节点保留 CSS matrix/rotate 兜底。
    // Skew 插件：layout.transform / skewX·skewY → CSS matrix（含单位轴剪切）。
    const hasImageFill = (styles.fills || []).some(
      (paint) =>
        paint &&
        paint.visible !== false &&
        paint.type === 'IMAGE' &&
        paint.imageHash,
    )
    let rotateAroundCenter = false
    if (!visualBaked && !hasImageFill && hasLayoutSkew(layout)) {
      const matrixCss =
        cssMatrixFromLayoutTransform(layout.transform) ||
        cssMatrixFromSkewAngles(layout.skewX, layout.skewY)
      if (matrixCss) {
        transforms.push(matrixCss)
        // matrix 已含 rotation，勿再叠 rotate
        rotateAroundCenter = parentAutoLayout && !useAbsolute
      }
    } else if (
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
    const individualStrokeWeights = strokes.length
      ? {
          top:
            typeof styles.strokeTopWeight === 'number'
              ? round(styles.strokeTopWeight)
              : null,
          right:
            typeof styles.strokeRightWeight === 'number'
              ? round(styles.strokeRightWeight)
              : null,
          bottom:
            typeof styles.strokeBottomWeight === 'number'
              ? round(styles.strokeBottomWeight)
              : null,
          left:
            typeof styles.strokeLeftWeight === 'number'
              ? round(styles.strokeLeftWeight)
              : null,
        }
      : null
    const hasIndividualStroke =
      !!individualStrokeWeights &&
      [
        individualStrokeWeights.top,
        individualStrokeWeights.right,
        individualStrokeWeights.bottom,
        individualStrokeWeights.left,
      ].some((v) => typeof v === 'number' && v > 0)
    // mixed 旧 JSON 未带四边宽度时：有描边色则回退 1px，避免列表分割线丢失
    const strokeWeightFallback =
      strokes.length &&
      typeof styles.strokeWeight !== 'number' &&
      !hasIndividualStroke
        ? 1
        : 0
    const strokeWeight =
      strokes.length && typeof styles.strokeWeight === 'number'
        ? round(styles.strokeWeight)
        : hasIndividualStroke
          ? Math.max(
              individualStrokeWeights.top || 0,
              individualStrokeWeights.right || 0,
              individualStrokeWeights.bottom || 0,
              individualStrokeWeights.left || 0,
            )
          : strokeWeightFallback
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
    const strokePaint = strokeWeight > 0 ? strokes[strokes.length - 1] : null
    // 单边描边改走绝对定位细线（见 strokeOverlay），避免被盖住/裁切
    let strokeOverlay = null
    // 渐变描边 + 半透明填充：用 mask 只画边框环（见 gradientBorderMask）
    let gradientBorderMask = null
    const translucentFills = fillsLookTranslucent(styles.fills)
    // border-color 不支持渐变；不透明填充时可用底层渐变 clip 到边框区
    const useGradientBorder =
      strokeIsGradient &&
      !isText &&
      styles.strokeAlign !== 'OUTSIDE' &&
      styles.strokeAlign !== 'CENTER' &&
      !hasIndividualStroke &&
      !translucentFills
    if (
      strokeIsGradient &&
      !isText &&
      styles.strokeAlign !== 'OUTSIDE' &&
      styles.strokeAlign !== 'CENTER' &&
      !hasIndividualStroke &&
      translucentFills
    ) {
      gradientBorderMask = {
        gradient: strokeColor,
        width: strokeWeight || 1,
        blendMode: strokePaint?.blendMode || null,
      }
    }

    // 导出的 SVG/PNG 已含 fill/stroke，重复映射会把图标覆盖成色块。
    // 矮模糊光条例外：用 fills + CSS blur，避免 PNG 再模糊发暗。
    if (!node.svg && !node.png && (!node.pngRef || preferCssBlurGradient)) {
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
        const images = imageLayers.map((layer) => `url("${layer.image}")`)
        const sizes = imageLayers.map((layer) => layer.size)
        const positions = imageLayers.map((layer) => layer.position || 'center')
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
            ? [cssLooksLikeGradient(bg) ? bg : solidColorAsGradientLayer(bg)]
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
    } else if (useGradientBorder || gradientBorderMask) {
      css.push(
        `border:${ux(strokeWeight || gradientBorderMask?.width || 1)} solid transparent`,
      )
    } else if (
      strokeColor &&
      hasIndividualStroke &&
      styles.strokeAlign !== 'OUTSIDE'
    ) {
      const t = individualStrokeWeights.top || 0
      const r = individualStrokeWeights.right || 0
      const b = individualStrokeWeights.bottom || 0
      const l = individualStrokeWeights.left || 0
      const sideOverlay = singleSideStrokeOverlay(
        individualStrokeWeights,
        strokeColor,
      )
      if (sideOverlay) {
        strokeOverlay = sideOverlay
      } else {
        css.push('border-style:solid')
        css.push(`border-color:${strokeColor}`)
        css.push(`border-width:${ux(t)} ${ux(r)} ${ux(b)} ${ux(l)}`)
      }
    } else if (
      strokeColor &&
      strokeWeightFallback > 0 &&
      styles.strokeAlign !== 'OUTSIDE'
    ) {
      // 旧导出丢失 mixed 边宽：列表行常见为底部分割线
      strokeOverlay = {
        side: 'bottom',
        width: strokeWeightFallback,
        color: strokeColor,
      }
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
    // 绝对定位细线 / mask 描边需要 position:relative 作包含块
    if (
      (strokeOverlay || gradientBorderMask) &&
      !css.some(
        (p) =>
          p === 'position:absolute' ||
          p === 'position:relative' ||
          p === 'position:fixed',
      )
    ) {
      css.push('position:relative')
    }

    const blurs = blurFilters(styles.effects)
    const filterParts = [...shadow.dropFilters]
    const titleGlowBlur = preferCssBlurGradient
      ? titleGlowBlurCss(styles.effects)
      : null
    if (titleGlowBlur) {
      filterParts.push(titleGlowBlur)
    } else if (blurs.filter) {
      filterParts.push(blurs.filter)
    }
    const filterCss = filterParts.length ? filterParts.join(' ') : null
    // 与 mix-blend-mode 并存时，filter 放到内层，避免 stacking isolation 吃掉加亮
    let isolatedFilter = null
    if (filterCss && mixBlend) {
      isolatedFilter = filterCss
    } else if (filterCss) {
      css.push(`filter:${filterCss}`)
    }
    if (blurs.backdrop) {
      css.push(`backdrop-filter:${blurs.backdrop}`)
      css.push(`-webkit-backdrop-filter:${blurs.backdrop}`)
    }

    const lineBoxFix = skewedTextLineBoxFix(node, layout)
    const skewTextSplit =
      node.type === 'TEXT' &&
      hasLayoutSkew(layout) &&
      transforms.length > 0 &&
      !rotateAroundCenter
    let textInnerCss = null
    if (transforms.length) {
      css.push(`transform:${transforms.join(' ')}`)
      if (skewTextSplit) {
        // 外层：transform + 扩盒 padding；内层：bg-clip（二者同元素会裁 p 字脚）
        const inset = skewPaintInset(layout, node) || {
          top: 2,
          right: 2,
          bottom: 4,
          left: 2,
        }
        const padT = Math.max(inset.top, 2)
        const padR = Math.max(inset.right, 2)
        const padB = Math.max(inset.bottom, 4)
        const padL = Math.max(inset.left, 2)
        css.push(`transform-origin:${ux(padL)} ${ux(padT)}`)
        css.push('overflow:visible')
        css.push(`padding:${ux(padT)} ${ux(padR)} ${ux(padB)} ${ux(padL)}`)
        let mTop = -padT
        let mBottom = -padB
        if (lineBoxFix?.shiftY) {
          mTop += lineBoxFix.shiftY
          mBottom -= lineBoxFix.shiftY
        }
        css.push(
          `margin:${ux(mTop)} ${ux(-padR)} ${ux(mBottom)} ${ux(-padL)}`,
        )
      } else {
        css.push(
          rotateAroundCenter
            ? 'transform-origin:center'
            : 'transform-origin:top left',
        )
      }
    }

    if (node.type === 'TEXT') {
      if (!skewTextSplit) css.push('margin:0')
      let textCss = textStyleCss(node)
      if (lineBoxFix) {
        textCss = textCss.filter((s) => !String(s).startsWith('line-height:'))
        textCss.push(`line-height:${ux(lineBoxFix.lineHeightPx)}`)
      }
      if (skewTextSplit) {
        const fillKeys = new Set([
          'color',
          'background',
          'background-image',
          'background-size',
          'background-position',
          'background-repeat',
          'background-clip',
          '-webkit-background-clip',
          '-webkit-text-fill-color',
          'text-shadow',
        ])
        const fillParts = []
        const kept = []
        for (const part of css) {
          const key = String(part).split(':')[0].trim()
          if (fillKeys.has(key)) fillParts.push(part)
          else kept.push(part)
        }
        css.length = 0
        css.push(...kept)
        // 内层：仅排版 + 填色 clip，不加 transform / 负 margin
        textInnerCss = [
          'display:block',
          ...textCss,
          ...textWrapCss(node),
          ...fillParts,
        ].join(';')
      } else {
        css.push(...textCss)
        css.push(...textWrapCss(node))
      }
    }

    return {
      css: css.join(';'),
      isolatedFilter,
      strokeOverlay,
      gradientBorderMask,
      textInnerCss,
    }
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
   * 按 Google 族名聚合字重与斜体，避免单字重字体请求多余 wght 失败。
   */
  function resolveGoogleFontImports(root, fontRefs) {
    /** @type {Map<string, {normal: Set<number>, italic: Set<number>}>} */
    const byGoogleFamily = new Map()
    /** @type {Set<number>} */
    const sfProWeights = new Set()

    const ensureFamily = (googleFamily) => {
      if (!byGoogleFamily.has(googleFamily)) {
        byGoogleFamily.set(googleFamily, {
          normal: new Set(),
          italic: new Set(),
        })
      }
      return byGoogleFamily.get(googleFamily)
    }

    const addRef = (ref) => {
      if (!ref?.family) return
      const family = ref.family
      const weight = cssFontWeight(ref.weight) ?? MIN_CSS_FONT_WEIGHT
      const italic = isItalicFontStyle(ref.style)
      if (
        isSystemFontFamily(family) &&
        String(family).toLowerCase().includes('sf pro')
      ) {
        sfProWeights.add(weight)
        return
      }
      if (isSystemFontFamily(family)) return
      if (ref.provider && ref.provider !== 'google') return
      const googleFamily = GOOGLE_FONT_FAMILY_MAP[family]
      if (!googleFamily) return
      const bucket = ensureFamily(googleFamily)
      if (italic) bucket.italic.add(weight)
      else bucket.normal.add(weight)
    }

    if (Array.isArray(fontRefs) && fontRefs.length) {
      for (const ref of fontRefs) addRef(ref)
    } else {
      // 兼容旧 node.json：无 fonts 字段时从树推导
      const walk = (node) => {
        if (node.visible === false) return
        const fontName = node.styles?.text?.fontName
        if (fontName?.family) {
          const family = fontName.family
          addRef({
            family,
            style: fontName.style,
            weight: node.styles?.text?.fontWeight,
            provider: GOOGLE_FONT_FAMILY_MAP[family] ? 'google' : 'unknown',
          })
        }
        for (const child of node.children || []) walk(child)
      }
      walk(root)
    }

    // SF Pro 无法外链：额外加载 Inter 作为栈内回退（font-family 中排在 SF Pro 之后）
    if (sfProWeights.size) {
      const bucket = ensureFamily('Inter')
      for (const w of sfProWeights) bucket.normal.add(w)
    }

    return [...byGoogleFamily.entries()].map(([family, buckets]) => ({
      family,
      weights: [...buckets.normal].sort((a, b) => a - b),
      italicWeights: [...buckets.italic].sort((a, b) => a - b),
    }))
  }

  function googleFontsLinkFromImports(imports) {
    if (!imports.length) return ''
    const q = imports
      .map(({family, weights = [], italicWeights = []}) => {
        const name = encodeURIComponent(family).replace(/%20/g, '+')
        if (italicWeights.length) {
          // CSS2：ital,wght@0,400;1,800 — 0 正体，1 斜体
          const pairs = [
            ...weights.map((w) => `0,${w}`),
            ...italicWeights.map((w) => `1,${w}`),
          ]
          return `family=${name}:ital,wght@${pairs.join(';')}`
        }
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
   * 1. 始终以 Figma 指定的 family 为第一候选
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

    // 1. 设计字体名始终第一（保留 SF Pro Display/Text 等指定族名）
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
        {
          const segItalic = isItalicFontStyle(seg.fontName?.style)
          const baseItalic = isItalicFontStyle(baseline.fontName?.style)
          if (segItalic !== baseItalic) {
            parts.push(`font-style:${segItalic ? 'italic' : 'normal'}`)
          }
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
    shouldPreferCssBlurGradient,
  }
}
