"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // scripts/lib/html-layout-warnings.mjs
  var HTML_LAYOUT_WARNING_KIND = {
    BOOLEAN_SUBTRACT_PUNCH: "BOOLEAN_SUBTRACT_PUNCH"
  };
  var PUNCH_MIN_MAX_DIM = 48;
  var PUNCH_MIN_AREA = 2500;
  var HTML_LAYOUT_WARNING_COPY = {
    [HTML_LAYOUT_WARNING_KIND.BOOLEAN_SUBTRACT_PUNCH]: {
      message: "Figma \u5E03\u5C14\u51CF\u8FD0\u7B97\uFF08\u533A\u57DF\u6316\u7A7A\uFF09\uFF1AHTML/CSS \u65E0\u6CD5\u81EA\u52A8\u8FD8\u539F\u900F\u89C6\u4E0B\u5C42\u5185\u5BB9",
      suggestion: "\u8BF7\u4EBA\u5DE5\u8C03\u6574\u8282\u70B9\u5C42\u7EA7\uFF0C\u6216\u5C06\u5E26\u900F\u660E\u533A\u57DF\u7684\u80CC\u666F\u5355\u72EC\u5207\u56FE\u540E\u518D\u53E0\u653E",
      shortLabel: "\u6316\u7A7A\xB7\u9700\u4EBA\u5DE5"
    }
  };
  function nodeLayoutSize(node) {
    const layout = (node == null ? void 0 : node.layout) || {};
    const w = typeof layout.width === "number" ? layout.width : 0;
    const h = typeof layout.height === "number" ? layout.height : 0;
    return { w, h, max: Math.max(w, h), area: w * h };
  }
  function isLargeEnoughForPunch(layout, children) {
    const { max, area } = nodeLayoutSize({ layout });
    if (max >= PUNCH_MIN_MAX_DIM || area >= PUNCH_MIN_AREA) return true;
    const base = children == null ? void 0 : children[0];
    if (!(base == null ? void 0 : base.layout)) return false;
    const baseSize = nodeLayoutSize(base);
    return baseSize.max >= PUNCH_MIN_MAX_DIM || baseSize.area >= PUNCH_MIN_AREA;
  }
  function shouldMarkBooleanSubtractPunch(booleanOperation, layout, childCount, children) {
    if (booleanOperation !== "SUBTRACT") return false;
    if (childCount < 2) return false;
    return isLargeEnoughForPunch(layout, children);
  }
  function buildBooleanSubtractPunchWarning(booleanOperation = "SUBTRACT") {
    const copy = HTML_LAYOUT_WARNING_COPY[HTML_LAYOUT_WARNING_KIND.BOOLEAN_SUBTRACT_PUNCH];
    return {
      kind: HTML_LAYOUT_WARNING_KIND.BOOLEAN_SUBTRACT_PUNCH,
      booleanOperation,
      htmlSupported: false,
      message: copy.message,
      suggestion: copy.suggestion
    };
  }
  function detectHtmlLayoutWarning(node) {
    var _a;
    if (!node || node.type !== "BOOLEAN_OPERATION") return null;
    if (node.htmlLayoutWarning) return node.htmlLayoutWarning;
    const op = node.booleanOperation || (/\bsubtract\b/i.test(String(node.name || "")) ? "SUBTRACT" : null);
    const childCount = typeof node.childCount === "number" ? node.childCount : ((_a = node.children) == null ? void 0 : _a.length) || 0;
    if (!shouldMarkBooleanSubtractPunch(
      op,
      node.layout,
      childCount,
      node.children
    )) {
      return null;
    }
    return buildBooleanSubtractPunchWarning(op || "SUBTRACT");
  }
  function collectHtmlLayoutWarnings(nodes, out = []) {
    var _a;
    for (const node of nodes || []) {
      const warning = detectHtmlLayoutWarning(node);
      if (warning) {
        out.push(__spreadValues({
          id: node.id,
          name: node.name,
          type: node.type
        }, warning));
      }
      if ((_a = node.children) == null ? void 0 : _a.length) collectHtmlLayoutWarnings(node.children, out);
    }
    return out;
  }

  // scripts/lib/figma-line-height.mjs
  function roundPx(n) {
    return Math.round(n * 1e3) / 1e3;
  }
  function countExplicitLines(chars) {
    if (!chars.length) return 1;
    return chars.split("\n").length;
  }
  function inferWrappedLineCount(boxH, fontSize, minLines) {
    const typical = fontSize * 1.2;
    const snapped = [];
    for (let lh = Math.ceil(fontSize); lh <= Math.floor(fontSize * 1.5); lh++) {
      snapped.push(lh);
    }
    snapped.sort((a, b) => Math.abs(a - typical) - Math.abs(b - typical));
    for (const lh of snapped) {
      const nRaw = boxH / lh;
      const n = Math.round(nRaw);
      if (n >= minLines && Math.abs(nRaw - n) <= 1e-6) return n;
    }
    return Math.max(minLines, Math.round(boxH / typical));
  }
  function resolveAutoLineHeightPx(text, layout = {}) {
    const fontSize = text == null ? void 0 : text.fontSize;
    const boxH = layout.height;
    if (typeof fontSize !== "number" || typeof boxH !== "number" || boxH <= 0) {
      return null;
    }
    const chars = text.characters || "";
    const autoResize = text.textAutoResize;
    const explicitLines = countExplicitLines(chars);
    if (autoResize === "WIDTH_AND_HEIGHT" && explicitLines === 1 && !chars.includes("\n")) {
      return roundPx(boxH);
    }
    const lineCount = autoResize === "WIDTH_AND_HEIGHT" ? explicitLines : inferWrappedLineCount(boxH, fontSize, explicitLines);
    return roundPx(boxH / Math.max(1, lineCount));
  }

  // scripts/lib/root-relative-layout.mjs
  var FLAT_COORD_TYPES = /* @__PURE__ */ new Set(["GROUP", "BOOLEAN_OPERATION"]);
  function parentOffsetFromLegacyXY(node, parent) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const x = (_b = (_a = node.layout) == null ? void 0 : _a.x) != null ? _b : 0;
    const y = (_d = (_c = node.layout) == null ? void 0 : _c.y) != null ? _d : 0;
    if (parent && FLAT_COORD_TYPES.has(parent.type)) {
      const alreadyParentRelative = !!(((_e = node.layout) == null ? void 0 : _e.bakedVisual) || node.flattened || node.png || node.pngRef);
      if (alreadyParentRelative) return { left: x, top: y };
      return {
        left: x - ((_g = (_f = parent.layout) == null ? void 0 : _f.x) != null ? _g : 0),
        top: y - ((_i = (_h = parent.layout) == null ? void 0 : _h.y) != null ? _i : 0)
      };
    }
    return { left: x, top: y };
  }
  function visit(node, parent, originX, originY) {
    if (!node) return;
    if (!node.layout) {
      node.layout = { x: 0, y: 0, width: 0, height: 0 };
    }
    const { left, top } = parent ? parentOffsetFromLegacyXY(node, parent) : { left: 0, top: 0 };
    const x = originX + left;
    const y = originY + top;
    node.layout.parentX = left;
    node.layout.parentY = top;
    node.layout.rootX = x;
    node.layout.rootY = y;
    for (const child of node.children || []) {
      visit(child, node, x, y);
    }
  }
  function attachRootRelativeCoords(root) {
    if (!root) return root;
    visit(root, null, 0, 0);
    return root;
  }

  // src/bridge/layer-order.mjs
  var planMove = (currentIds, nodeId, index) => {
    const rest = currentIds.filter((id) => id !== nodeId);
    const target = Math.max(0, Math.min(index, rest.length));
    const desired = [...rest];
    desired.splice(target, 0, nodeId);
    return { desired, target };
  };
  var planReorder = (currentIds, desiredIds) => {
    const ops = [];
    const working = [...currentIds];
    for (let i = 0; i < desiredIds.length; i += 1) {
      if (working[i] === desiredIds[i]) continue;
      const from = working.indexOf(desiredIds[i]);
      if (from >= 0) working.splice(from, 1);
      working.splice(i, 0, desiredIds[i]);
      ops.push({ index: i, id: desiredIds[i] });
    }
    return ops;
  };

  // src/bridge/ops.ts
  var fail = (message) => {
    throw new Error(message);
  };
  var num = (args, key) => {
    const raw = args[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : void 0;
  };
  var str = (args, key) => {
    const raw = args[key];
    return typeof raw === "string" && raw ? raw : void 0;
  };
  var getNode = async (id) => {
    if (!id) return fail("\u7F3A\u5C11 nodeId");
    const node = await figma.getNodeByIdAsync(id);
    if (!node) return fail(`\u8282\u70B9\u4E0D\u5B58\u5728: ${id}`);
    return node;
  };
  var hasChildren = (node) => "children" in node && Array.isArray(node.children);
  var ensurePageLoaded = async (page) => {
    if (page.type !== "PAGE" || page === figma.currentPage) return;
    const pageNode = page;
    if (typeof pageNode.loadAsync === "function") await pageNode.loadAsync();
    else await figma.loadAllPagesAsync();
  };
  var clampIndex = (parent, index) => Math.max(0, Math.min(index, parent.children.length));
  var appendTo = (parent, node) => {
    if (!parent || !("children" in parent)) return;
    const container = parent;
    container.insertChild(clampIndex(container, container.children.length), node);
  };
  var moveTo = (parent, nodeId, index) => {
    const currentIds = parent.children.map((c) => c.id);
    const { desired } = planMove(currentIds, nodeId, index);
    for (const step of planReorder(currentIds, desired)) {
      const moving = parent.children.find((c) => c.id === step.id);
      if (moving) parent.insertChild(step.index, moving);
    }
    return parent.children.findIndex((c) => c.id === nodeId);
  };
  var toRgb = (hex) => {
    const raw = hex.replace("#", "").trim();
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return fail(`\u65E0\u6CD5\u89E3\u6790\u989C\u8272: ${hex}`);
    return {
      r: parseInt(full.slice(0, 2), 16) / 255,
      g: parseInt(full.slice(2, 4), 16) / 255,
      b: parseInt(full.slice(4, 6), 16) / 255
    };
  };
  var toPaints = (value) => {
    if (value === void 0 || value === null) return void 0;
    const list = Array.isArray(value) ? value : [value];
    return list.map((item) => {
      if (typeof item === "string") return { type: "SOLID", color: toRgb(item) };
      return item;
    });
  };
  var summarize = (node) => {
    const box = node.absoluteBoundingBox;
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      childCount: hasChildren(node) ? node.children.length : 0
    };
  };
  var tree = (node, depth) => {
    const item = {
      id: node.id,
      name: node.name,
      type: node.type,
      box: summarize(node).box
    };
    if (depth > 0 && hasChildren(node)) {
      item.children = node.children.map((c) => tree(c, depth - 1));
    }
    return item;
  };
  var detail = (node) => {
    const base = __spreadProps(__spreadValues({}, summarize(node)), {
      parentId: node.parent ? node.parent.id : null
    });
    if ("visible" in node) base.visible = node.visible;
    if ("locked" in node) base.locked = node.locked;
    if ("opacity" in node) base.opacity = node.opacity;
    if ("blendMode" in node) base.blendMode = node.blendMode;
    if ("fills" in node) base.fills = node.fills;
    if ("strokes" in node) base.strokes = node.strokes;
    if ("cornerRadius" in node) {
      const radius = node.cornerRadius;
      base.cornerRadius = radius;
    }
    if ("layoutMode" in node) {
      const frame = node;
      base.autoLayout = {
        layoutMode: frame.layoutMode,
        itemSpacing: frame.itemSpacing,
        padding: {
          top: frame.paddingTop,
          right: frame.paddingRight,
          bottom: frame.paddingBottom,
          left: frame.paddingLeft
        },
        primaryAxisAlignItems: frame.primaryAxisAlignItems,
        counterAxisAlignItems: frame.counterAxisAlignItems
      };
    }
    if (node.type === "TEXT") {
      const text = node;
      base.text = {
        characters: text.characters,
        fontSize: text.fontSize,
        fontName: text.fontName
      };
    }
    return base;
  };
  var createOps = () => {
    const ops = {
      async getFileInfo() {
        return {
          fileName: figma.root.name,
          fileKey: figma.fileKey || null,
          currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
          pages: figma.root.children.map((p) => ({ id: p.id, name: p.name }))
        };
      },
      async getSelection() {
        const nodes = figma.currentPage.selection;
        return { count: nodes.length, nodes: nodes.map(summarize) };
      },
      async getPageTree(args) {
        var _a;
        const pageId = str(args, "pageId");
        const page = pageId ? await getNode(pageId) : figma.currentPage;
        await ensurePageLoaded(page);
        if (!hasChildren(page)) {
          return fail(`${page.type} \u6CA1\u6709\u5B50\u8282\u70B9`);
        }
        const depth = (_a = num(args, "depth")) != null ? _a : 1;
        return {
          page: { id: page.id, name: page.name },
          children: page.children.map(
            (c) => tree(c, Math.max(0, depth))
          )
        };
      },
      async getNode(args) {
        var _a;
        const node = await getNode(str(args, "nodeId"));
        const depth = (_a = num(args, "depth")) != null ? _a : 2;
        return __spreadProps(__spreadValues({}, detail(node)), {
          children: hasChildren(node) ? node.children.map((c) => tree(c, Math.max(0, depth - 1))) : []
        });
      },
      async groupNodes(args) {
        const ids = args.nodeIds || [];
        if (ids.length === 0) return fail("nodeIds \u4E0D\u80FD\u4E3A\u7A7A");
        const nodes = await Promise.all(ids.map((id) => getNode(id)));
        const parent = nodes[0].parent;
        if (!parent) return fail("\u8282\u70B9\u6CA1\u6709\u7236\u7EA7\uFF0C\u65E0\u6CD5\u5206\u7EC4");
        const wrong = nodes.find((n) => n.parent !== parent);
        if (wrong) {
          return fail(`\u8282\u70B9 ${wrong.id} \u4E0E ${nodes[0].id} \u4E0D\u5728\u540C\u4E00\u7236\u7EA7`);
        }
        const parentIds = parent.children.map((c) => c.id);
        const originalIndex = Math.min(
          ...ids.map((id) => {
            const at = parentIds.indexOf(id);
            return at < 0 ? parentIds.length : at;
          })
        );
        const group = figma.group(
          nodes,
          parent,
          Math.max(0, originalIndex)
        );
        const name = str(args, "name");
        if (name) group.name = name;
        const wanted = num(args, "index");
        const placed = wanted === void 0 ? originalIndex : moveTo(parent, group.id, wanted);
        return { id: group.id, name: group.name, index: placed };
      },
      async ungroup(args) {
        const node = await getNode(str(args, "nodeId"));
        const ungroupable = node;
        if (typeof ungroupable.ungroup !== "function") {
          return fail(`${node.type} \u4E0D\u652F\u6301\u89E3\u7EC4`);
        }
        const released = ungroupable.ungroup();
        return { releasedIds: released.map((n) => n.id) };
      },
      async reorderNodes(args) {
        var _a;
        const position = str(args, "position");
        const nodeId = str(args, "nodeId");
        if (position) {
          const node = await getNode(
            nodeId || (args.nodeIds || [])[0]
          );
          const parent2 = node.parent;
          if (!parent2) return fail("\u6839\u8282\u70B9\u65E0\u6CD5\u8C03\u6574\u5C42\u7EA7");
          const ids2 = parent2.children.map((c) => c.id);
          const current = ids2.indexOf(node.id);
          const last = ids2.length - 1;
          const targets = {
            front: last,
            back: 0,
            forward: Math.min(current + 1, last),
            backward: Math.max(current - 1, 0)
          };
          const target = targets[position];
          if (target === void 0) return fail(`\u672A\u77E5 position: ${position}`);
          const placed = moveTo(parent2, node.id, target);
          return { id: node.id, from: current, index: placed, total: ids2.length };
        }
        const ids = args.nodeIds || [];
        if (ids.length === 0) {
          return fail("\u9700\u8981 nodeIds+index\uFF0C\u6216 nodeId+position");
        }
        const nodes = await Promise.all(ids.map((id) => getNode(id)));
        const parentId = str(args, "parentId");
        const parent = parentId ? await getNode(parentId) : nodes[0].parent;
        if (!parent || !("children" in parent)) {
          return fail("\u65E0\u6CD5\u786E\u5B9A\u76EE\u6807\u7236\u7EA7");
        }
        const container = parent;
        const base = (_a = num(args, "index")) != null ? _a : container.children.length;
        const currentIds = container.children.map((c) => c.id);
        const desired = currentIds.filter((id) => !ids.includes(id));
        desired.splice(Math.min(base, desired.length), 0, ...ids);
        for (const step of planReorder(currentIds, desired)) {
          const moving = container.children.find((c) => c.id === step.id);
          if (moving) container.insertChild(step.index, moving);
        }
        return {
          parentId: parent.id,
          insertedFrom: base,
          order: container.children.slice(base, base + ids.length).map((n) => n.id)
        };
      },
      async renameNode(args) {
        const node = await getNode(str(args, "nodeId"));
        const name = str(args, "name");
        if (!name) return fail("\u7F3A\u5C11 name");
        node.name = name;
        return { id: node.id, name: node.name };
      },
      async moveNode(args) {
        const node = await getNode(str(args, "nodeId"));
        const parentId = str(args, "parentId");
        if (parentId) {
          const parent = await getNode(parentId);
          if (!("children" in parent)) return fail("\u76EE\u6807\u4E0D\u662F\u5BB9\u5668\u8282\u70B9");
          const container = parent;
          const index = clampIndex(container, container.children.length);
          container.insertChild(index, node);
        }
        const x = num(args, "x");
        const y = num(args, "y");
        if (x !== void 0 && "x" in node) node.x = x;
        if (y !== void 0 && "y" in node) node.y = y;
        return detail(node);
      },
      async createFrame(args) {
        var _a, _b;
        const frame = figma.createFrame();
        const name = str(args, "name");
        if (name) frame.name = name;
        frame.resize((_a = num(args, "width")) != null ? _a : 100, (_b = num(args, "height")) != null ? _b : 100);
        const parentId = str(args, "parentId");
        const parent = parentId ? await getNode(parentId) : figma.currentPage;
        appendTo(parent, frame);
        const x = num(args, "x");
        const y = num(args, "y");
        if (x !== void 0) frame.x = x;
        if (y !== void 0) frame.y = y;
        const fill = args.fill;
        if (fill !== void 0) {
          const paints = toPaints(fill);
          if (paints) frame.fills = paints;
        }
        const layoutMode = str(args, "layoutMode");
        if (layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL") {
          frame.layoutMode = layoutMode;
        }
        return summarize(frame);
      },
      async createRectangle(args) {
        var _a, _b;
        const rect = figma.createRectangle();
        const name = str(args, "name");
        if (name) rect.name = name;
        rect.resize((_a = num(args, "width")) != null ? _a : 100, (_b = num(args, "height")) != null ? _b : 100);
        const parentId = str(args, "parentId");
        const parent = parentId ? await getNode(parentId) : figma.currentPage;
        appendTo(parent, rect);
        const x = num(args, "x");
        const y = num(args, "y");
        if (x !== void 0) rect.x = x;
        if (y !== void 0) rect.y = y;
        const fill = args.fill;
        if (fill !== void 0) {
          const paints = toPaints(fill);
          if (paints) rect.fills = paints;
        }
        const cornerRadius = num(args, "cornerRadius");
        if (cornerRadius !== void 0) rect.cornerRadius = cornerRadius;
        return summarize(rect);
      },
      async createText(args) {
        var _a, _b, _c;
        const text = str(args, "text");
        if (!text) return fail("\u7F3A\u5C11 text");
        const family = (_a = str(args, "fontFamily")) != null ? _a : "Inter";
        const style = (_b = str(args, "fontStyle")) != null ? _b : "Regular";
        const fontName = { family, style };
        await figma.loadFontAsync(fontName);
        const node = figma.createText();
        node.fontName = fontName;
        node.fontSize = (_c = num(args, "fontSize")) != null ? _c : 14;
        node.characters = text;
        const parentId = str(args, "parentId");
        const parent = parentId ? await getNode(parentId) : figma.currentPage;
        appendTo(parent, node);
        const x = num(args, "x");
        const y = num(args, "y");
        if (x !== void 0) node.x = x;
        if (y !== void 0) node.y = y;
        const fill = args.fill;
        if (fill !== void 0) {
          const paints = toPaints(fill);
          if (paints) node.fills = paints;
        }
        return summarize(node);
      },
      async cloneNode(args) {
        const node = await getNode(str(args, "nodeId"));
        const clone = node.clone();
        const parentId = str(args, "parentId");
        if (parentId) {
          const parent = await getNode(parentId);
          if (!("children" in parent)) return fail("\u76EE\u6807\u4E0D\u662F\u5BB9\u5668\u8282\u70B9");
          appendTo(parent, clone);
        }
        const x = num(args, "x");
        const y = num(args, "y");
        if (x !== void 0) clone.x = x;
        if (y !== void 0) clone.y = y;
        return summarize(clone);
      },
      async setStyle(args) {
        const node = await getNode(str(args, "nodeId"));
        if (args.fills !== void 0) {
          if (!("fills" in node)) return fail(`${node.type} \u4E0D\u652F\u6301 fills`);
          const paints = toPaints(args.fills);
          if (paints) node.fills = paints;
        }
        if (args.strokes !== void 0) {
          if (!("strokes" in node)) return fail(`${node.type} \u4E0D\u652F\u6301 strokes`);
          const paints = toPaints(args.strokes);
          if (paints) node.strokes = paints;
        }
        const strokeWeight = num(args, "strokeWeight");
        if (strokeWeight !== void 0 && "strokeWeight" in node) {
          ;
          node.strokeWeight = strokeWeight;
        }
        const cornerRadius = num(args, "cornerRadius");
        if (cornerRadius !== void 0 && "cornerRadius" in node) {
          ;
          node.cornerRadius = cornerRadius;
        }
        const opacity = num(args, "opacity");
        if (opacity !== void 0 && "opacity" in node) {
          node.opacity = Math.min(1, Math.max(0, opacity));
        }
        const blendMode = str(args, "blendMode");
        if (blendMode && "blendMode" in node) {
          ;
          node.blendMode = blendMode;
        }
        if (Array.isArray(args.effects) && "effects" in node) {
          ;
          node.effects = args.effects;
        }
        return detail(node);
      },
      async setLayout(args) {
        const node = await getNode(str(args, "nodeId"));
        const width = num(args, "width");
        const height = num(args, "height");
        if (width !== void 0 && height !== void 0 && "resize" in node) {
          node.resize(width, height);
        }
        const layoutMode = str(args, "layoutMode");
        if (layoutMode && "layoutMode" in node) {
          const frame = node;
          if (layoutMode === "NONE" || layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL") {
            frame.layoutMode = layoutMode;
          }
        }
        const padding = num(args, "padding");
        if (padding !== void 0 && "paddingTop" in node) {
          const frame = node;
          frame.paddingTop = padding;
          frame.paddingRight = padding;
          frame.paddingBottom = padding;
          frame.paddingLeft = padding;
        }
        const itemSpacing = num(args, "itemSpacing");
        if (itemSpacing !== void 0 && "itemSpacing" in node) {
          ;
          node.itemSpacing = itemSpacing;
        }
        const primary = str(args, "primaryAxisAlignItems");
        if (primary && "primaryAxisAlignItems" in node) {
          ;
          node.primaryAxisAlignItems = primary;
        }
        const counter = str(args, "counterAxisAlignItems");
        if (counter && "counterAxisAlignItems" in node) {
          ;
          node.counterAxisAlignItems = counter;
        }
        const x = num(args, "x");
        const y = num(args, "y");
        if (x !== void 0 && "x" in node) node.x = x;
        if (y !== void 0 && "y" in node) node.y = y;
        const rotation = num(args, "rotation");
        if (rotation !== void 0 && "rotation" in node) {
          ;
          node.rotation = rotation;
        }
        return detail(node);
      },
      async setVisible(args) {
        const node = await getNode(str(args, "nodeId"));
        node.visible = Boolean(args.visible);
        return { id: node.id, visible: node.visible };
      },
      async setLocked(args) {
        const node = await getNode(str(args, "nodeId"));
        node.locked = Boolean(args.locked);
        return { id: node.id, locked: node.locked };
      },
      async setText(args) {
        const node = await getNode(str(args, "nodeId"));
        if (node.type !== "TEXT") return fail(`${node.type} \u4E0D\u662F\u6587\u672C\u8282\u70B9`);
        const text = str(args, "text");
        if (text === void 0) return fail("\u7F3A\u5C11 text");
        const textNode = node;
        await figma.loadFontAsync(textNode.fontName);
        textNode.characters = text;
        return { id: node.id, characters: textNode.characters };
      },
      async deleteNode(args) {
        const node = await getNode(str(args, "nodeId"));
        const removed = summarize(node);
        node.remove();
        return { removed };
      }
    };
    return ops;
  };

  // src/bridge/queue.mjs
  var createSerialQueue = () => {
    let tail = Promise.resolve();
    let depth = 0;
    const run = (task) => {
      depth += 1;
      const start = tail.then(task, task);
      tail = start.then(
        () => {
          depth -= 1;
        },
        () => {
          depth -= 1;
        }
      );
      return start;
    };
    return { run, get depth() {
      return depth;
    } };
  };

  // src/bridge/index.ts
  var READ_ONLY_OPS = /* @__PURE__ */ new Set([
    "getFileInfo",
    "getSelection",
    "getPageTree",
    "getNode"
  ]);
  var createBridge = (hooks = {}) => {
    const ops = createOps();
    const queue = createSerialQueue();
    const run = async (job) => {
      var _a, _b, _c;
      const handler = ops[job.op];
      if (!handler) {
        return { id: job.id, ok: false, error: `\u672A\u77E5 op: ${job.op}` };
      }
      const mutating = !READ_ONLY_OPS.has(job.op);
      if (mutating) (_a = hooks.onBusyChange) == null ? void 0 : _a.call(hooks, true);
      try {
        const result = await handler(job.args || {});
        if (mutating) (_b = hooks.onDocumentChanged) == null ? void 0 : _b.call(hooks);
        return { id: job.id, ok: true, result: result != null ? result : null };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { id: job.id, ok: false, error };
      } finally {
        if (mutating) (_c = hooks.onBusyChange) == null ? void 0 : _c.call(hooks, false);
      }
    };
    const enqueue = (job, onResult) => {
      void queue.run(() => run(job)).then(onResult);
    };
    return { enqueue, depth: () => queue.depth, opNames: Object.keys(ops) };
  };

  // code.ts
  var MIN_FONT_WEIGHT = 400;
  function normalizeFontWeight(weight) {
    if (typeof weight !== "number" || Number.isNaN(weight) || weight <= 0) {
      return void 0;
    }
    return Math.max(MIN_FONT_WEIGHT, Math.round(weight));
  }
  var MAX_EXPORT_CONCURRENCY = 2;
  var exportSlots = MAX_EXPORT_CONCURRENCY;
  var exportWaitQueue = [];
  async function withExportSlot(run) {
    if (exportSlots <= 0) {
      await new Promise((resolve) => {
        exportWaitQueue.push(resolve);
      });
    }
    exportSlots -= 1;
    try {
      return await run();
    } finally {
      exportSlots += 1;
      const next = exportWaitQueue.shift();
      if (next) next();
    }
  }
  var RESULT_PAYLOAD_CHUNK_CHARS = 512 * 1024;
  var SVG_NODE_TYPES = /* @__PURE__ */ new Set([
    "VECTOR",
    "BOOLEAN_OPERATION",
    "STAR",
    "LINE",
    "ELLIPSE",
    "RECTANGLE",
    /** Plugin API 正式名 */
    "POLYGON",
    /** REST / 旧数据兼容 */
    "REGULAR_POLYGON",
    "WASHI_TAPE"
  ]);
  var VECTOR_BAKE_MIN_LEAVES = 8;
  var VECTOR_BAKE_RATIO = 0.85;
  var MAX_BAKE_SMALL_CONTAINER_PX = 72;
  var BAKE_SIZE_NORMALIZE_STEP = 4;
  var PLUGIN_DATA_EXPORT_AS_IMAGE = "exportAsImage";
  var PLUGIN_DATA_SKIP_IMAGE_BAKE = "skipImageBake";
  function isMarkedExportAsImage(node) {
    return node.getPluginData(PLUGIN_DATA_EXPORT_AS_IMAGE) === "1";
  }
  function isMarkedSkipImageBake(node) {
    return node.getPluginData(PLUGIN_DATA_SKIP_IMAGE_BAKE) === "1";
  }
  function attachHtmlLayoutWarningMeta(node, info) {
    if (node.type !== "BOOLEAN_OPERATION") return;
    const op = node.booleanOperation;
    info.booleanOperation = op;
    const childCount = "children" in node ? node.children.length : info.childCount;
    if (!shouldMarkBooleanSubtractPunch(
      op,
      info.layout,
      childCount,
      info.children
    )) {
      return;
    }
    info.htmlLayoutWarning = buildBooleanSubtractPunchWarning(op);
  }
  function isVectorContainerType(type) {
    return type === "GROUP" || type === "TRANSFORM_GROUP";
  }
  function isCssFriendlyPaint(paint) {
    if (paint.visible === false) return true;
    return paint.type === "SOLID" || paint.type === "GRADIENT_LINEAR";
  }
  function nodePaintsAreCssFriendly(node) {
    if ("fills" in node) {
      if (node.fills === figma.mixed) return false;
      for (const paint of node.fills) {
        if (!isCssFriendlyPaint(paint)) return false;
      }
    }
    if ("strokes" in node) {
      for (const paint of node.strokes) {
        if (!isCssFriendlyPaint(paint)) return false;
      }
    }
    return true;
  }
  function isCssFriendlyBoxShape(node) {
    return (node.type === "RECTANGLE" || node.type === "ELLIPSE") && nodePaintsAreCssFriendly(node);
  }
  function shouldExportSvg(node) {
    if (isCssFriendlyBoxShape(node)) return false;
    if (SVG_NODE_TYPES.has(node.type)) return true;
    if (!isVectorContainerType(node.type) || !("children" in node)) return false;
    if (node.children.length === 0) return false;
    return node.children.every((child) => shouldExportSvg(child));
  }
  function subtreeHasText(node) {
    if (node.type === "TEXT") return true;
    if (!("children" in node)) return false;
    for (const child of node.children) {
      if (!child.visible) continue;
      if (subtreeHasText(child)) return true;
    }
    return false;
  }
  function collectVectorLeafStats(node, stats) {
    if (!node.visible) return;
    if (node.type === "TEXT") {
      stats.hasText = true;
      stats.leafCount += 1;
      return;
    }
    if (isCssFriendlyBoxShape(node)) {
      stats.leafCount += 1;
      return;
    }
    if (SVG_NODE_TYPES.has(node.type)) {
      stats.leafCount += 1;
      stats.vectorishCount += 1;
      if (nodeHasVisibleImageFill(node)) stats.hasImageFill = true;
      return;
    }
    if (nodeHasVisibleImageFill(node)) stats.hasImageFill = true;
    if ("children" in node && node.children.length > 0) {
      for (const child of node.children) {
        collectVectorLeafStats(child, stats);
      }
      return;
    }
    stats.leafCount += 1;
  }
  function shouldBakeDenseVectorGroup(node) {
    if (node.type !== "GROUP" && node.type !== "FRAME") return false;
    if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
      return false;
    }
    if (subtreeHasText(node)) return false;
    const stats = {
      leafCount: 0,
      vectorishCount: 0,
      hasText: false,
      hasImageFill: false
    };
    collectVectorLeafStats(node, stats);
    if (stats.hasText || stats.hasImageFill) return false;
    if (stats.leafCount < VECTOR_BAKE_MIN_LEAVES) return false;
    return stats.vectorishCount / stats.leafCount >= VECTOR_BAKE_RATIO;
  }
  function roundLayoutNum(n) {
    return Math.round(n * 1e3) / 1e3;
  }
  function extractLayoutSkew(node) {
    if (!("relativeTransform" in node)) return null;
    const t = node.relativeTransform;
    const m00 = t[0][0];
    const m01 = t[0][1];
    const m10 = t[1][0];
    const m11 = t[1][1];
    if (Math.abs(m00 * m01 + m10 * m11) < 1e-6) return null;
    const rotationRad = Math.atan2(-m10, m00);
    const c = Math.cos(rotationRad);
    const s = Math.sin(rotationRad);
    const r00 = c * m00 - s * m10;
    const r01 = c * m01 - s * m11;
    const r10 = s * m00 + c * m10;
    const r11 = s * m01 + c * m11;
    const skewX = Math.atan2(r01, r11) * 180 / Math.PI;
    const skewY = Math.atan2(r10, r00) * 180 / Math.PI;
    if (Math.abs(skewX) < 0.01 && Math.abs(skewY) < 0.01) return null;
    return {
      skewX: roundLayoutNum(skewX),
      skewY: roundLayoutNum(skewY),
      transform: [
        [roundLayoutNum(m00), roundLayoutNum(m01)],
        [roundLayoutNum(m10), roundLayoutNum(m11)]
      ]
    };
  }
  function hasMeaningfulSkew(node) {
    return extractLayoutSkew(node) != null;
  }
  function hasMeaningfulRotation(node) {
    return "rotation" in node && Math.abs(node.rotation) > 0.01 || hasMeaningfulSkew(node);
  }
  function clearLayoutAffine(layout) {
    layout.rotation = void 0;
    layout.skewX = void 0;
    layout.skewY = void 0;
    layout.transform = void 0;
  }
  function nodeHasVisibleImageFill(node) {
    if (!("fills" in node) || node.fills === figma.mixed) return false;
    return node.fills.some(
      (paint) => paint.visible !== false && paint.type === "IMAGE"
    );
  }
  function shouldBakeRotatedNode(node) {
    if (!hasMeaningfulRotation(node)) return false;
    if (subtreeHasText(node)) return false;
    if (isCssFriendlyBoxShape(node)) return false;
    if (nodeHasVisibleImageFill(node)) return true;
    if (!("children" in node) || node.children.length === 0) return true;
    if (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "FRAME" || node.type === "GROUP" || node.type === "TRANSFORM_GROUP") {
      return true;
    }
    return false;
  }
  function hasVisibleChild(node) {
    if (!("children" in node)) return false;
    return node.children.some((child) => child.visible);
  }
  function getVisibleChildren(node) {
    if (!("children" in node)) return [];
    return node.children.filter((child) => child.visible);
  }
  function shouldBakeSmallContainer(node) {
    if (node.type !== "INSTANCE" && node.type !== "FRAME") return false;
    if (!("width" in node) || !("height" in node)) return false;
    if (node.width > MAX_BAKE_SMALL_CONTAINER_PX || node.height > MAX_BAKE_SMALL_CONTAINER_PX) {
      return false;
    }
    if (subtreeHasText(node)) return false;
    if (!hasVisibleChild(node)) return false;
    return true;
  }
  function isShapeUnitChild(node) {
    if (isCssFriendlyBoxShape(node)) return false;
    if (SVG_NODE_TYPES.has(node.type)) return true;
    if (isVectorContainerType(node.type) && shouldExportSvg(node)) return true;
    return false;
  }
  function shouldBakeMaskGroup(node) {
    if (!("children" in node)) return false;
    return node.children.some(
      (child) => child.visible && "isMask" in child && child.isMask === true
    );
  }
  function childWouldBakeAsVisual(node, depth) {
    if (isShapeUnitChild(node)) return true;
    if (shouldBakeMaskGroup(node)) return true;
    if (shouldBakeRotatedNode(node)) return true;
    if (shouldBakeSmallContainer(node)) return true;
    if (shouldBakeDenseVectorGroup(node)) return true;
    if (depth > 0 && isAllShapeOrVisualFrame(node, depth - 1)) return true;
    if (nodeHasVisibleImageFill(node) && getVisibleChildren(node).length === 0) {
      return true;
    }
    return false;
  }
  function isAllShapeOrVisualFrame(node, depth) {
    if (node.type !== "FRAME") return false;
    if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
      return false;
    }
    if (subtreeHasText(node)) return false;
    const children = getVisibleChildren(node);
    if (children.length === 0) return false;
    return children.every((child) => childWouldBakeAsVisual(child, depth));
  }
  function shouldBakeAllShapeFrame(node) {
    return isAllShapeOrVisualFrame(node, 2);
  }
  function rgbaToHex(color, opacity = 1) {
    const a = "a" in color ? color.a : opacity;
    const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
    const rgb = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
    if (a >= 1) return rgb.toUpperCase();
    return `${rgb}${toHex(a)}`.toUpperCase();
  }
  function gradientTransformToCssAngle(transform) {
    const a = transform[0][0];
    const b = transform[1][0];
    const radians = Math.atan2(b, a);
    const deg = radians * 180 / Math.PI + 90;
    return Math.round((deg % 360 + 360) % 360);
  }
  function serializePaint(paint) {
    var _a, _b, _c, _d, _e;
    if (paint.type === "SOLID") {
      return {
        type: "SOLID",
        color: rgbaToHex(paint.color, (_a = paint.opacity) != null ? _a : 1),
        opacity: (_b = paint.opacity) != null ? _b : 1,
        visible: paint.visible !== false,
        blendMode: paint.blendMode
      };
    }
    if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
      const gradientTransform = paint.gradientTransform;
      return {
        type: paint.type,
        opacity: (_c = paint.opacity) != null ? _c : 1,
        visible: paint.visible !== false,
        blendMode: paint.blendMode,
        stops: paint.gradientStops.map((stop) => ({
          position: stop.position,
          color: rgbaToHex(stop.color)
        })),
        gradientTransform,
        cssAngle: paint.type === "GRADIENT_LINEAR" ? gradientTransformToCssAngle(gradientTransform) : void 0
      };
    }
    if (paint.type === "IMAGE") {
      return {
        type: "IMAGE",
        opacity: (_d = paint.opacity) != null ? _d : 1,
        visible: paint.visible !== false,
        blendMode: paint.blendMode,
        scaleMode: paint.scaleMode,
        imageHash: paint.imageHash,
        imageTransform: paint.imageTransform,
        rotation: paint.rotation,
        scalingFactor: paint.scalingFactor
      };
    }
    return {
      type: paint.type,
      opacity: (_e = paint.opacity) != null ? _e : 1,
      visible: paint.visible !== false,
      blendMode: "blendMode" in paint ? paint.blendMode : void 0
    };
  }
  function serializeEffect(effect) {
    const base = {
      type: effect.type,
      visible: effect.visible !== false
    };
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      return __spreadProps(__spreadValues({}, base), {
        radius: effect.radius,
        color: rgbaToHex(effect.color),
        offset: { x: effect.offset.x, y: effect.offset.y },
        spread: effect.spread,
        blendMode: effect.blendMode
      });
    }
    if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
      return __spreadProps(__spreadValues({}, base), { radius: effect.radius });
    }
    return base;
  }
  function getLayoutInfo(node) {
    const layout = {
      x: "x" in node ? node.x : 0,
      y: "y" in node ? node.y : 0,
      width: "width" in node ? node.width : 0,
      height: "height" in node ? node.height : 0
    };
    if ("rotation" in node) layout.rotation = node.rotation;
    const skew = extractLayoutSkew(node);
    if (skew) {
      layout.skewX = skew.skewX;
      layout.skewY = skew.skewY;
      layout.transform = skew.transform;
    }
    if ("constraints" in node) layout.constraints = node.constraints;
    if ("layoutMode" in node && node.layoutMode !== "NONE") {
      layout.layoutMode = node.layoutMode;
      layout.primaryAxisSizingMode = node.primaryAxisSizingMode;
      layout.counterAxisSizingMode = node.counterAxisSizingMode;
      layout.primaryAxisAlignItems = node.primaryAxisAlignItems;
      layout.counterAxisAlignItems = node.counterAxisAlignItems;
      layout.itemSpacing = node.itemSpacing;
      if ("layoutWrap" in node) layout.layoutWrap = node.layoutWrap;
      if ("counterAxisSpacing" in node) {
        layout.counterAxisSpacing = node.counterAxisSpacing;
      }
      if ("counterAxisAlignContent" in node) {
        layout.counterAxisAlignContent = node.counterAxisAlignContent;
      }
      layout.padding = {
        top: node.paddingTop,
        right: node.paddingRight,
        bottom: node.paddingBottom,
        left: node.paddingLeft
      };
      if ("strokesIncludedInLayout" in node) {
        layout.strokesIncludedInLayout = node.strokesIncludedInLayout;
      }
    }
    if ("layoutGrow" in node) layout.layoutGrow = node.layoutGrow;
    if ("layoutAlign" in node) layout.layoutAlign = node.layoutAlign;
    if ("layoutPositioning" in node) {
      layout.layoutPositioning = node.layoutPositioning;
    }
    return layout;
  }
  function readPngPixelSize(bytes) {
    if (bytes.length < 24) return null;
    if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
      return null;
    }
    const width = (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0;
    const height = (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  function readSvgDesignSize(svg) {
    const vb = svg.match(
      /viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i
    );
    if (vb) {
      const width = parseFloat(vb[3]);
      const height = parseFloat(vb[4]);
      if (width > 0 && height > 0) return { width, height };
    }
    const w = svg.match(/\bwidth\s*=\s*["']([\d.]+)/i);
    const h = svg.match(/\bheight\s*=\s*["']([\d.]+)/i);
    if (w && h) {
      const width = parseFloat(w[1]);
      const height = parseFloat(h[1]);
      if (width > 0 && height > 0) return { width, height };
    }
    return null;
  }
  function approxEq(a, b, eps = 0.51) {
    return Math.abs(a - b) <= eps;
  }
  function applyBakedVisualLayout(node, layout, exportDesignSize, visualBounds) {
    const bounds = "absoluteBoundingBox" in node && node.absoluteBoundingBox || ("absoluteRenderBounds" in node ? node.absoluteRenderBounds : null);
    if (!bounds) {
      clearLayoutAffine(layout);
      layout.bakedVisual = true;
      return;
    }
    let originX = 0;
    let originY = 0;
    const parent = node.parent;
    if (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
      const parentBox = "absoluteBoundingBox" in parent && parent.absoluteBoundingBox || ("absoluteRenderBounds" in parent ? parent.absoluteRenderBounds : null);
      if (parentBox) {
        originX = parentBox.x;
        originY = parentBox.y;
      } else if ("x" in parent && "y" in parent) {
        originX = parent.x;
        originY = parent.y;
      }
    }
    let x = bounds.x - originX;
    let y = bounds.y - originY;
    let width = bounds.width;
    let height = bounds.height;
    const ew = exportDesignSize == null ? void 0 : exportDesignSize.width;
    const eh = exportDesignSize == null ? void 0 : exportDesignSize.height;
    if (visualBounds) {
      x += visualBounds.x;
      y += visualBounds.y;
      width = typeof ew === "number" && ew > 0 ? ew : visualBounds.width;
      height = typeof eh === "number" && eh > 0 ? eh : visualBounds.height;
      layout.x = x;
      layout.y = y;
      layout.width = width;
      layout.height = height;
      clearLayoutAffine(layout);
      layout.bakedVisual = true;
      return;
    }
    if (typeof ew === "number" && typeof eh === "number" && ew > 0 && eh > 0 && (!approxEq(width, ew) || !approxEq(height, eh))) {
      if (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT" && "clipsContent" in parent && parent.clipsContent && "width" in parent && "height" in parent) {
        const ix = Math.max(x, 0);
        const iy = Math.max(y, 0);
        const iw = Math.min(x + width, parent.width) - ix;
        const ih = Math.min(y + height, parent.height) - iy;
        if (iw > 0 && ih > 0 && approxEq(iw, ew) && approxEq(ih, eh)) {
          x = ix;
          y = iy;
          width = ew;
          height = eh;
          layout.x = x;
          layout.y = y;
          layout.width = width;
          layout.height = height;
          clearLayoutAffine(layout);
          layout.bakedVisual = true;
          return;
        }
      }
      x += (width - ew) / 2;
      y += (height - eh) / 2;
      width = ew;
      height = eh;
    }
    layout.x = x;
    layout.y = y;
    layout.width = width;
    layout.height = height;
    clearLayoutAffine(layout);
    layout.bakedVisual = true;
  }
  function shouldBakeEffectIntoPng(effect) {
    return effect.type === "INNER_SHADOW";
  }
  function effectsForPngExport(effects) {
    return effects.filter(shouldBakeEffectIntoPng);
  }
  async function withNodeEffectsCleared(node, run, options = {}) {
    if (!("effects" in node)) return run();
    const original = [...node.effects];
    if (original.length === 0) return run();
    const kept = options.keepInnerShadow ? effectsForPngExport(original) : [];
    if (kept.length === original.length) return run();
    try {
      node.effects = kept;
      return await run();
    } finally {
      node.effects = original;
    }
  }
  function clearEffectsDeep(node) {
    if ("effects" in node && node.effects.length > 0) {
      node.effects = effectsForPngExport(node.effects);
    }
    if ("children" in node) {
      for (const child of node.children) {
        clearEffectsDeep(child);
      }
    }
  }
  function hasVisibleDescendantOuterEffect(node) {
    if (!("children" in node)) return false;
    for (const child of node.children) {
      if (!child.visible) continue;
      if ("effects" in child && child.effects.some(
        (effect) => effect.visible !== false && !shouldBakeEffectIntoPng(effect)
      )) {
        return true;
      }
      if (hasVisibleDescendantOuterEffect(child)) return true;
    }
    return false;
  }
  async function resolveStyleName(styleId) {
    if (!styleId || styleId === figma.mixed || styleId === "") return void 0;
    try {
      const style = await figma.getStyleByIdAsync(styleId);
      return style == null ? void 0 : style.name;
    } catch (e) {
      return void 0;
    }
  }
  async function getStylesInfo(node) {
    const styles = {};
    if ("fills" in node && node.fills !== figma.mixed) {
      styles.fills = node.fills.map(serializePaint);
    }
    if ("strokes" in node) {
      styles.strokes = node.strokes.map(serializePaint);
    }
    if ("strokeWeight" in node) {
      if (node.strokeWeight === figma.mixed) {
        const sides = node;
        if (typeof sides.strokeTopWeight === "number") {
          styles.strokeTopWeight = sides.strokeTopWeight;
          styles.strokeRightWeight = sides.strokeRightWeight;
          styles.strokeBottomWeight = sides.strokeBottomWeight;
          styles.strokeLeftWeight = sides.strokeLeftWeight;
        }
      } else if (typeof node.strokeWeight === "number") {
        styles.strokeWeight = node.strokeWeight;
      }
    }
    if ("strokeAlign" in node) styles.strokeAlign = node.strokeAlign;
    if ("dashPattern" in node && node.dashPattern.length > 0) {
      styles.strokeDashes = node.dashPattern;
    }
    if ("cornerRadius" in node) styles.cornerRadius = node.cornerRadius;
    if ("topLeftRadius" in node) {
      styles.topLeftRadius = node.topLeftRadius;
      styles.topRightRadius = node.topRightRadius;
      styles.bottomLeftRadius = node.bottomLeftRadius;
      styles.bottomRightRadius = node.bottomRightRadius;
    }
    if ("effects" in node) {
      styles.effects = node.effects.map(serializeEffect);
    }
    if ("fillStyleId" in node && typeof node.fillStyleId === "string") {
      styles.fillStyleId = node.fillStyleId || void 0;
      styles.fillStyleName = await resolveStyleName(node.fillStyleId);
    }
    if ("strokeStyleId" in node && typeof node.strokeStyleId === "string") {
      styles.strokeStyleId = node.strokeStyleId || void 0;
      styles.strokeStyleName = await resolveStyleName(node.strokeStyleId);
    }
    if ("effectStyleId" in node && typeof node.effectStyleId === "string") {
      styles.effectStyleId = node.effectStyleId || void 0;
      styles.effectStyleName = await resolveStyleName(node.effectStyleId);
    }
    if (node.type === "TEXT") {
      const textNode = node;
      styles.text = {
        characters: textNode.characters,
        fontSize: textNode.fontSize === figma.mixed ? void 0 : textNode.fontSize,
        fontName: textNode.fontName === figma.mixed ? void 0 : textNode.fontName,
        fontWeight: textNode.fontWeight === figma.mixed ? void 0 : normalizeFontWeight(textNode.fontWeight),
        textAlignHorizontal: textNode.textAlignHorizontal,
        textAlignVertical: textNode.textAlignVertical,
        letterSpacing: textNode.letterSpacing,
        lineHeight: textNode.lineHeight,
        textCase: textNode.textCase === figma.mixed ? void 0 : textNode.textCase,
        textDecoration: textNode.textDecoration === figma.mixed ? void 0 : textNode.textDecoration,
        textAutoResize: textNode.textAutoResize,
        textTruncation: textNode.textTruncation,
        maxLines: textNode.maxLines,
        segments: serializeTextSegments(textNode)
      };
      const lineHeightPx = await resolveTextLineHeightPx(textNode);
      if (lineHeightPx != null) {
        styles.text.lineHeightPx = lineHeightPx;
      }
      if (typeof textNode.textStyleId === "string") {
        styles.textStyleId = textNode.textStyleId || void 0;
        styles.textStyleName = await resolveStyleName(textNode.textStyleId);
      }
    }
    return styles;
  }
  function serializeTextSegments(textNode) {
    try {
      const raw = textNode.getStyledTextSegments([
        "fills",
        "fontSize",
        "fontName",
        "fontWeight"
      ]);
      if (!raw.length) return void 0;
      return raw.map((seg) => ({
        characters: seg.characters,
        start: seg.start,
        end: seg.end,
        fills: (seg.fills || []).map(serializePaint),
        fontSize: seg.fontSize,
        fontName: seg.fontName,
        fontWeight: normalizeFontWeight(seg.fontWeight)
      }));
    } catch (e) {
      return void 0;
    }
  }
  function isAutoLineHeight(lh) {
    return lh !== figma.mixed && typeof lh === "object" && lh.unit === "AUTO";
  }
  async function loadFontsForTextNode(textNode) {
    const len = textNode.characters.length;
    if (len > 0) {
      const fonts = textNode.getRangeAllFontNames(0, len);
      for (const font of fonts) {
        await figma.loadFontAsync(font);
      }
      return;
    }
    if (textNode.fontName !== figma.mixed) {
      await figma.loadFontAsync(textNode.fontName);
    }
  }
  async function measureAutoLineHeightBySingleLine(textNode) {
    let clone = null;
    try {
      await loadFontsForTextNode(textNode);
      clone = textNode.clone();
      moveToInspectScratch(clone);
      clone.visible = true;
      const scratchParent = clone.parent;
      if (scratchParent && "layoutMode" in scratchParent && scratchParent.layoutMode !== "NONE") {
        clone.layoutGrow = 0;
        clone.layoutAlign = "INHERIT";
      }
      const raw = textNode.characters;
      const sample = raw.replace(/\s/g, "")[0] || raw.replace(/\n/g, "")[0] || "H";
      clone.textAutoResize = "WIDTH_AND_HEIGHT";
      clone.characters = sample;
      const h = clone.height;
      if (typeof h !== "number" || !(h > 0)) return void 0;
      const originalHeight = textNode.height;
      const fontSize = textNode.fontSize === figma.mixed ? void 0 : textNode.fontSize;
      if (typeof originalHeight === "number" && typeof fontSize === "number" && originalHeight > fontSize * 1.5 && Math.abs(h - originalHeight) < 0.5) {
        return void 0;
      }
      return Math.round(h * 1e3) / 1e3;
    } catch (e) {
      return void 0;
    } finally {
      clone == null ? void 0 : clone.remove();
    }
    return void 0;
  }
  async function resolveTextLineHeightPx(textNode) {
    const fontSize = textNode.fontSize === figma.mixed ? void 0 : textNode.fontSize;
    if (typeof fontSize !== "number") return void 0;
    const lh = textNode.lineHeight;
    if (lh !== figma.mixed && !isAutoLineHeight(lh)) return void 0;
    const measured = await measureAutoLineHeightBySingleLine(textNode);
    if (measured != null) return measured;
    const px = resolveAutoLineHeightPx(
      {
        characters: textNode.characters,
        fontSize,
        textAutoResize: textNode.textAutoResize,
        maxLines: textNode.maxLines === figma.mixed ? null : textNode.maxLines
      },
      { width: textNode.width, height: textNode.height }
    );
    return px != null ? px : void 0;
  }
  async function getComponentInfo(node) {
    var _a, _b;
    if (node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      return {
        isInstance: true,
        mainComponentId: (_a = main == null ? void 0 : main.id) != null ? _a : null,
        mainComponentName: (_b = main == null ? void 0 : main.name) != null ? _b : null,
        variantProperties: node.variantProperties
      };
    }
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      return { isInstance: false };
    }
    return void 0;
  }
  function getNodeLayoutWidth(node) {
    if ("width" in node && typeof node.width === "number" && node.width > 0) {
      return node.width;
    }
    const box = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
    return box && box.width > 0 ? box.width : 0;
  }
  function shouldFullExportForInspect(node, pageWidth) {
    if (!(pageWidth > 0)) return true;
    return getNodeLayoutWidth(node) <= pageWidth;
  }
  async function exportNodePng(node, scale = imageExportSettings.scale) {
    try {
      const safeScale = clampImageScale(scale);
      const options = safeScale !== 1 ? { format: "PNG", constraint: { type: "SCALE", value: safeScale } } : { format: "PNG" };
      const bytes = await withExportSlot(
        () => withNodeEffectsCleared(
          node,
          () => node.exportAsync(options),
          { keepInnerShadow: true }
        )
      );
      const pixel = readPngPixelSize(bytes);
      return {
        png: `data:image/png;base64,${figma.base64Encode(bytes)}`,
        pngByteLength: bytes.length,
        pngDesignSize: pixel ? { width: pixel.width / safeScale, height: pixel.height / safeScale } : void 0
      };
    } catch (error) {
      return {
        pngError: error instanceof Error ? error.message : String(error)
      };
    }
  }
  var INSPECT_SCRATCH_PAGE_NAME = "__node_inspector_scratch__";
  var inspectScratchPage = null;
  function cleanupOrphanScratchPages() {
    for (const page of figma.root.children) {
      if (page.type === "PAGE" && page.name === INSPECT_SCRATCH_PAGE_NAME && page !== inspectScratchPage) {
        page.remove();
      }
    }
  }
  function getInspectScratchPage() {
    if (inspectScratchPage && !inspectScratchPage.removed) {
      return inspectScratchPage;
    }
    cleanupOrphanScratchPages();
    const page = figma.createPage();
    page.name = INSPECT_SCRATCH_PAGE_NAME;
    inspectScratchPage = page;
    return page;
  }
  function disposeInspectScratchPage() {
    if (inspectScratchPage && !inspectScratchPage.removed) {
      inspectScratchPage.remove();
    }
    inspectScratchPage = null;
    cleanupOrphanScratchPages();
  }
  function moveToInspectScratch(node) {
    getInspectScratchPage().appendChild(node);
  }
  function getStrokeExportInset(node) {
    if (!("strokes" in node) || !("strokeWeight" in node) || !("strokeAlign" in node)) {
      return 0;
    }
    const strokes = node.strokes;
    if (!Array.isArray(strokes) || strokes.length === 0) return 0;
    const hasVisible = strokes.some(
      (paint) => paint && paint.visible !== false
    );
    if (!hasVisible) return 0;
    const weight = typeof node.strokeWeight === "number" ? node.strokeWeight : 0;
    if (!(weight > 0)) return 0;
    if (node.strokeAlign === "OUTSIDE") return weight;
    if (node.strokeAlign === "CENTER") return weight / 2;
    return 0;
  }
  async function exportNodePngFull(node, scale = imageExportSettings.scale) {
    if (hasVisibleDescendantOuterEffect(node)) {
      const clone2 = node.clone();
      moveToInspectScratch(clone2);
      if ("effects" in clone2 && clone2.effects.length > 0) {
        clone2.effects = effectsForPngExport(clone2.effects);
      }
      try {
        const box = "absoluteBoundingBox" in clone2 ? clone2.absoluteBoundingBox : null;
        const render = "absoluteRenderBounds" in clone2 ? clone2.absoluteRenderBounds : null;
        const result = await exportNodePng(clone2, scale);
        if (box && render && result.png) {
          result.pngVisualBounds = {
            x: render.x - box.x,
            y: render.y - box.y,
            width: render.width,
            height: render.height
          };
        }
        return result;
      } catch (error) {
        return {
          pngError: error instanceof Error ? error.message : String(error)
        };
      } finally {
        clone2.remove();
      }
    }
    if (hasMeaningfulRotation(node)) {
      const clone2 = node.clone();
      moveToInspectScratch(clone2);
      clearEffectsDeep(clone2);
      try {
        return await exportNodePng(clone2, scale);
      } catch (error) {
        return {
          pngError: error instanceof Error ? error.message : String(error)
        };
      } finally {
        clone2.remove();
      }
    }
    const bounds = "absoluteBoundingBox" in node && node.absoluteBoundingBox ? node.absoluteBoundingBox : null;
    const baseWidth = "width" in node && typeof node.width === "number" && node.width > 0 ? node.width : bounds == null ? void 0 : bounds.width;
    const baseHeight = "height" in node && typeof node.height === "number" && node.height > 0 ? node.height : bounds == null ? void 0 : bounds.height;
    if (!bounds || !baseWidth || !baseHeight) return exportNodePng(node, scale);
    const strokeInset = getStrokeExportInset(node);
    const width = baseWidth + strokeInset * 2;
    const height = baseHeight + strokeInset * 2;
    const wrapper = figma.createFrame();
    moveToInspectScratch(wrapper);
    wrapper.name = `__inspect_export_${node.name}`;
    wrapper.resize(width, height);
    wrapper.x = 0;
    wrapper.y = 0;
    wrapper.fills = [];
    wrapper.clipsContent = true;
    const clone = node.clone();
    wrapper.appendChild(clone);
    if ("x" in clone && "y" in clone) {
      clone.x = strokeInset;
      clone.y = strokeInset;
    }
    clearEffectsDeep(clone);
    try {
      return await exportNodePng(wrapper, scale);
    } catch (error) {
      return {
        pngError: error instanceof Error ? error.message : String(error)
      };
    } finally {
      wrapper.remove();
    }
  }
  async function exportNodePngForInspect(node, pageWidth) {
    if (shouldFullExportForInspect(node, pageWidth)) {
      const result2 = await exportNodePngFull(node);
      return __spreadProps(__spreadValues({}, result2), { exportInspectMode: "full" });
    }
    const result = await exportNodePng(node);
    return __spreadProps(__spreadValues({}, result), { exportInspectMode: "cropped" });
  }
  function applyInspectExportLayout(node, layout, pageWidth, exportDesignSize, visualBounds) {
    applyBakedVisualLayout(node, layout, exportDesignSize, visualBounds);
    return shouldFullExportForInspect(node, pageWidth) ? "full" : "cropped";
  }
  async function exportNodeVectorAssets(node, pageWidth) {
    const result = {};
    const png = await exportNodePngForInspect(node, pageWidth);
    if (png.png) result.png = png.png;
    if (png.pngError) result.pngError = png.pngError;
    if (png.pngByteLength) result.pngByteLength = png.pngByteLength;
    if (png.pngDesignSize) result.pngDesignSize = png.pngDesignSize;
    if (png.pngVisualBounds) result.pngVisualBounds = png.pngVisualBounds;
    if (result.png) return result;
    try {
      result.svg = await withExportSlot(
        () => withNodeEffectsCleared(
          node,
          () => node.exportAsync({ format: "SVG_STRING" })
        )
      );
    } catch (error) {
      result.svgError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }
  async function serializeNode(node, options = {}) {
    try {
      if (!node.visible) {
        const hiddenChildren = [];
        if ("children" in node) {
          for (const child of node.children) {
            const serialized = await serializeNode(child, options);
            if (serialized) hiddenChildren.push(serialized);
          }
        }
        const hiddenInfo = {
          id: node.id,
          name: node.name,
          type: node.type,
          visible: false,
          locked: node.locked,
          layout: getLayoutInfo(node),
          styles: {},
          children: hiddenChildren.length > 0 ? hiddenChildren : void 0,
          childCount: hiddenChildren.length,
          exportAsImage: isMarkedExportAsImage(node) || void 0,
          skipImageBake: isMarkedSkipImageBake(node) || void 0
        };
        attachHtmlLayoutWarningMeta(node, hiddenInfo);
        return hiddenInfo;
      }
      const pageWidth = typeof options.pageWidth === "number" && options.pageWidth > 0 ? options.pageWidth : getNodeLayoutWidth(node) || 375;
      const skipImageBake = isMarkedSkipImageBake(node);
      const exportAsImage = isMarkedExportAsImage(node) && !skipImageBake;
      const bakeMaskGroup = !exportAsImage && !skipImageBake && shouldBakeMaskGroup(node);
      const bakeVectorGroup = !exportAsImage && !skipImageBake && !bakeMaskGroup && !options.skipSvg && (shouldBakeAllShapeFrame(node) || isVectorContainerType(node.type) && shouldExportSvg(node) || shouldBakeDenseVectorGroup(node) || shouldBakeSmallContainer(node));
      const bakeRotated = !exportAsImage && !skipImageBake && !bakeVectorGroup && !bakeMaskGroup && shouldBakeRotatedNode(node);
      const bakeAsPng = exportAsImage || bakeRotated || bakeMaskGroup;
      const exportAsVector = !bakeAsPng && !skipImageBake && !options.skipSvg && (shouldExportSvg(node) || bakeVectorGroup);
      const skipChildSvg = options.skipSvg || exportAsVector || bakeAsPng;
      const skipChildren = bakeVectorGroup || bakeAsPng;
      const children = [];
      if ("children" in node && !skipChildren) {
        for (const child of node.children) {
          const serialized = await serializeNode(child, {
            skipSvg: skipChildSvg,
            pageWidth
          });
          if (serialized) children.push(serialized);
        }
      }
      const layout = getLayoutInfo(node);
      const info = {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        locked: node.locked,
        layout,
        styles: await getStylesInfo(node),
        children: children.length > 0 ? children : void 0,
        childCount: children.length
      };
      if ("opacity" in node) info.opacity = node.opacity;
      if ("blendMode" in node) info.blendMode = node.blendMode;
      if ("clipsContent" in node) info.clipsContent = node.clipsContent;
      if (skipImageBake) info.skipImageBake = true;
      if (bakeAsPng) {
        if (exportAsImage) info.exportAsImage = true;
        const exported = await exportNodePngForInspect(node, pageWidth);
        if (exported.png) info.png = exported.png;
        if (exported.pngError) info.pngError = exported.pngError;
        if (exported.pngByteLength) info.pngByteLength = exported.pngByteLength;
        if (exported.png) {
          info.flattened = true;
          info.children = void 0;
          info.childCount = 0;
          info.exportInspectMode = applyInspectExportLayout(
            node,
            info.layout,
            pageWidth,
            exported.pngDesignSize,
            exported.pngVisualBounds
          );
        } else if ("children" in node) {
          for (const child of node.children) {
            const serialized = await serializeNode(child, {
              skipSvg: skipChildSvg,
              pageWidth
            });
            if (serialized) children.push(serialized);
          }
          info.children = children.length > 0 ? children : void 0;
          info.childCount = children.length;
        }
      } else if (exportAsVector) {
        const exported = await exportNodeVectorAssets(node, pageWidth);
        if (exported.svg) info.svg = exported.svg;
        if (exported.svgError) info.svgError = exported.svgError;
        if (exported.png) info.png = exported.png;
        if (exported.pngError) info.pngError = exported.pngError;
        if (exported.pngByteLength) info.pngByteLength = exported.pngByteLength;
        const bakedOk = !!(exported.png || exported.svg);
        const exportSize = exported.pngDesignSize || (exported.svg ? readSvgDesignSize(exported.svg) : null);
        if (bakeVectorGroup && bakedOk) {
          info.flattened = true;
          info.children = void 0;
          info.childCount = 0;
          info.exportInspectMode = applyInspectExportLayout(
            node,
            info.layout,
            pageWidth,
            exportSize,
            exported.pngVisualBounds
          );
        } else if (bakedOk) {
          info.flattened = true;
          info.exportInspectMode = applyInspectExportLayout(
            node,
            info.layout,
            pageWidth,
            exportSize,
            exported.pngVisualBounds
          );
        }
      }
      const component = await getComponentInfo(node);
      if (component) info.component = component;
      attachHtmlLayoutWarningMeta(node, info);
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: "visible" in node ? node.visible : true,
        locked: "locked" in node ? node.locked : false,
        layout: { x: 0, y: 0, width: 0, height: 0 },
        styles: {},
        childCount: 0,
        children: void 0,
        // 保留失败信息，便于在 JSON 中排查单个节点
        component: {
          isInstance: false,
          mainComponentName: `serialize error: ${message}`
        }
      };
    }
  }
  function collectImageHashes(nodes, hashes = /* @__PURE__ */ new Set()) {
    for (const node of nodes) {
      for (const paint of node.styles.fills || []) {
        if (paint.type === "IMAGE" && paint.imageHash) {
          hashes.add(paint.imageHash);
        }
      }
      for (const paint of node.styles.strokes || []) {
        if (paint.type === "IMAGE" && paint.imageHash) {
          hashes.add(paint.imageHash);
        }
      }
      if (node.children) collectImageHashes(node.children, hashes);
    }
    return hashes;
  }
  function hashBytes(bytes) {
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function encodeUtf8(text) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(text);
    }
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 255;
    }
    return bytes;
  }
  function normalizeBakeSizeKey(width, height) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    const step = BAKE_SIZE_NORMALIZE_STEP;
    const longBucket = Math.max(step, Math.floor(long / step) * step);
    const ratio = Math.round(long / short * 2) / 2;
    const orient = w >= h ? "l" : "p";
    return `${longBucket}_${orient}_${ratio}`;
  }
  function vectorAssetKey(node, contentHash) {
    var _a, _b;
    const mainId = (_a = node.component) == null ? void 0 : _a.mainComponentId;
    if (((_b = node.component) == null ? void 0 : _b.isInstance) && typeof mainId === "string" && mainId) {
      const sizeKey = normalizeBakeSizeKey(
        node.layout.width,
        node.layout.height
      );
      const logical = hashBytes(encodeUtf8(`${mainId}\0${sizeKey}`));
      return `${VECTOR_IMAGE_PREFIX}c${logical}`;
    }
    return `${VECTOR_IMAGE_PREFIX}${contentHash}`;
  }
  function countImageFillReferences(nodes) {
    const perHash = /* @__PURE__ */ new Map();
    let total = 0;
    const walk = (list) => {
      for (const node of list) {
        for (const paint of [
          ...node.styles.fills || [],
          ...node.styles.strokes || []
        ]) {
          if (paint.type === "IMAGE" && paint.imageHash) {
            total += 1;
            perHash.set(paint.imageHash, (perHash.get(paint.imageHash) || 0) + 1);
          }
        }
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    return { perHash, total };
  }
  function isImageAssetWithData(asset) {
    return Boolean(asset && "dataUrl" in asset && asset.dataUrl);
  }
  function dedupeImagesByContent(images) {
    const byContent = /* @__PURE__ */ new Map();
    let merged = 0;
    for (const key of Object.keys(images)) {
      if (key.startsWith("v:")) continue;
      const asset = images[key];
      if (!isImageAssetWithData(asset)) continue;
      const payload = asset.dataUrl.split(",")[1];
      if (!payload) continue;
      const bytes = figma.base64Decode(payload);
      const contentHash = hashBytes(bytes);
      asset.contentHash = contentHash;
      const primary = byContent.get(contentHash);
      if (primary && primary !== key) {
        images[key] = {
          duplicateOf: primary,
          contentHash,
          mime: asset.mime,
          byteLength: asset.byteLength,
          refCount: asset.refCount,
          source: asset.source
        };
        merged += 1;
      } else {
        byContent.set(contentHash, key);
      }
    }
    return merged;
  }
  var VECTOR_IMAGE_PREFIX = "v:";
  var SVG_ASSET_PREFIX = "s:";
  function stripRedundantSvg(nodes) {
    const walk = (list) => {
      for (const node of list) {
        if ((node.png || node.pngRef) && node.svg) {
          delete node.svg;
        }
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
  }
  function poolSvgAssets(nodes, svgs) {
    let refs = 0;
    const walk = (list) => {
      for (const node of list) {
        if (node.visible === false) {
          if (node.children) walk(node.children);
          continue;
        }
        if (typeof node.svg === "string" && node.svg.trim()) {
          refs += 1;
          const bytes = encodeUtf8(node.svg);
          const contentHash = hashBytes(bytes);
          const key = `${SVG_ASSET_PREFIX}${contentHash}`;
          const existing = svgs[key];
          if (existing) {
            existing.refCount = (existing.refCount || 1) + 1;
          } else {
            svgs[key] = {
              mime: "image/svg+xml",
              source: node.svg,
              byteLength: bytes.length,
              contentHash,
              origin: "vector",
              refCount: 1
            };
          }
          node.svgRef = key;
          delete node.svg;
        }
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    return {
      refs,
      unique: Object.keys(svgs).length
    };
  }
  function poolVectorPngAssets(nodes, images) {
    let refs = 0;
    const walk = (list) => {
      for (const node of list) {
        if (node.png) {
          refs += 1;
          const payload = node.png.replace(/^data:image\/png;base64,/, "");
          const bytes = figma.base64Decode(payload);
          const contentHash = hashBytes(bytes);
          const key = vectorAssetKey(node, contentHash);
          const source = node.exportAsImage ? "marked" : "vector";
          const existing = images[key];
          if (isImageAssetWithData(existing)) {
            existing.refCount = (existing.refCount || 1) + 1;
            if (source === "marked") existing.source = "marked";
            if (bytes.length > (existing.byteLength || 0)) {
              existing.dataUrl = node.png;
              existing.byteLength = bytes.length;
              existing.contentHash = contentHash;
            }
          } else {
            images[key] = {
              mime: "image/png",
              dataUrl: node.png,
              byteLength: bytes.length,
              contentHash,
              source,
              refCount: 1
            };
          }
          node.pngRef = key;
          delete node.png;
          delete node.pngByteLength;
        }
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    const unique = Object.keys(images).filter(
      (k) => k.startsWith(VECTOR_IMAGE_PREFIX)
    ).length;
    return { refs, unique };
  }
  function countUniqueImageAssets(images) {
    return Object.values(images).filter((a) => isImageAssetWithData(a)).length;
  }
  function applyImageRefCounts(images, perHash) {
    for (const [hash, count] of perHash) {
      const asset = images[hash];
      if (!asset || "error" in asset) continue;
      if ("duplicateOf" in asset) continue;
      asset.refCount = count;
      if (!asset.source) asset.source = "fill";
    }
  }
  function isSystemFontFamily(family) {
    const f = family.toLowerCase();
    return f.includes("sf pro") || f.includes("sf compact") || f.includes("sf mono") || f.includes("new york") || f.startsWith(".sf") || f.includes("pingfang") || f.includes("helvetica") || f.includes("apple color emoji") || f === "system-ui";
  }
  var GOOGLE_FONT_FAMILY_MAP = {
    PoetsenOne: "Poetsen One",
    "Poetsen One": "Poetsen One",
    Montserrat: "Montserrat",
    Inter: "Inter",
    Roboto: "Roboto",
    "Open Sans": "Open Sans",
    Lato: "Lato",
    Poppins: "Poppins",
    Nunito: "Nunito",
    Raleway: "Raleway",
    Outfit: "Outfit",
    Manrope: "Manrope",
    "Noto Sans": "Noto Sans",
    "Noto Sans SC": "Noto Sans SC"
  };
  function resolveFontProvider(family) {
    if (isSystemFontFamily(family)) return "system";
    if (GOOGLE_FONT_FAMILY_MAP[family]) return "google";
    return "unknown";
  }
  function collectFontsUsed(nodes) {
    const map = /* @__PURE__ */ new Map();
    const addFontRef = (fontName, fontWeight) => {
      if (!(fontName == null ? void 0 : fontName.family)) return;
      const family = fontName.family;
      const style = fontName.style || "Regular";
      const key = `${family}::${style}`;
      if (!map.has(key)) {
        map.set(key, {
          family,
          style,
          weight: normalizeFontWeight(fontWeight),
          provider: resolveFontProvider(family)
        });
      }
    };
    const walk = (list) => {
      var _a;
      for (const node of list) {
        if (node.visible !== false) {
          const text = (_a = node.styles) == null ? void 0 : _a.text;
          if (text) {
            addFontRef(text.fontName, text.fontWeight);
            for (const seg of text.segments || []) {
              addFontRef(seg.fontName, seg.fontWeight);
            }
          }
        }
        if (node.children) walk(node.children);
      }
    };
    walk(nodes);
    return Array.from(map.values()).sort(
      (a, b) => `${a.family}${a.style}`.localeCompare(`${b.family}${b.style}`)
    );
  }
  function detectImageMime(bytes) {
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
      return "image/jpeg";
    }
    if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
      return "image/png";
    }
    if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) {
      return "image/gif";
    }
    if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
      return "image/webp";
    }
    return "application/octet-stream";
  }
  function bytesToBase64(bytes) {
    return figma.base64Encode(bytes);
  }
  async function exportImagesByHash(hashes, onProgress, into = {}) {
    const images = into;
    const total = hashes.length;
    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i];
      onProgress == null ? void 0 : onProgress(i + 1, total);
      if (images[hash]) continue;
      try {
        const image = figma.getImageByHash(hash);
        if (!image) {
          images[hash] = { error: "image not found for hash" };
          continue;
        }
        const bytes = await withExportSlot(() => image.getBytesAsync());
        const mime = detectImageMime(bytes);
        const base64 = bytesToBase64(bytes);
        images[hash] = {
          mime,
          dataUrl: `data:${mime};base64,${base64}`,
          byteLength: bytes.length,
          source: "fill"
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        images[hash] = { error: message };
      }
    }
    return images;
  }
  async function postResultPayload(payload, generation) {
    if (generation !== inspectGeneration) return;
    if (payload.length <= RESULT_PAYLOAD_CHUNK_CHARS) {
      figma.ui.postMessage({ type: "result", payload });
      return;
    }
    const id = `r-${generation}-${Date.now()}`;
    const total = Math.ceil(payload.length / RESULT_PAYLOAD_CHUNK_CHARS);
    figma.ui.postMessage({
      type: "result-start",
      id,
      total,
      chars: payload.length
    });
    for (let i = 0; i < total; i++) {
      if (generation !== inspectGeneration) return;
      const start = i * RESULT_PAYLOAD_CHUNK_CHARS;
      figma.ui.postMessage({
        type: "result-chunk",
        id,
        index: i,
        total,
        chunk: payload.slice(start, start + RESULT_PAYLOAD_CHUNK_CHARS)
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (generation !== inspectGeneration) return;
    figma.ui.postMessage({ type: "result-end", id });
  }
  var inspectGeneration = 0;
  var inspectedRootIds = [];
  var suppressSelectionInspect = false;
  var rootLocked = false;
  var ROOT_LOCK_STORAGE_KEY = "root-lock";
  function isSceneNode(node) {
    return node.type !== "DOCUMENT" && node.type !== "PAGE";
  }
  function isUnderInspectedRoots(node) {
    if (inspectedRootIds.length === 0) return false;
    let current = node;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if (inspectedRootIds.includes(current.id)) return true;
      current = current.parent;
    }
    return false;
  }
  function postSelectionSync() {
    figma.ui.postMessage({
      type: "selection-sync",
      nodeIds: figma.currentPage.selection.map((n) => n.id)
    });
  }
  function postRootLockState() {
    figma.ui.postMessage({
      type: "root-lock",
      locked: rootLocked
    });
  }
  async function setRootLocked(locked) {
    rootLocked = Boolean(locked);
    void figma.clientStorage.setAsync(ROOT_LOCK_STORAGE_KEY, rootLocked);
    postRootLockState();
  }
  async function selectNodeById(nodeId) {
    await figma.currentPage.loadAsync();
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || !isSceneNode(node)) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u8282\u70B9\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664",
        nodeId
      });
      return;
    }
    suppressSelectionInspect = true;
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    postSelectionSync();
    setTimeout(() => {
      suppressSelectionInspect = false;
    }, 0);
  }
  async function selectParentOfNode(nodeId) {
    await figma.currentPage.loadAsync();
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || !isSceneNode(node)) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u8282\u70B9\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664",
        nodeId
      });
      return;
    }
    const parent = node.parent;
    if (!parent || !isSceneNode(parent)) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u5DF2\u662F\u9875\u9762\u9876\u5C42\uFF0C\u6CA1\u6709\u53EF\u9009\u62E9\u7684\u7236\u8282\u70B9",
        nodeId
      });
      return;
    }
    if (isUnderInspectedRoots(parent)) {
      await selectNodeById(parent.id);
      return;
    }
    suppressSelectionInspect = true;
    figma.currentPage.selection = [parent];
    figma.viewport.scrollAndZoomIntoView([parent]);
    postSelectionSync();
    try {
      await inspectNodes([parent]);
    } finally {
      setTimeout(() => {
        suppressSelectionInspect = false;
      }, 0);
    }
  }
  async function renameNodeById(nodeId, name) {
    const trimmed = String(name != null ? name : "").trim();
    if (!trimmed) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A",
        nodeId
      });
      return;
    }
    await figma.currentPage.loadAsync();
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || !("name" in node)) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u8282\u70B9\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u91CD\u547D\u540D",
        nodeId
      });
      return;
    }
    node.name = trimmed;
    figma.ui.postMessage({
      type: "renamed",
      nodeId,
      name: node.name
    });
  }
  async function reinspectCurrentRoots(fallback) {
    const roots = [];
    for (const id of inspectedRootIds) {
      const root = await figma.getNodeByIdAsync(id);
      if (root && isSceneNode(root)) roots.push(root);
    }
    if (roots.length > 0) {
      await inspectNodes(roots);
      return;
    }
    if (fallback) {
      await inspectNodes([fallback]);
      return;
    }
    await inspectSelection();
  }
  async function setExportAsImageMark(nodeId, marked) {
    await setExportAsImageBatch([nodeId], marked);
  }
  async function setExportAsImageBatch(nodeIds, marked) {
    await figma.currentPage.loadAsync();
    let ok = 0;
    let lastNode = null;
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || !isSceneNode(node)) continue;
      node.setPluginData(PLUGIN_DATA_EXPORT_AS_IMAGE, marked ? "1" : "");
      if (marked) {
        node.setPluginData(PLUGIN_DATA_SKIP_IMAGE_BAKE, "");
      }
      lastNode = node;
      ok += 1;
    }
    if (ok === 0) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u6CA1\u6709\u53EF\u6807\u8BB0\u7684\u8282\u70B9"
      });
      return;
    }
    await reinspectCurrentRoots(lastNode);
  }
  async function setSkipImageBakeBatch(nodeIds, skip) {
    await figma.currentPage.loadAsync();
    let ok = 0;
    let lastNode = null;
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || !isSceneNode(node)) continue;
      node.setPluginData(PLUGIN_DATA_SKIP_IMAGE_BAKE, skip ? "1" : "");
      if (skip) {
        node.setPluginData(PLUGIN_DATA_EXPORT_AS_IMAGE, "");
      }
      lastNode = node;
      ok += 1;
    }
    if (ok === 0) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u6CA1\u6709\u53EF\u6807\u8BB0\u7684\u8282\u70B9"
      });
      return;
    }
    await reinspectCurrentRoots(lastNode);
  }
  async function setNodesVisible(nodeIds, visible) {
    await figma.currentPage.loadAsync();
    let ok = 0;
    let lastNode = null;
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || !isSceneNode(node)) continue;
      node.visible = visible;
      lastNode = node;
      ok += 1;
    }
    if (ok === 0) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u6CA1\u6709\u53EF\u8BBE\u7F6E\u53EF\u89C1\u6027\u7684\u8282\u70B9"
      });
      return;
    }
    await reinspectCurrentRoots(lastNode);
  }
  async function inspectNodes(selection) {
    await imageExportSettingsReady;
    const generation = ++inspectGeneration;
    try {
      await figma.currentPage.loadAsync();
      if (selection.length === 0) {
        if (generation !== inspectGeneration) return;
        inspectedRootIds = [];
        figma.ui.postMessage({
          type: "empty",
          message: "\u8BF7\u5148\u5728\u753B\u5E03\u4E2D\u9009\u4E2D\u81F3\u5C11\u4E00\u4E2A\u8282\u70B9"
        });
        return;
      }
      getInspectScratchPage();
      const rootTotal = selection.length;
      figma.ui.postMessage({
        type: "loading",
        message: rootTotal > 1 ? `\u6B63\u5728\u8BFB\u53D6 0/${rootTotal} \u4E2A\u6839\u8282\u70B9\u2026` : `\u6B63\u5728\u8BFB\u53D6 ${selection[0].name}\u2026`,
        selectedCount: rootTotal
      });
      const nodes = [];
      const images = {};
      const svgs = {};
      let vectorPngRefs = 0;
      for (let i = 0; i < selection.length; i++) {
        if (generation !== inspectGeneration) return;
        const node = selection[i];
        figma.ui.postMessage({
          type: "loading",
          message: rootTotal > 1 ? `\u6B63\u5728\u8BFB\u53D6 ${i + 1}/${rootTotal}\uFF1A${node.name}\u2026` : `\u6B63\u5728\u8BFB\u53D6 ${node.name}\u2026`,
          selectedCount: rootTotal
        });
        const pageWidth = getNodeLayoutWidth(node) || 375;
        const serialized = await serializeNode(node, { pageWidth });
        if (!serialized) continue;
        attachRootRelativeCoords(serialized);
        stripRedundantSvg([serialized]);
        const vectorPool = poolVectorPngAssets([serialized], images);
        vectorPngRefs += vectorPool.refs;
        poolSvgAssets([serialized], svgs);
        nodes.push(serialized);
      }
      if (nodes.length === 0) {
        if (generation !== inspectGeneration) return;
        inspectedRootIds = [];
        figma.ui.postMessage({
          type: "empty",
          message: "\u9009\u4E2D\u5185\u5BB9\u5747\u4E3A\u9690\u85CF\u5C42\uFF0C\u65E0\u53EF\u5BFC\u51FA\u8282\u70B9"
        });
        return;
      }
      inspectedRootIds = nodes.map((n) => n.id);
      const hashes = Array.from(collectImageHashes(nodes));
      if (hashes.length > 0) {
        if (generation !== inspectGeneration) return;
        figma.ui.postMessage({
          type: "loading",
          message: `\u6B63\u5728\u5BFC\u51FA\u56FE\u7247 0/${hashes.length}\u2026`,
          selectedCount: selection.length
        });
        await exportImagesByHash(
          hashes,
          (done, total) => {
            if (generation !== inspectGeneration) return;
            figma.ui.postMessage({
              type: "loading",
              message: `\u6B63\u5728\u5BFC\u51FA\u56FE\u7247 ${done}/${total}\u2026`,
              selectedCount: selection.length
            });
          },
          images
        );
      }
      const fillRefs = countImageFillReferences(nodes);
      applyImageRefCounts(images, fillRefs.perHash);
      const mergedFillDupes = dedupeImagesByContent(images);
      if (generation !== inspectGeneration) return;
      const totalCount = countNodes(nodes);
      const svgStats = countSvgNodes(nodes);
      const pngStats = countPngNodes(nodes);
      const fonts = collectFontsUsed(nodes);
      const imageUniqueCount = countUniqueImageAssets(images);
      const exportAsImageCount = countExportAsImageNodes(nodes);
      const htmlLayoutWarnings = collectHtmlLayoutWarnings(nodes);
      const vectorPngUniqueCount = Object.keys(images).filter(
        (k) => k.startsWith(VECTOR_IMAGE_PREFIX)
      ).length;
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
        vectorPngRefCount: vectorPngRefs,
        vectorPngUniqueCount,
        svgCount: svgStats.ok,
        svgErrorCount: svgStats.error,
        svgAssetCount: Object.keys(svgs).length,
        pngCount: pngStats.ok,
        pngErrorCount: pngStats.error,
        exportAsImageCount,
        fontCount: fonts.length,
        fonts,
        images,
        svgs,
        nodes
      };
      if (generation !== inspectGeneration) return;
      figma.ui.postMessage({
        type: "loading",
        message: "\u6B63\u5728\u56DE\u4F20\u7ED3\u679C\u2026",
        selectedCount: selection.length
      });
      const payload = JSON.stringify(data);
      await postResultPayload(payload, generation);
    } catch (error) {
      if (generation !== inspectGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      figma.ui.postMessage({
        type: "error",
        message: `\u8BFB\u53D6\u5931\u8D25\uFF1A${message}`
      });
    } finally {
      if (generation === inspectGeneration) {
        disposeInspectScratchPage();
      }
    }
  }
  async function inspectSelection() {
    await figma.currentPage.loadAsync();
    await inspectNodes(figma.currentPage.selection.slice());
  }
  function countNodes(nodes) {
    let count = 0;
    for (const node of nodes) {
      count += 1;
      if (node.children) count += countNodes(node.children);
    }
    return count;
  }
  function countSvgNodes(nodes) {
    let ok = 0;
    let error = 0;
    for (const node of nodes) {
      if (node.svg || node.svgRef) ok += 1;
      if (node.svgError) error += 1;
      if (node.children) {
        const nested = countSvgNodes(node.children);
        ok += nested.ok;
        error += nested.error;
      }
    }
    return { ok, error };
  }
  function countPngNodes(nodes) {
    let ok = 0;
    let error = 0;
    for (const node of nodes) {
      if (node.png || node.pngRef) ok += 1;
      if (node.pngError && !node.png && !node.pngRef) error += 1;
      if (node.children) {
        const nested = countPngNodes(node.children);
        ok += nested.ok;
        error += nested.error;
      }
    }
    return { ok, error };
  }
  function countExportAsImageNodes(nodes) {
    let count = 0;
    for (const node of nodes) {
      if (node.exportAsImage) count += 1;
      if (node.children) count += countExportAsImageNodes(node.children);
    }
    return count;
  }
  var UI_DEFAULT_SIZE = { width: 480, height: 800 };
  var UI_MIN_SIZE = { width: 360, height: 400 };
  var UI_MAX_SIZE = { width: 1600, height: 1200 };
  var UI_SIZE_STORAGE_KEY = "ui-window-size";
  var IMAGE_EXPORT_SETTINGS_KEY = "image-export-settings";
  var EXPORT_SETTINGS_KEY = "export-settings";
  var LEGACY_CODEGEN_SETTINGS_KEY = "codegen-settings";
  var DEFAULT_IMAGE_EXPORT_SETTINGS = {
    scale: 2,
    format: "PNG"
  };
  var DEFAULT_EXPORT_SETTINGS = {
    includeDesignPreview: true
  };
  var imageExportSettings = __spreadValues({}, DEFAULT_IMAGE_EXPORT_SETTINGS);
  var resolveImageExportSettingsReady = null;
  var imageExportSettingsReady = new Promise((resolve) => {
    resolveImageExportSettingsReady = resolve;
  });
  var exportSettings = __spreadValues({}, DEFAULT_EXPORT_SETTINGS);
  function clampImageScale(scale) {
    if (scale === 3 || scale === 2 || scale === 1) return scale;
    if (scale === 0.5) return 0.5;
    return DEFAULT_IMAGE_EXPORT_SETTINGS.scale;
  }
  function normalizeImageExportSettings(raw) {
    if (!raw || typeof raw !== "object") {
      return __spreadValues({}, DEFAULT_IMAGE_EXPORT_SETTINGS);
    }
    const obj = raw;
    const format = obj.format === "JPG" || obj.format === "SVG" || obj.format === "PNG" ? obj.format : DEFAULT_IMAGE_EXPORT_SETTINGS.format;
    const scale = typeof obj.scale === "number" ? clampImageScale(obj.scale) : DEFAULT_IMAGE_EXPORT_SETTINGS.scale;
    return { scale, format };
  }
  function normalizeExportSettings(raw) {
    if (!raw || typeof raw !== "object") {
      return __spreadValues({}, DEFAULT_EXPORT_SETTINGS);
    }
    const obj = raw;
    const includeDesignPreview = typeof obj.includeDesignPreview === "boolean" ? obj.includeDesignPreview : DEFAULT_EXPORT_SETTINGS.includeDesignPreview;
    return { includeDesignPreview };
  }
  function sanitizeExportFilename(name, fallback) {
    const cleaned = String(name || fallback || "export").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
    return cleaned || fallback || "export";
  }
  async function exportNodesAsImageFiles(nodeIds, settings) {
    await figma.currentPage.loadAsync();
    const cfg = normalizeImageExportSettings(__spreadValues(__spreadValues({}, imageExportSettings), settings || {}));
    imageExportSettings = cfg;
    const ids = (nodeIds || []).filter(Boolean);
    if (ids.length === 0) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u8282\u70B9"
      });
      return;
    }
    figma.ui.postMessage({
      type: "image-export-progress",
      message: `\u6B63\u5728\u5BFC\u51FA\u56FE\u7247 0/${ids.length}\u2026`
    });
    const files = [];
    for (let i = 0; i < ids.length; i++) {
      figma.ui.postMessage({
        type: "image-export-progress",
        message: `\u6B63\u5728\u5BFC\u51FA\u56FE\u7247 ${i + 1}/${ids.length}\u2026`
      });
      const node = await figma.getNodeByIdAsync(ids[i]);
      if (!node || !isSceneNode(node)) continue;
      try {
        let bytes;
        let mime;
        let ext;
        if (cfg.format === "SVG") {
          bytes = await node.exportAsync({ format: "SVG" });
          mime = "image/svg+xml";
          ext = "svg";
        } else if (cfg.format === "JPG") {
          bytes = await node.exportAsync({
            format: "JPG",
            constraint: { type: "SCALE", value: cfg.scale }
          });
          mime = "image/jpeg";
          ext = "jpg";
        } else {
          bytes = await node.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: cfg.scale }
          });
          mime = "image/png";
          ext = "png";
        }
        const base = sanitizeExportFilename(node.name, `node-${i + 1}`);
        const scaleSuffix = cfg.format === "SVG" || cfg.scale === 1 ? "" : `@${cfg.scale}x`;
        files.push({
          name: `${base}${scaleSuffix}.${ext}`,
          mime,
          base64: figma.base64Encode(bytes)
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        figma.ui.postMessage({
          type: "action-error",
          message: `\u5BFC\u51FA\u5931\u8D25\uFF08${node.name}\uFF09\uFF1A${message}`,
          nodeId: node.id
        });
      }
    }
    if (files.length === 0) {
      figma.ui.postMessage({
        type: "action-error",
        message: "\u6CA1\u6709\u6210\u529F\u5BFC\u51FA\u7684\u56FE\u7247"
      });
      return;
    }
    figma.ui.postMessage({
      type: "image-export-result",
      files,
      scale: cfg.scale,
      format: cfg.format
    });
  }
  async function exportDesignPreview(nodeIds, scale) {
    await figma.currentPage.loadAsync();
    const ids = (nodeIds || []).filter(Boolean);
    if (ids.length === 0) {
      figma.ui.postMessage({
        type: "design-preview-result",
        error: "\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u6839\u8282\u70B9"
      });
      return;
    }
    const safeScale = clampImageScale(
      typeof scale === "number" ? scale : imageExportSettings.scale
    );
    figma.ui.postMessage({
      type: "design-preview-progress",
      message: "\u6B63\u5728\u5BFC\u51FA\u539F\u7A3F PNG\u2026"
    });
    try {
      const node = await figma.getNodeByIdAsync(ids[0]);
      if (!node || !isSceneNode(node)) {
        figma.ui.postMessage({
          type: "design-preview-result",
          error: "\u6839\u8282\u70B9\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664"
        });
        return;
      }
      const bytes = await node.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: safeScale }
      });
      figma.ui.postMessage({
        type: "design-preview-result",
        file: {
          name: "design.png",
          mime: "image/png",
          base64: figma.base64Encode(bytes),
          scale: safeScale,
          nodeId: node.id,
          nodeName: node.name,
          width: "width" in node ? node.width : void 0,
          height: "height" in node ? node.height : void 0
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      figma.ui.postMessage({
        type: "design-preview-result",
        error: `\u539F\u7A3F\u5BFC\u51FA\u5931\u8D25\uFF1A${message}`
      });
    }
  }
  function clampUiSize(width, height) {
    return {
      width: Math.min(
        UI_MAX_SIZE.width,
        Math.max(UI_MIN_SIZE.width, Math.round(width))
      ),
      height: Math.min(
        UI_MAX_SIZE.height,
        Math.max(UI_MIN_SIZE.height, Math.round(height))
      )
    };
  }
  figma.showUI(__html__, {
    width: UI_DEFAULT_SIZE.width,
    height: UI_DEFAULT_SIZE.height,
    themeColors: true
  });
  void figma.clientStorage.getAsync(UI_SIZE_STORAGE_KEY).then((saved) => {
    if (!saved || typeof saved !== "object" || typeof saved.width !== "number" || typeof saved.height !== "number") {
      return;
    }
    const size = clampUiSize(
      saved.width,
      saved.height
    );
    figma.ui.resize(size.width, size.height);
  });
  void figma.clientStorage.getAsync(IMAGE_EXPORT_SETTINGS_KEY).then((saved) => {
    imageExportSettings = normalizeImageExportSettings(saved);
    figma.ui.postMessage({
      type: "image-export-settings",
      settings: imageExportSettings
    });
  }).catch(() => {
  }).then(() => {
    resolveImageExportSettingsReady == null ? void 0 : resolveImageExportSettingsReady();
    resolveImageExportSettingsReady = null;
  });
  void figma.clientStorage.getAsync(EXPORT_SETTINGS_KEY).then(async (saved) => {
    if (saved == null) {
      return figma.clientStorage.getAsync(LEGACY_CODEGEN_SETTINGS_KEY);
    }
    return saved;
  }).then((saved) => {
    exportSettings = normalizeExportSettings(saved);
    figma.ui.postMessage({
      type: "export-settings",
      settings: exportSettings
    });
  }).catch(() => {
  });
  void figma.clientStorage.getAsync(ROOT_LOCK_STORAGE_KEY).then((saved) => {
    rootLocked = saved === true;
    postRootLockState();
  });
  var bridge = createBridge({
    onDocumentChanged: () => {
      figma.ui.postMessage({ type: "bridge-document-changed" });
    },
    onBusyChange: (busy) => {
      figma.ui.postMessage({ type: "bridge-busy", busy });
    }
  });
  figma.ui.onmessage = async (msg) => {
    if (msg.type === "bridge-hello") {
      figma.ui.postMessage({
        type: "bridge-ready",
        fileName: figma.root.name,
        fileKey: figma.fileKey || null
      });
      return;
    }
    if (msg.type === "bridge-job") {
      bridge.enqueue(msg.job, (payload) => {
        figma.ui.postMessage({ type: "bridge-result", payload });
      });
      return;
    }
    if (msg.type === "resize") {
      const size = clampUiSize(msg.width, msg.height);
      figma.ui.resize(size.width, size.height);
      void figma.clientStorage.setAsync(UI_SIZE_STORAGE_KEY, size);
      return;
    }
    if (msg.type === "set-image-export-settings") {
      const prevScale = imageExportSettings.scale;
      imageExportSettings = normalizeImageExportSettings(__spreadProps(__spreadValues({}, imageExportSettings), {
        scale: msg.scale,
        format: msg.format
      }));
      void figma.clientStorage.setAsync(
        IMAGE_EXPORT_SETTINGS_KEY,
        imageExportSettings
      );
      figma.ui.postMessage({
        type: "image-export-settings",
        settings: imageExportSettings
      });
      if (prevScale !== imageExportSettings.scale) {
        if (rootLocked && inspectedRootIds.length > 0) {
          await reinspectCurrentRoots();
        } else {
          await inspectSelection();
        }
      }
      return;
    }
    if (msg.type === "set-export-settings") {
      exportSettings = normalizeExportSettings(__spreadProps(__spreadValues({}, exportSettings), {
        includeDesignPreview: msg.includeDesignPreview
      }));
      void figma.clientStorage.setAsync(EXPORT_SETTINGS_KEY, exportSettings);
      figma.ui.postMessage({
        type: "export-settings",
        settings: exportSettings
      });
      return;
    }
    if (msg.type === "export-as-image") {
      await exportNodesAsImageFiles(msg.nodeIds || [], {
        scale: msg.scale,
        format: msg.format
      });
      return;
    }
    if (msg.type === "export-design-preview") {
      await exportDesignPreview(msg.nodeIds || [], msg.scale);
      return;
    }
    if (msg.type === "set-root-lock") {
      await setRootLocked(msg.locked);
      return;
    }
    if (msg.type === "ready" || msg.type === "inspect") {
      figma.ui.postMessage({
        type: "image-export-settings",
        settings: imageExportSettings
      });
      figma.ui.postMessage({
        type: "export-settings",
        settings: exportSettings
      });
      postRootLockState();
      if (msg.type === "inspect" && rootLocked && inspectedRootIds.length > 0) {
        await reinspectCurrentRoots();
      } else {
        await inspectSelection();
      }
    }
    if (msg.type === "select-node") {
      await selectNodeById(msg.nodeId);
    }
    if (msg.type === "select-parent") {
      await selectParentOfNode(msg.nodeId);
    }
    if (msg.type === "rename-node") {
      await renameNodeById(msg.nodeId, msg.name);
    }
    if (msg.type === "set-export-as-image") {
      await setExportAsImageMark(msg.nodeId, msg.marked);
    }
    if (msg.type === "set-export-as-image-batch") {
      await setExportAsImageBatch(msg.nodeIds || [], msg.marked);
    }
    if (msg.type === "set-skip-image-bake") {
      await setSkipImageBakeBatch([msg.nodeId], msg.skip);
    }
    if (msg.type === "set-skip-image-bake-batch") {
      await setSkipImageBakeBatch(msg.nodeIds || [], msg.skip);
    }
    if (msg.type === "set-visible-batch") {
      await setNodesVisible(msg.nodeIds || [], msg.visible);
    }
    if (msg.type === "close") {
      figma.closePlugin();
    }
  };
  figma.on("selectionchange", () => {
    if (suppressSelectionInspect) return;
    const selection = figma.currentPage.selection;
    if (rootLocked && inspectedRootIds.length > 0) {
      postSelectionSync();
      return;
    }
    if (selection.length > 0 && inspectedRootIds.length > 0 && selection.every((n) => isUnderInspectedRoots(n))) {
      postSelectionSync();
      return;
    }
    void inspectSelection();
  });
})();
