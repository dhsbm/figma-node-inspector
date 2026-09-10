/**
 * Figma 布局能力在 HTML/CSS 中无法自动还原时的标记（如布尔减挖空）。
 */

export const HTML_LAYOUT_WARNING_KIND = {
  BOOLEAN_SUBTRACT_PUNCH: 'BOOLEAN_SUBTRACT_PUNCH',
}

/** 小于该尺寸（较长边）的 Subtract 视为图标裁切，不标记 */
const PUNCH_MIN_MAX_DIM = 48
/** 或面积达到该阈值（px²） */
const PUNCH_MIN_AREA = 2500

export const HTML_LAYOUT_WARNING_COPY = {
  [HTML_LAYOUT_WARNING_KIND.BOOLEAN_SUBTRACT_PUNCH]: {
    message:
      'Figma 布尔减运算（区域挖空）：HTML/CSS 无法自动还原透视下层内容',
    suggestion:
      '请人工调整节点层级，或将带透明区域的背景单独切图后再叠放',
    shortLabel: '挖空·需人工',
  },
}

function nodeLayoutSize(node) {
  const layout = node?.layout || {}
  const w = typeof layout.width === 'number' ? layout.width : 0
  const h = typeof layout.height === 'number' ? layout.height : 0
  return {w, h, max: Math.max(w, h), area: w * h}
}

function isLargeEnoughForPunch(layout, children) {
  const {max, area} = nodeLayoutSize({layout})
  if (max >= PUNCH_MIN_MAX_DIM || area >= PUNCH_MIN_AREA) return true
  const base = children?.[0]
  if (!base?.layout) return false
  const baseSize = nodeLayoutSize(base)
  return (
    baseSize.max >= PUNCH_MIN_MAX_DIM || baseSize.area >= PUNCH_MIN_AREA
  )
}

/**
 * @param {'UNION'|'INTERSECT'|'SUBTRACT'|'EXCLUDE'|string} booleanOperation
 * @param {{width?:number,height?:number}} layout
 * @param {number} childCount
 * @param {object[]|undefined} children
 */
export function shouldMarkBooleanSubtractPunch(
  booleanOperation,
  layout,
  childCount,
  children,
) {
  if (booleanOperation !== 'SUBTRACT') return false
  if (childCount < 2) return false
  return isLargeEnoughForPunch(layout, children)
}

export function buildBooleanSubtractPunchWarning(booleanOperation = 'SUBTRACT') {
  const copy = HTML_LAYOUT_WARNING_COPY[HTML_LAYOUT_WARNING_KIND.BOOLEAN_SUBTRACT_PUNCH]
  return {
    kind: HTML_LAYOUT_WARNING_KIND.BOOLEAN_SUBTRACT_PUNCH,
    booleanOperation,
    htmlSupported: false,
    message: copy.message,
    suggestion: copy.suggestion,
  }
}

/** 从已序列化的 NodeInfo 判定；无 booleanOperation 时回退名称启发 */
export function detectHtmlLayoutWarning(node) {
  if (!node || node.type !== 'BOOLEAN_OPERATION') return null
  if (node.htmlLayoutWarning) return node.htmlLayoutWarning

  const op =
    node.booleanOperation ||
    (/\bsubtract\b/i.test(String(node.name || '')) ? 'SUBTRACT' : null)
  const childCount =
    typeof node.childCount === 'number'
      ? node.childCount
      : node.children?.length || 0

  if (
    !shouldMarkBooleanSubtractPunch(
      op,
      node.layout,
      childCount,
      node.children,
    )
  ) {
    return null
  }

  return buildBooleanSubtractPunchWarning(op || 'SUBTRACT')
}

export function collectHtmlLayoutWarnings(nodes, out = []) {
  for (const node of nodes || []) {
    const warning = detectHtmlLayoutWarning(node)
    if (warning) {
      out.push({
        id: node.id,
        name: node.name,
        type: node.type,
        ...warning,
      })
    }
    if (node.children?.length) collectHtmlLayoutWarnings(node.children, out)
  }
  return out
}

/** 为 inspect / 导出根对象附加汇总字段 */
export function attachHtmlLayoutWarningsToData(data) {
  if (!data?.nodes?.length) return data
  const warnings = collectHtmlLayoutWarnings(data.nodes)
  data.htmlLayoutWarningCount = warnings.length
  data.htmlLayoutWarnings = warnings
  return data
}

export function htmlLayoutWarningShortLabel(warning) {
  if (!warning?.kind) return '需人工'
  return HTML_LAYOUT_WARNING_COPY[warning.kind]?.shortLabel || '需人工'
}

/**
 * 为 HTML 元素追加 data-* / class / title
 * @param {string[]} attrs
 * @param {object} node
 * @param {(s:string)=>string} esc
 */
export function appendHtmlLayoutWarningAttrs(attrs, node, esc) {
  const warning = detectHtmlLayoutWarning(node)
  if (!warning) return warning

  const shortLabel = htmlLayoutWarningShortLabel(warning)
  attrs.push(`data-html-layout-warning="${esc(warning.kind)}"`)
  attrs.push('data-html-supported="false"')
  attrs.push(
    `data-html-layout-hint="${esc(`${warning.message} ${warning.suggestion}`)}"`,
  )
  attrs.push(`data-html-layout-hint-short="${esc(shortLabel)}"`)
  attrs.push('class-add="figma-html-layout-warning"')
  attrs.push(
    `title="${esc(`⚠ ${warning.message} — ${warning.suggestion}`)}"`,
  )
  return warning
}

/** 合并 class 属性（appendHtmlLayoutWarningAttrs 用 class-add 占位） */
export function finalizeHtmlAttrs(attrs, baseClass) {
  const out = []
  let cls = baseClass
  for (const attr of attrs) {
    if (attr.startsWith('class-add="')) {
      const add = attr.slice(11, -1)
      cls = cls ? `${cls} ${add}` : add
      continue
    }
    out.push(attr)
  }
  const classIdx = out.findIndex((a) => a.startsWith('class="'))
  if (classIdx >= 0) {
    out[classIdx] = `class="${cls}"`
  }
  return out
}

export function htmlLayoutWarningComment(node, esc) {
  const warning = detectHtmlLayoutWarning(node)
  if (!warning) return ''
  return (
    `<!-- ⚠ HTML_LAYOUT_WARNING: ${esc(warning.kind)} — ` +
    `${esc(warning.message)} ${esc(warning.suggestion)} -->\n`
  )
}

export function htmlLayoutWarningCss() {
  return `
    [data-html-layout-warning] {
      outline: 2px dashed #f59e0b !important;
      outline-offset: 2px;
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.25);
    }
    [data-html-layout-warning][data-type="TEXT"]::after,
    div[data-html-layout-warning]::after {
      content: attr(data-html-layout-hint-short);
      position: absolute;
      top: 0;
      left: 0;
      z-index: 9999;
      max-width: 100%;
      padding: 2px 6px;
      font-size: 10px;
      line-height: 1.3;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #78350f;
      background: rgba(254, 243, 199, 0.95);
      border: 1px solid #f59e0b;
      border-radius: 4px;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `
}
