/**
 * 样式序列化原语：Paint / Effect / 颜色 的归一化。
 *
 * 为什么单独抽成一个模块：
 * 这些函数原本住在 code.ts 里。桥接（src/bridge）当初为了绕开
 * code.ts → bridge → ops 的循环依赖，复制了一份平行实现，
 * 于是两份实现开始各自演化（比如桥接版多了 css 字符串、做了 toFixed）。
 *
 * 现在抽到这里：code.ts 和 bridge 都 import 它，没有环，
 * 也就不再有"同一个渐变在导出 JSON 里和 MCP 返回值里长得不一样"的问题。
 *
 * 约束：本模块只做纯数据转换，不读写文档、不访问 figma 全局（figma.mixed 除外）。
 */

export type TransformMatrix = [[number, number, number], [number, number, number]]

type RgbaColor = RGB | RGBA

const toByte = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v * 255)))
    .toString(16)
    .padStart(2, '0')

/** Figma 的 0~1 浮点色 → #RRGGBB（alpha < 1 时带 #RRGGBBAA） */
export const rgbaToHex = (color: RgbaColor, opacity = 1): string => {
  const a = 'a' in color ? color.a * opacity : opacity
  const rgb = `#${toByte(color.r)}${toByte(color.g)}${toByte(color.b)}`
    if (a >= 1) return rgb.toUpperCase()
  return `${rgb}${toByte(a)}`.toUpperCase()
}

/**
 * gradientTransform → 近似 CSS 的 linear-gradient 角度。
 *
 * 矩阵形如 [[a, c, tx], [b, d, ty]]，梯度默认沿局部 +x 轴；
 * CSS 里 0deg 指向上、顺时针为正，所以先算 atan2 再补偿 90°。
 * Figma 的 y 轴朝下，因此用 (b, a) 而不是 (a, b)。
 */
export const gradientCssAngle = (t: TransformMatrix): number => {
  const radians = Math.atan2(t[1][0], t[0][0])
  const deg = (radians * 180) / Math.PI + 90
  return Math.round(((deg % 360) + 360) % 360)
}

/** 线性渐变的可直接粘贴的 CSS 值；非线性返回 undefined */
export const gradientCssValue = (paint: GradientPaint): string | undefined => {
  if (paint.type !== 'GRADIENT_LINEAR') return undefined
  const angle = gradientCssAngle(paint.gradientTransform as TransformMatrix)
  const stops = paint.gradientStops.map(
    (s) => `${rgbaToHex(s.color)} ${(s.position * 100).toFixed(2)}%`,
  )
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`
}

const isGradient = (paint: Paint): paint is GradientPaint =>
  paint.type.startsWith('GRADIENT_')

/**
 * 单个 Paint → 可读 JSON。
 * 颜色统一成 HEX，渐变补上 cssAngle / css，图片保留 imageHash（可据此去重）。
 */
export const serializePaint = (paint: Paint): Record<string, unknown> => {
  if (paint.type === 'SOLID') {
    return {
      type: 'SOLID',
      color: rgbaToHex(paint.color, paint.opacity ?? 1),
      opacity: paint.opacity ?? 1,
      visible: paint.visible !== false,
      blendMode: paint.blendMode,
    }
  }

  if (isGradient(paint)) {
    return {
      type: paint.type,
      opacity: paint.opacity ?? 1,
      visible: paint.visible !== false,
      blendMode: paint.blendMode,
      stops: paint.gradientStops.map((stop) => ({
        position: stop.position,
        color: rgbaToHex(stop.color),
      })),
      gradientTransform: paint.gradientTransform,
      cssAngle:
        paint.type === 'GRADIENT_LINEAR'
          ? gradientCssAngle(paint.gradientTransform as TransformMatrix)
          : undefined,
      css: gradientCssValue(paint),
    }
  }

  if (paint.type === 'IMAGE') {
    return {
      type: 'IMAGE',
      opacity: paint.opacity ?? 1,
      visible: paint.visible !== false,
      blendMode: paint.blendMode,
      // 同一张图在不同节点上 hash 相同，可直接用于去重/缓存
      imageHash: paint.imageHash ?? null,
      scaleMode: paint.scaleMode,
      imageTransform: paint.imageTransform,
      rotation: paint.rotation,
      scalingFactor: paint.scalingFactor,
      filters: paint.filters,
    }
  }

  // VIDEO / PATTERN 等：原样透出，避免丢字段
  return {
    type: paint.type,
    opacity: paint.opacity ?? 1,
    visible: paint.visible !== false,
    blendMode: 'blendMode' in paint ? paint.blendMode : undefined,
  }
}

export const serializePaints = (
  paints: readonly Paint[],
): Record<string, unknown>[] => paints.map(serializePaint)

/** 单个 Effect → 可读 JSON（阴影 / 模糊） */
export const serializeEffect = (effect: Effect): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    type: effect.type,
    visible: effect.visible !== false,
  }

  if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
    const shadow = effect as DropShadowEffect | InnerShadowEffect
    return {
      ...base,
      radius: shadow.radius,
      color: rgbaToHex(shadow.color),
      offset: {x: shadow.offset.x, y: shadow.offset.y},
      spread: shadow.spread,
      blendMode: shadow.blendMode,
    }
  }

  if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
    const blur = effect as BlurEffect
    return {...base, radius: blur.radius}
  }

  return base
}

export const serializeEffects = (
  effects: readonly Effect[],
): Record<string, unknown>[] => effects.map(serializeEffect)