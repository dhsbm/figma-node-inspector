/**
 * 将 Figma lineHeight: AUTO 解析为 CSS 可用的 px。
 *
 * 插件侧优先：单行探针测量 → 写入 lineHeightPx。
 * 生成侧：优先用 lineHeightPx；旧 JSON 无该字段时再按盒高反推。
 */

function roundPx(n) {
  return Math.round(n * 1000) / 1000
}

function countExplicitLines(chars) {
  if (!chars.length) return 1
  return chars.split('\n').length
}

/**
 * 推断多行文本的视觉行数（旧导出回退）。
 * 在 [fontSize, fontSize×1.5] 内找能整除盒高的整数行高，
 * 优先最接近 fontSize×1.2（例如 12px → 17，374/17=22）。
 *
 * @param {number} boxH
 * @param {number} fontSize
 * @param {number} minLines
 * @returns {number}
 */
function inferWrappedLineCount(boxH, fontSize, minLines) {
  const typical = fontSize * 1.2

  const snapped = []
  for (let lh = Math.ceil(fontSize); lh <= Math.floor(fontSize * 1.5); lh++) {
    snapped.push(lh)
  }
  snapped.sort((a, b) => Math.abs(a - typical) - Math.abs(b - typical))

  for (const lh of snapped) {
    const nRaw = boxH / lh
    const n = Math.round(nRaw)
    if (n >= minLines && Math.abs(nRaw - n) <= 1e-6) return n
  }

  return Math.max(minLines, Math.round(boxH / typical))
}

/**
 * @param {{
 *   characters?: string
 *   fontSize?: number
 *   textAutoResize?: string
 *   maxLines?: number | null
 * }} text
 * @param {{ width?: number, height?: number }} layout
 * @returns {number | null}
 */
export function resolveAutoLineHeightPx(text, layout = {}) {
  const fontSize = text?.fontSize
  const boxH = layout.height
  if (typeof fontSize !== 'number' || typeof boxH !== 'number' || boxH <= 0) {
    return null
  }

  const chars = text.characters || ''
  const autoResize = text.textAutoResize
  const explicitLines = countExplicitLines(chars)

  // 单行自适应：盒高即行高
  if (
    autoResize === 'WIDTH_AND_HEIGHT' &&
    explicitLines === 1 &&
    !chars.includes('\n')
  ) {
    return roundPx(boxH)
  }

  const lineCount =
    autoResize === 'WIDTH_AND_HEIGHT'
      ? explicitLines
      : inferWrappedLineCount(boxH, fontSize, explicitLines)

  return roundPx(boxH / Math.max(1, lineCount))
}

/**
 * @param {object} text node.styles.text
 * @param {{ width?: number, height?: number }} layout node.layout
 * @returns {string | null} CSS line-height 值（带 px 或 null）
 */
export function resolveLineHeightCssValue(text, layout, ux) {
  if (!text?.lineHeight || text.lineHeight === 'mixed') {
    if (typeof text?.lineHeightPx === 'number') {
      return ux(text.lineHeightPx)
    }
    return null
  }

  const lh = text.lineHeight
  const fontSize = text.fontSize

  if (lh.unit === 'PIXELS' && typeof lh.value === 'number') {
    return ux(lh.value)
  }

  if (lh.unit === 'PERCENT' && typeof lh.value === 'number' && fontSize) {
    return ux((fontSize * lh.value) / 100)
  }

  if (lh.unit === 'AUTO') {
    const inferred = resolveAutoLineHeightPx(text, layout)

    // 优先插件单行探针；以下情况视为探针失效，改用盒高反推：
    // 1) 旧导出卡在 fontSize×1.2 附近且与整除反推不一致
    // 2) 探针高度≈多行盒高（克隆未重排，把整段高度当成了行高）
    if (typeof text.lineHeightPx === 'number') {
      const typical =
        typeof fontSize === 'number' ? fontSize * 1.2 : null
      const stuckOnTypical =
        typical != null && Math.abs(text.lineHeightPx - typical) < 0.05
      const boxH = layout?.height
      const probeEqualsBox =
        typeof boxH === 'number' &&
        boxH > 0 &&
        Math.abs(text.lineHeightPx - boxH) < 0.5
      const inferredShorter =
        inferred != null && inferred < text.lineHeightPx - 0.5
      if (
        inferredShorter &&
        (stuckOnTypical || probeEqualsBox)
      ) {
        return ux(inferred)
      }
      return ux(text.lineHeightPx)
    }

    if (inferred != null) return ux(inferred)
  }

  return null
}
