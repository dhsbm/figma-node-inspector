/**
 * 由 Figma 导出 JSON 生成完整 HTML 文档（Node / 浏览器共用）。
 *
 * @param {object} data node.json 结构
 * @param {{
 *   sourceLabel?: string,
 *   imageMode?: 'inline' | 'external',
 *   chrome?: 'full' | 'minimal',
 *   imageSrcForHash?: (hash: string, asset: object) => string | null,
 *   vectorSrcForId?: (nodeId: string) => string | null,
 *   svgSrcForId?: (nodeId: string) => string | null,
 *   compareDesignSrc?: string | null,
 * }} [options]
 * @returns {{html: string, contrastHtml?: string | null, rootName: string}}
 *   html 始终为一比一样式预览；有 compareDesignSrc 且 chrome 非 minimal
 *   时另返回 contrastHtml（HTML vs 原稿对比页）。
 */
import {
  createFigmaLayout,
  resolveImageAsset,
  resolveNodePng,
  wrapHtmlForContentOverflow,
} from './figma-layout.mjs'
import {buildListIndex, annotateSlots} from './detect-lists.mjs'
import {
  appendHtmlLayoutWarningAttrs,
  collectHtmlLayoutWarnings,
  finalizeHtmlAttrs,
  htmlLayoutWarningComment,
  htmlLayoutWarningCss,
} from './html-layout-warnings.mjs'

function buildCompareChrome({
  body,
  designSrc,
  canvasWidth,
  rootWidth,
  padLeft,
  padTop,
  title,
  fontsLink,
  pageLabel,
  esc,
}) {
  const src = esc(designSrc)
  const designWidth = rootWidth || canvasWidth
  const designPadLeft = padLeft || '0px'
  const designPadTop = padTop || '0px'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)} — HTML vs 原稿</title>
  ${fontsLink}
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background:
        radial-gradient(ellipse at 20% 0%, #1a2740 0%, transparent 50%),
        radial-gradient(ellipse at 80% 100%, #1a2030 0%, transparent 45%),
        #0b0f14;
      color: #e8eaed;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    [data-type="TEXT"] {
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .compare-app {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .compare-bar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 16px;
      padding: 12px 16px;
      background: rgba(11, 15, 20, 0.92);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(10px);
    }
    .compare-title {
      font-size: 13px;
      opacity: 0.7;
      margin-right: auto;
    }
    .compare-modes {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .compare-modes button {
      appearance: none;
      border: 1px solid rgba(255,255,255,0.14);
      background: transparent;
      color: #e8eaed;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    .compare-modes button:hover {
      border-color: rgba(255,255,255,0.28);
    }
    .compare-modes button.active {
      background: #3b82f6;
      border-color: #3b82f6;
      color: #fff;
    }
    .compare-opacity {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      opacity: 0.85;
    }
    .compare-opacity.is-hidden { display: none; }
    .compare-opacity input[type="range"] {
      width: 120px;
    }
    .compare-stage {
      padding: 24px 16px 64px;
      overflow: auto;
    }
    .compare-stage[data-mode="side"] {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 24px;
      align-items: flex-start;
    }
    .compare-stage[data-mode="overlay"],
    .compare-stage[data-mode="html"],
    .compare-stage[data-mode="design"] {
      display: flex;
      justify-content: center;
    }
    .compare-pane {
      position: relative;
      width: ${canvasWidth};
      flex: 0 0 auto;
    }
    .compare-pane-label {
      position: absolute;
      top: -22px;
      left: 0;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      opacity: 0.55;
    }
${htmlLayoutWarningCss()}
    .compare-frame {
      width: ${canvasWidth};
      margin: 0;
      box-shadow: 0 24px 80px rgba(0,0,0,.45);
      background: #111;
      overflow: hidden;
    }
    .design-shot {
      /* design.png 是根帧截图，须按根宽显示，不能拉到溢出画布宽 */
      width: ${designWidth};
      height: auto;
      display: block;
      vertical-align: top;
      margin-left: ${designPadLeft};
      margin-top: ${designPadTop};
    }
    .compare-stage[data-mode="overlay"] .compare-stack {
      position: relative;
      width: ${canvasWidth};
    }
    .compare-stage[data-mode="overlay"] .compare-stack .compare-frame {
      width: 100%;
    }
    .compare-stage[data-mode="overlay"] .overlay-design {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0.5;
    }
    .compare-stage[data-mode="overlay"] .overlay-design .compare-frame {
      box-shadow: none;
    }
    .compare-stage[data-mode="html"] .compare-design,
    .compare-stage[data-mode="design"] .compare-html,
    .compare-stage[data-mode="side"] .compare-stack,
    .compare-stage[data-mode="html"] .compare-stack,
    .compare-stage[data-mode="design"] .compare-stack,
    .compare-stage[data-mode="overlay"] .compare-pane {
      display: none;
    }
    .compare-stage[data-mode="overlay"] .compare-stack {
      display: block;
    }
    .page-label {
      width: 100%;
      max-width: none;
      margin: 0 0 8px;
      font-size: 12px;
      opacity: 0.55;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="compare-app">
    <header class="compare-bar">
      <div class="compare-title">${esc(title)} · HTML vs 原稿</div>
      <div class="compare-modes" role="tablist" aria-label="对比模式">
        <button type="button" data-mode="side" class="active">并排</button>
        <button type="button" data-mode="overlay">叠层</button>
        <button type="button" data-mode="html">仅 HTML</button>
        <button type="button" data-mode="design">仅原稿</button>
      </div>
      <label class="compare-opacity is-hidden" id="compare-opacity">
        原稿透明度
        <input type="range" id="opacity-range" min="0" max="100" value="50" />
        <span id="opacity-value">50%</span>
      </label>
    </header>
    <div class="page-label">${pageLabel}</div>
    <div class="compare-stage" id="compare-stage" data-mode="side">
      <div class="compare-pane compare-html">
        <div class="compare-pane-label">HTML</div>
        <div class="compare-frame">
${body}
        </div>
      </div>
      <div class="compare-pane compare-design">
        <div class="compare-pane-label">原稿</div>
        <div class="compare-frame">
          <img class="design-shot" src="${src}" alt="Figma 原稿" />
        </div>
      </div>
      <div class="compare-stack">
        <div class="compare-frame compare-html-copy">
${body}
        </div>
        <div class="overlay-design">
          <div class="compare-frame">
            <img class="design-shot" src="${src}" alt="Figma 原稿叠层" />
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    (function () {
      var stage = document.getElementById('compare-stage');
      var opacityWrap = document.getElementById('compare-opacity');
      var range = document.getElementById('opacity-range');
      var valueEl = document.getElementById('opacity-value');
      var overlay = stage.querySelector('.overlay-design');
      function setMode(mode) {
        stage.setAttribute('data-mode', mode);
        document.querySelectorAll('.compare-modes button').forEach(function (btn) {
          btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
        });
        opacityWrap.classList.toggle('is-hidden', mode !== 'overlay');
      }
      document.querySelectorAll('.compare-modes button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          setMode(btn.getAttribute('data-mode'));
        });
      });
      function syncOpacity() {
        var v = Number(range.value) || 0;
        overlay.style.opacity = String(v / 100);
        valueEl.textContent = v + '%';
      }
      range.addEventListener('input', syncOpacity);
      syncOpacity();
    })();
  </script>
</body>
</html>
`
}

export function generateHtmlDocument(data, options = {}) {
  const sourceLabel = options.sourceLabel || 'export'
  const imageMode = options.imageMode || 'inline'
  const chrome = options.chrome === 'minimal' ? 'minimal' : 'full'
  const imageSrcForHash = options.imageSrcForHash
  const vectorSrcForId = options.vectorSrcForId
  const svgSrcForId = options.svgSrcForId
  const compareDesignSrc = options.compareDesignSrc || null

  const root = data.nodes && data.nodes[0]
  if (!root) {
    throw new Error('JSON 没有 nodes')
  }

  const rawImages = data.images || {}
  const rawSvgs = data.svgs || {}
  let imagesForLayout = rawImages

  if (imageMode === 'external' && typeof imageSrcForHash === 'function') {
    imagesForLayout = {}
    for (const [hash, asset] of Object.entries(rawImages)) {
      const resolved = resolveImageAsset(rawImages, hash)
      if (!resolved?.dataUrl) continue
      const src = imageSrcForHash(hash, resolved)
      if (src) {
        imagesForLayout[hash] = {
          mime: resolved.mime || 'image/png',
          dataUrl: src,
          byteLength: resolved.byteLength || 0,
        }
      }
    }
  }

  function resolveNodeSvgSrc(node) {
    if (typeof svgSrcForId === 'function') {
      const fromCb = svgSrcForId(node.id)
      if (fromCb) return fromCb
    }
    if (node.svgRef && rawSvgs[node.svgRef]?.path) {
      return rawSvgs[node.svgRef].path
    }
    return null
  }

  const {
    buildStyle,
    classNameFor,
    textTagName,
    ux,
    esc,
    resolveGoogleFontImports,
    googleFontsLinkFromImports,
    renderTextHtmlContent,
  } = createFigmaLayout(imagesForLayout)

  // 列表只做识别标注；不改写各节点 layout / 视觉样式
  const listIndex = buildListIndex(root)
  const itemSlotMaps = new Map()
  for (const list of listIndex.lists) {
    for (const item of list.items) {
      itemSlotMaps.set(
        item.id,
        annotateSlots(listIndex.nodeById.get(item.id)),
      )
    }
  }

  function renderNode(
    node,
    parent = null,
    parentAutoLayout = false,
    isRoot = false,
    listContext = null,
  ) {
    if (node.visible === false) return ''

    let listItemRoot = listContext?.itemRoot || null

    if (listIndex.byItemId.has(node.id)) {
      listItemRoot = node.id
    }

    const slotMap = listItemRoot ? itemSlotMaps.get(listItemRoot) : null
    const slot = slotMap?.[node.id]

    const style = buildStyle(node, {isRoot, parent, parentAutoLayout})
    const cls = classNameFor(node)
    let attrs = [
      `class="${cls}"`,
      `data-name="${esc(node.name)}"`,
      `data-type="${esc(node.type)}"`,
      `style="${esc(style)}"`,
    ]

    if (listIndex.byContainerId.has(node.id)) {
      const listKey = node.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      const list = listIndex.byContainerId.get(node.id)
      attrs.push(`data-list="${listKey}"`)
      attrs.push(`data-list-count="${list.itemCount}"`)
    }
    if (listIndex.byItemId.has(node.id)) {
      attrs.push(
        `data-list-item="${listIndex.byItemId.get(node.id).itemIndex}"`,
      )
    }
    if (slot) attrs.push(`data-slot="${esc(slot)}"`)
    if (node.exportAsImage) attrs.push('data-export-as-image="true"')
    appendHtmlLayoutWarningAttrs(attrs, node, esc)
    attrs = finalizeHtmlAttrs(attrs, cls)

    const warnPrefix = htmlLayoutWarningComment(node, esc)

    const pngSrc =
      (typeof vectorSrcForId === 'function' && vectorSrcForId(node.id)) ||
      (imageMode === 'inline' ? resolveNodePng(node, rawImages) : null)
    if (pngSrc) {
      return `${warnPrefix}<img ${attrs.join(' ')} src="${esc(pngSrc)}" alt="" />`
    }

    const svgFileSrc = resolveNodeSvgSrc(node)
    if (svgFileSrc) {
      return `${warnPrefix}<img ${attrs.join(' ')} src="${esc(svgFileSrc)}" alt="" />`
    }

    if (node.svg) {
      const svgStyle = esc(`${style};display:block`)
      const svgClass =
        attrs.find((a) => a.startsWith('class="'))?.slice(7, -1) || cls
      let svgOpen = `class="${svgClass}" data-name="${esc(node.name)}" data-type="${esc(node.type)}" style="${svgStyle}"`
      if (node.htmlLayoutWarning) {
        svgOpen += ` data-html-layout-warning="${esc(node.htmlLayoutWarning.kind)}"`
        svgOpen += ' data-html-supported="false"'
      }
      return (
        warnPrefix + node.svg.replace(/<svg\b/, `<svg ${svgOpen}`)
      )
    }

    const childAuto = !!node.layout?.layoutMode
    let inner = ''

    const childCtx = {itemRoot: listItemRoot}

    if (node.type === 'TEXT') {
      inner = renderTextHtmlContent
        ? renderTextHtmlContent(node, esc)
        : esc(node.styles?.text?.characters || '')
    } else if (node.children?.length && !node.flattened) {
      inner = node.children
        .map((child) => renderNode(child, node, childAuto, false, childCtx))
        .join('\n')
    }

    const tag = node.type === 'TEXT' ? textTagName(node) : 'div'
    return `${warnPrefix}<${tag} ${attrs.join(' ')}>${inner}</${tag}>`
  }

  const fonts = resolveGoogleFontImports(root, data.fonts)
  let body = renderNode(root, null, false, true)
  // 外侧描边等会让切图相对根 AABB 负向溢出；扩画布以免对比框裁切
  const overflow = wrapHtmlForContentOverflow(body, root, ux)
  body = overflow.body
  const fontLabel = Array.isArray(data.fonts)
    ? `${data.fonts.length} fonts`
    : `${fonts.length} google fonts`
  const listLabel =
    listIndex.lists.length > 0
      ? ` · ${listIndex.lists.length} list(s)`
      : ''
  const htmlWarnCount =
    typeof data.htmlLayoutWarningCount === 'number'
      ? data.htmlLayoutWarningCount
      : collectHtmlLayoutWarnings(data.nodes).length
  const warnLabel =
    htmlWarnCount > 0 ? ` · ⚠ ${htmlWarnCount} HTML 布局需人工` : ''

  const canvasWidth = ux(overflow.canvasWidth)
  const rootWidth = ux(root?.layout?.width || overflow.canvasWidth)
  const padLeft = ux(overflow.pad?.padLeft || 0)
  const padTop = ux(overflow.pad?.padTop || 0)
  const fontsLink = googleFontsLinkFromImports(fonts)
  const pageLabel = `Preview from ${esc(sourceLabel)} · ${esc(data.page || '')} · ${data.totalNodeCount || 0} nodes · ${data.imageCount || 0} images · ${data.pngCount || data.svgCount || 0} vectors · ${fontLabel}${listLabel}${warnLabel}`

  const html =
    chrome === 'minimal'
      ? `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(root.name)} — Preview</title>
  ${fontsLink}
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #f3f3f3;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      /* 可滚动但不显示纵向滚动条 */
      overflow: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    [data-type="TEXT"] {
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    html::-webkit-scrollbar,
    body::-webkit-scrollbar {
      width: 0;
      height: auto;
      display: none;
    }
    .canvas {
      width: ${canvasWidth};
      margin: 0;
    }
${htmlLayoutWarningCss()}
  </style>
</head>
<body>
  <div class="canvas">
${body}
  </div>
</body>
</html>
`
      : `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(root.name)} — Figma Preview</title>
  ${fontsLink}
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background:
        radial-gradient(ellipse at 20% 0%, #1a2740 0%, transparent 50%),
        radial-gradient(ellipse at 80% 100%, #1a2030 0%, transparent 45%),
        #0b0f14;
      color: #e8eaed;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    [data-type="TEXT"] {
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .page-wrap {
      padding: 32px 16px 64px;
      overflow: auto;
    }
    .page-label {
      max-width: ${canvasWidth};
      margin: 0 auto 16px;
      font-size: 13px;
      opacity: 0.65;
      letter-spacing: 0.02em;
    }
    .canvas {
      width: ${canvasWidth};
      margin: 0 auto;
      box-shadow: 0 24px 80px rgba(0,0,0,.45);
    }
${htmlLayoutWarningCss()}
  </style>
</head>
<body>
  <div class="page-wrap">
    <div class="page-label">${pageLabel}</div>
    <div class="canvas">
${body}
    </div>
  </div>
</body>
</html>
`

  let contrastHtml = null
  if (compareDesignSrc && chrome !== 'minimal') {
    contrastHtml = buildCompareChrome({
      body,
      designSrc: compareDesignSrc,
      canvasWidth,
      rootWidth,
      padLeft,
      padTop,
      title: root.name || 'export',
      fontsLink,
      pageLabel,
      esc,
    })
  }

  return {html, contrastHtml, rootName: root.name || 'export'}
}
