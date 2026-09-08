// src/auto-layout.ts
import { BpmnModdle } from "bpmn-moddle";
var DEFAULT_OPTIONS = {
  colWidth: 150,
  spineY: 70,
  track1Y: 210,
  track2Y: 490,
  trackGap: 140,
  channel1Y: 140,
  channel2Y: 280,
  channel3Y: 560
};
function getElementDimensions(element) {
  const type = element.$type || "";
  if (type.endsWith("Event")) return { width: 36, height: 36 };
  if (type.endsWith("Gateway")) return { width: 50, height: 50 };
  if (type === "bpmn:SubProcess") return { width: 360, height: 200 };
  return { width: 100, height: 80 };
}
var COMPONENT_GAP = 100;
var LANDSCAPE_A4_RATIO = 297 / 210;
var ROUTE_BEND_PENALTY = 1e4;
var ROUTE_DEPARTURE_GAP = 40;
var CHANNEL_CLEARANCE = 40;
var LABEL_SLIDE_SLACK = 45;
var CHANNEL_LANE_GAP = 30;
function planChannels(nodes) {
  const tops = [];
  for (const n of nodes.values()) if (!n.isSubProcessChild) tops.push(n);
  const bandTop = tops.length ? Math.min(...tops.map((n) => n.y)) : 0;
  const bandBottom = tops.length ? Math.max(...tops.map((n) => n.y + n.height)) : 0;
  const laneY = (side, lane) => side === "below" ? bandBottom + CHANNEL_CLEARANCE + lane * CHANNEL_LANE_GAP : bandTop - CHANNEL_CLEARANCE - lane * CHANNEL_LANE_GAP;
  const requests = [];
  const recorder = {
    channelY(flowId, side, x1, x2) {
      requests.push({ flowId, side, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
      return laneY(side, 0);
    }
  };
  const resolve = () => {
    const assigned = /* @__PURE__ */ new Map();
    for (const side of ["below", "above"]) {
      const mine = requests.filter((r) => r.side === side).sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
      const lanes = [];
      for (const req of mine) {
        let lane = 0;
        while (lanes[lane]?.some((iv) => Math.min(iv.hi, req.hi) - Math.max(iv.lo, req.lo) > 0)) {
          lane += 1;
        }
        (lanes[lane] ??= []).push({ lo: req.lo, hi: req.hi });
        assigned.set(req.flowId, lane);
      }
    }
    return {
      channelY(flowId, side) {
        return laneY(side, assigned.get(flowId) ?? 0);
      }
    };
  };
  return { recorder, resolve };
}
function assertNoCrossProcessFlows(processes) {
  const containerOf = /* @__PURE__ */ new Map();
  const visit = (nodes, containerId) => {
    for (const node of nodes) {
      containerOf.set(node.id, containerId);
      if (node.flowElements) visit(node.flowElements, node.$type === "bpmn:SubProcess" ? node.id : containerId);
    }
  };
  for (const process of processes) {
    visit(process.flowElements || [], process.id);
  }
  for (const flow of processes.flatMap((process) => flattenFlowsOf(process.flowElements || []))) {
    const ownContainer = containerOf.get(flow.id);
    const srcContainer = flow.sourceRef && containerOf.get(flow.sourceRef.id);
    const tgtContainer = flow.targetRef && containerOf.get(flow.targetRef.id);
    if (srcContainer && srcContainer !== ownContainer) {
      throw new Error(
        `${flow.id} belongs to '${ownContainer}' but its source '${flow.sourceRef.id}' lives in '${srcContainer}' -- a sequence flow cannot cross between processes or subprocesses`
      );
    }
    if (tgtContainer && tgtContainer !== ownContainer) {
      throw new Error(
        `${flow.id} belongs to '${ownContainer}' but its target '${flow.targetRef.id}' lives in '${tgtContainer}' -- a sequence flow cannot cross between processes or subprocesses`
      );
    }
  }
}
function flattenFlowsOf(nodes) {
  return nodes.flatMap((node) => [
    ...node.$type === "bpmn:SequenceFlow" ? [node] : [],
    ...node.flowElements ? flattenFlowsOf(node.flowElements) : []
  ]);
}
function packIndependentComponents(nodes, topNodes, topFlows, mainNodeId) {
  if (topNodes.length < 2 || !mainNodeId) return;
  const parent = /* @__PURE__ */ new Map();
  for (const node of topNodes) parent.set(node.id, node.id);
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ar = find(a);
    const br = find(b);
    if (ar !== br) parent.set(br, ar);
  };
  for (const flow of topFlows) {
    const source = flow.sourceRef?.id;
    const target = flow.targetRef?.id;
    if (source && target && parent.has(source) && parent.has(target)) union(source, target);
  }
  const components = /* @__PURE__ */ new Map();
  for (const node of topNodes) {
    const key = find(node.id);
    (components.get(key) ?? components.set(key, []).get(key)).push(node);
  }
  const mainKey = find(mainNodeId);
  const secondary = [...components.entries()].filter(([key]) => key !== mainKey).map(([, members]) => members);
  if (secondary.length === 0) return;
  const idsFor = (members) => {
    const ids = /* @__PURE__ */ new Set();
    const visit = (element) => {
      if (element?.id) ids.add(element.id);
      for (const child of element?.flowElements || []) {
        if (child.$type !== "bpmn:SequenceFlow") visit(child);
      }
    };
    members.forEach(visit);
    return ids;
  };
  const boundsOf = (ids) => {
    const placed = [...nodes.values()].filter((node) => ids.has(node.id));
    return {
      minX: Math.min(...placed.map((node) => node.x)),
      minY: Math.min(...placed.map((node) => node.y)),
      maxX: Math.max(...placed.map((node) => node.x + node.width)),
      maxY: Math.max(...placed.map((node) => node.y + node.height))
    };
  };
  const mainBounds = boundsOf(idsFor(components.get(mainKey)));
  const secondaryData = secondary.map((members) => {
    const ids = idsFor(members);
    return { ids, bounds: boundsOf(ids) };
  });
  const totalSecondaryWidth = secondaryData.reduce((sum, item) => sum + item.bounds.maxX - item.bounds.minX, 0) + COMPONENT_GAP * Math.max(0, secondaryData.length - 1);
  const maxSecondaryWidth = Math.max(...secondaryData.map((item) => item.bounds.maxX - item.bounds.minX));
  const totalSecondaryHeight = secondaryData.reduce((sum, item) => sum + item.bounds.maxY - item.bounds.minY, 0) + COMPONENT_GAP * Math.max(0, secondaryData.length - 1);
  const sideWidth = mainBounds.maxX - mainBounds.minX + COMPONENT_GAP + maxSecondaryWidth;
  const sideHeight = Math.max(mainBounds.maxY - mainBounds.minY, totalSecondaryHeight);
  const belowWidth = Math.max(mainBounds.maxX - mainBounds.minX, totalSecondaryWidth);
  const belowHeight = mainBounds.maxY - mainBounds.minY + COMPONENT_GAP + Math.max(...secondaryData.map((item) => item.bounds.maxY - item.bounds.minY));
  const score = (width, height) => {
    const ratio = width / Math.max(1, height);
    return Math.abs(Math.log(ratio / LANDSCAPE_A4_RATIO)) + width * height / 1e9;
  };
  const below = belowWidth < sideWidth || score(belowWidth, belowHeight) <= score(sideWidth, sideHeight);
  if (below) {
    let x = mainBounds.minX;
    const y = mainBounds.maxY + COMPONENT_GAP;
    for (const item of secondaryData) {
      const width = item.bounds.maxX - item.bounds.minX;
      const height = item.bounds.maxY - item.bounds.minY;
      const dx = x - item.bounds.minX;
      const dy = y - item.bounds.minY;
      for (const node of nodes.values()) if (item.ids.has(node.id)) {
        node.x += dx;
        node.y += dy;
        node.centerX += dx;
        node.centerY += dy;
      }
      x += width + COMPONENT_GAP;
    }
  } else {
    const x = mainBounds.maxX + COMPONENT_GAP;
    let y = mainBounds.minY;
    for (const item of secondaryData) {
      const dx = x - item.bounds.minX;
      const dy = y - item.bounds.minY;
      for (const node of nodes.values()) if (item.ids.has(node.id)) {
        node.x += dx;
        node.y += dy;
        node.centerX += dx;
        node.centerY += dy;
      }
      y += item.bounds.maxY - item.bounds.minY + COMPONENT_GAP;
    }
  }
}
function snapNodesToGrid(nodes, colWidth) {
  for (const node of nodes.values()) {
    const snappedCenterX = 75 + Math.round((node.centerX - 75) / colWidth) * colWidth;
    const dx = snappedCenterX - node.centerX;
    if (Math.abs(dx) > 20) continue;
    node.x += dx;
    node.centerX += dx;
  }
}
async function layoutProcess(xml, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const root = rootElement;
  const processes = (root.rootElements || []).filter((el) => el.$type === "bpmn:Process");
  if (processes.length === 0) return xml;
  assertNoCrossProcessFlows(processes);
  root.diagrams = [];
  for (const process of processes) {
    const layout = computeProcessLayout(process, opts);
    createProcessDi(moddle, root, process, layout, opts);
  }
  const { xml: outputXml } = await moddle.toXML(rootElement, { format: true });
  return outputXml;
}
function computeProcessLayout(process, opts) {
  const allFlowElements = process.flowElements || [];
  const topNodes = allFlowElements.filter((el) => el.$type !== "bpmn:SequenceFlow");
  const topFlows = allFlowElements.filter((el) => el.$type === "bpmn:SequenceFlow");
  const nodesById = new Map(topNodes.map((n) => [n.id, n]));
  const incomingFlows = /* @__PURE__ */ new Map();
  const outgoingFlows = /* @__PURE__ */ new Map();
  for (const node of topNodes) {
    incomingFlows.set(node.id, []);
    outgoingFlows.set(node.id, []);
  }
  for (const flow of topFlows) {
    const src = flow.sourceRef?.id;
    const tgt = flow.targetRef?.id;
    if (src && nodesById.has(src)) outgoingFlows.get(src).push(flow);
    if (tgt && nodesById.has(tgt)) incomingFlows.get(tgt).push(flow);
  }
  const startEvent = topNodes.find((n) => n.$type === "bpmn:StartEvent") || topNodes[0];
  const visited = /* @__PURE__ */ new Set();
  const onStack = /* @__PURE__ */ new Set();
  const backEdges = /* @__PURE__ */ new Set();
  function dfsDetectBackEdges(nodeId) {
    visited.add(nodeId);
    onStack.add(nodeId);
    for (const flow of outgoingFlows.get(nodeId) || []) {
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;
      if (onStack.has(targetId)) {
        backEdges.add(flow.id);
      } else if (!visited.has(targetId)) {
        dfsDetectBackEdges(targetId);
      }
    }
    onStack.delete(nodeId);
  }
  if (startEvent) dfsDetectBackEdges(startEvent.id);
  function countActivitiesAlongPath(nodeId, seen) {
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const node = nodesById.get(nodeId);
    let count = 0;
    if (node && (node.$type.endsWith("Task") || node.$type === "bpmn:CallActivity" || node.$type === "bpmn:SubProcess")) {
      count = 1;
    }
    let maxSub = 0;
    for (const flow of outgoingFlows.get(nodeId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodesById.has(targetId)) {
        maxSub = Math.max(maxSub, countActivitiesAlongPath(targetId, new Set(seen)));
      }
    }
    return count + maxSub;
  }
  function flowSpineScore(flow, fromNodeId) {
    const targetId = flow.targetRef?.id;
    const targetNode = nodesById.get(targetId);
    if (!targetNode) return -100;
    if (targetNode.$type === "bpmn:SubProcess") return -50;
    if (flow.name === "no" || flow.name === "reject" || flow.name === "give up") return -50;
    if (flow.name?.toLowerCase().includes("error") || flow.name?.toLowerCase().includes("fail")) return -50;
    if (targetNode.$type.endsWith("EndEvent")) {
      return 100;
    }
    const hasBackEdge = (outgoingFlows.get(targetId) || []).some((f) => backEdges.has(f.id));
    if (hasBackEdge) {
      return 10;
    }
    return 50;
  }
  const spineNodeIds = [];
  const spineSet = /* @__PURE__ */ new Set();
  let curr = startEvent?.id;
  while (curr && !spineSet.has(curr)) {
    spineSet.add(curr);
    spineNodeIds.push(curr);
    const outs = (outgoingFlows.get(curr) || []).filter((f) => !backEdges.has(f.id));
    if (outs.length === 0) break;
    if (outs.length === 1) {
      curr = outs[0].targetRef?.id;
      continue;
    }
    const sortedOuts = [...outs].sort((a, b) => flowSpineScore(b, curr) - flowSpineScore(a, curr));
    const bestFlow = sortedOuts[0] || outs[0];
    curr = bestFlow.targetRef?.id;
  }
  const nodeTrack = /* @__PURE__ */ new Map();
  const nodeCol = /* @__PURE__ */ new Map();
  let col = 0;
  for (const id of spineNodeIds) {
    nodeTrack.set(id, 0);
    nodeCol.set(id, col);
    const node = nodesById.get(id);
    const dim = getElementDimensions(node);
    const span = Math.max(1, Math.ceil(dim.width / opts.colWidth));
    col += span;
  }
  const queue = [...spineNodeIds];
  while (queue.length > 0) {
    const parentId = queue.shift();
    const parentCol = nodeCol.get(parentId);
    const parentTrack = nodeTrack.get(parentId);
    const parentNode = nodesById.get(parentId);
    const parentDim = getElementDimensions(parentNode);
    const parentSpan = Math.max(1, Math.ceil(parentDim.width / opts.colWidth));
    for (const flow of outgoingFlows.get(parentId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;
      if (!nodeTrack.has(targetId)) {
        let targetTrack = parentTrack;
        const isExceptionBranch = /reject|invalid|error|fail/i.test(flow.name || "");
        if (spineSet.has(parentId) && !spineSet.has(targetId)) {
          const isSpannedByBackEdge = Array.from(backEdges).some((bId) => {
            const bFlow = topFlows.find((f) => f.id === bId);
            if (!bFlow) return false;
            const bSrcCol = nodeCol.get(bFlow.sourceRef?.id);
            const bTgtCol = nodeCol.get(bFlow.targetRef?.id);
            if (bSrcCol !== void 0 && bTgtCol !== void 0) {
              return bTgtCol <= parentCol && parentCol <= bSrcCol;
            }
            return false;
          });
          targetTrack = isExceptionBranch ? parentTrack - 1 : isSpannedByBackEdge ? -1 : parentTrack + 1;
        }
        nodeTrack.set(targetId, targetTrack);
        const targetCol = targetTrack > parentTrack && isExceptionBranch ? Math.max(0, parentCol - 1) : Math.max(parentCol + parentSpan, nodeCol.get(targetId) ?? 0);
        nodeCol.set(targetId, targetCol);
        queue.push(targetId);
      } else {
        const minCol = parentCol + parentSpan;
        if (nodeCol.get(targetId) < minCol) {
          shiftNodeAndDescendants(targetId, minCol);
        }
      }
    }
  }
  function shiftNodeAndDescendants(id, newCol) {
    const oldCol = nodeCol.get(id) || 0;
    if (newCol <= oldCol) return;
    nodeCol.set(id, newCol);
    const dim = getElementDimensions(nodesById.get(id));
    const span = Math.max(1, Math.ceil(dim.width / opts.colWidth));
    for (const flow of outgoingFlows.get(id) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodeCol.has(targetId)) {
        shiftNodeAndDescendants(targetId, newCol + span);
      }
    }
  }
  let maxCol = Math.max(0, ...Array.from(nodeCol.values()));
  for (const node of topNodes) {
    if (!nodeCol.has(node.id)) {
      maxCol += 1;
      nodeCol.set(node.id, maxCol);
      nodeTrack.set(node.id, 0);
    }
  }
  const tracksUsed = new Set(nodeTrack.values());
  for (const t of tracksUsed) {
    const nodesOnTrack = topNodes.filter((n) => nodeTrack.get(n.id) === t).sort((a, b) => nodeCol.get(a.id) - nodeCol.get(b.id));
    const colGap = 0.4;
    let lastRightEdge = -Infinity;
    for (const n of nodesOnTrack) {
      const dim = getElementDimensions(n);
      const halfSpan = dim.width / opts.colWidth / 2;
      let currentCol = nodeCol.get(n.id);
      if (currentCol - halfSpan < lastRightEdge + colGap) {
        const neededCol = Math.ceil(lastRightEdge + colGap + halfSpan);
        if (neededCol > currentCol) {
          shiftNodeAndDescendants(n.id, neededCol);
          currentCol = neededCol;
        }
      }
      lastRightEdge = currentCol + halfSpan;
    }
  }
  for (const endNode of topNodes.filter((n) => n.$type.endsWith("EndEvent"))) {
    const incoming = topFlows.find((flow) => flow.targetRef?.id === endNode.id);
    const source = incoming ? nodesById.get(incoming.sourceRef?.id) : void 0;
    if (!source) continue;
    const track = nodeTrack.get(endNode.id);
    if (track === void 0 || track <= 0 || track !== nodeTrack.get(source.id)) continue;
    const sourceCol = nodeCol.get(source.id);
    if (sourceCol === void 0) continue;
    const sourceSpan = getElementDimensions(source).width / opts.colWidth;
    let candidate = sourceCol + Math.max(1, sourceSpan);
    const endSpan = getElementDimensions(endNode).width / opts.colWidth;
    while (topNodes.some((node) => {
      if (node.id === endNode.id || nodeTrack.get(node.id) !== track) return false;
      const nodeColValue = nodeCol.get(node.id);
      if (nodeColValue === void 0) return false;
      const nodeSpan = getElementDimensions(node).width / opts.colWidth;
      return Math.abs(nodeColValue - candidate) < (nodeSpan + endSpan) / 2 + 0.4;
    })) {
      candidate += 1;
    }
    nodeCol.set(endNode.id, candidate);
  }
  const endEvents = topNodes.filter((n) => n.$type.endsWith("EndEvent"));
  if (endEvents.length > 1) {
    const maxEndCol = Math.max(...endEvents.map((n) => nodeCol.get(n.id) ?? 0));
    for (const endNode of endEvents) {
      const currentCol = nodeCol.get(endNode.id) ?? 0;
      if (currentCol < maxEndCol && maxEndCol - currentCol <= 2) {
        const track = nodeTrack.get(endNode.id) ?? 0;
        const hasObstacle = topNodes.some(
          (n) => n.id !== endNode.id && nodeTrack.get(n.id) === track && (nodeCol.get(n.id) ?? 0) >= currentCol && (nodeCol.get(n.id) ?? 0) <= maxEndCol
        );
        if (!hasObstacle) {
          nodeCol.set(endNode.id, maxEndCol);
        }
      }
    }
  }
  const layoutNodes = /* @__PURE__ */ new Map();
  const minTrack = Math.min(0, ...Array.from(nodeTrack.values()));
  const spineTrack = minTrack === -1 ? -1 : 0;
  function maxHeightOnTrack(trackVal) {
    let max = 80;
    for (const n of topNodes) {
      if (nodeTrack.get(n.id) === trackVal) max = Math.max(max, getElementDimensions(n).height);
    }
    return max;
  }
  const distinctTracks = Array.from(new Set(nodeTrack.values())).sort((a, b) => a - b);
  const extraClearanceForTrack = /* @__PURE__ */ new Map([[spineTrack, 0]]);
  let cumExtra = 0;
  let prevTrack = spineTrack;
  for (const trackVal of distinctTracks.filter((tv) => tv > spineTrack)) {
    cumExtra += Math.max(0, maxHeightOnTrack(prevTrack) - 80) / 2 + Math.max(0, maxHeightOnTrack(trackVal) - 80) / 2;
    extraClearanceForTrack.set(trackVal, cumExtra);
    prevTrack = trackVal;
  }
  for (const node of topNodes) {
    const c = nodeCol.get(node.id);
    const t = nodeTrack.get(node.id);
    const dim = getElementDimensions(node);
    const centerX = 75 + c * opts.colWidth;
    let centerY = opts.spineY;
    if (minTrack === -1) {
      if (t === -1) centerY = opts.spineY;
      else if (t === 0) centerY = opts.spineY + opts.trackGap;
      else if (t === 1) centerY = opts.spineY + 2 * opts.trackGap;
      else if (t > 1) centerY = opts.spineY + (t + 1) * opts.trackGap;
    } else {
      if (t === 1) centerY = opts.track1Y;
      else if (t === 2) centerY = opts.track2Y;
      else if (t > 2) centerY = opts.track2Y + (t - 2) * opts.trackGap;
    }
    centerY += extraClearanceForTrack.get(t) ?? 0;
    let x = centerX - dim.width / 2;
    let y = centerY - dim.height / 2;
    if (node.$type === "bpmn:SubProcess") {
      const childElements = node.flowElements || [];
      const childNodes = childElements.filter((el) => el.$type !== "bpmn:SequenceFlow");
      let childX = x + 35;
      for (const child of childNodes) {
        const cdim = getElementDimensions(child);
        const childY = centerY - cdim.height / 2;
        layoutNodes.set(child.id, {
          id: child.id,
          element: child,
          col: 0,
          track: t,
          x: childX,
          y: childY,
          width: cdim.width,
          height: cdim.height,
          centerX: childX + cdim.width / 2,
          centerY,
          isSubProcessChild: true
        });
        childX += cdim.width + 60;
      }
    }
    layoutNodes.set(node.id, {
      id: node.id,
      element: node,
      col: c,
      track: t,
      x,
      y,
      width: dim.width,
      height: dim.height,
      centerX,
      centerY
    });
  }
  packIndependentComponents(layoutNodes, topNodes, topFlows, startEvent?.id);
  snapNodesToGrid(layoutNodes, opts.colWidth);
  const allFlows = [...topFlows];
  for (const node of topNodes) {
    if (node.$type === "bpmn:SubProcess") {
      allFlows.push(...(node.flowElements || []).filter((el) => el.$type === "bpmn:SequenceFlow"));
    }
  }
  return { nodes: layoutNodes, allFlows };
}
function estimateTextLines(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;
  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (currentLineWidth === 0) {
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines += 1;
      currentLineWidth = wordWidth;
    }
  }
  return lines;
}
function formatTextForLines(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return text;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;
  const lines = [[]];
  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (lines[lines.length - 1].length === 0) {
      lines[lines.length - 1].push(word);
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      lines[lines.length - 1].push(word);
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines.push([word]);
      currentLineWidth = wordWidth;
    }
  }
  return lines.map((l) => l.join(" ")).join("\n");
}
function getCandidateWidthsForNode(name, isGateway) {
  const clean = name.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (!isGateway) {
    const initialLines = estimateTextLines(clean, 90);
    return initialLines >= 2 ? [90, 105, 120, 80] : [90];
  }
  if (words.length <= 1 || clean.length <= 9) {
    const tightW = Math.max(30, Math.round(clean.length * 6.8) + 8);
    return [tightW, 60, 80];
  }
  const twoLineWidths = [];
  for (let w = 40; w <= 140; w += 2) {
    const lines = estimateTextLines(clean, w);
    if (lines === 2) {
      twoLineWidths.push(w);
    }
  }
  if (twoLineWidths.length > 0) {
    const min2LineW = twoLineWidths[0];
    const median2LineW = twoLineWidths[Math.floor(twoLineWidths.length / 2)];
    const max2LineW = twoLineWidths[twoLineWidths.length - 1];
    return Array.from(/* @__PURE__ */ new Set([min2LineW, median2LineW, max2LineW, 70, 80]));
  }
  for (let w = 150; w <= 240; w += 10) {
    if (estimateTextLines(clean, w) <= 2) {
      return [w, w + 10];
    }
  }
  return [90, 105, 120];
}
function segmentIntersectsBox(x1, y1, x2, y2, bx, by, bw, bh, margin = 4) {
  const minX = bx - margin;
  const maxX = bx + bw + margin;
  const minY = by - margin;
  const maxY = by + bh + margin;
  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tEnter = 0;
  let tExit = 1;
  if (dx === 0) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }
  if (dy === 0) {
    if (y1 < minY || y1 > maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }
  return tEnter <= tExit;
}
function labelCollidesWithLanes(bounds, edgeWaypoints, margin = 4) {
  for (const pts of edgeWaypoints.values()) {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (p1 && p2 && segmentIntersectsBox(p1.x, p1.y, p2.x, p2.y, bounds.x, bounds.y, bounds.width, bounds.height, margin)) {
        return true;
      }
    }
  }
  return false;
}
function labelCollidesWithElements(bounds, targetId, nodes) {
  for (const node of nodes.values()) {
    if (node.id === targetId || node.isSubProcessChild) continue;
    if (node.element.$type === "bpmn:SubProcess") continue;
    if (bounds.x < node.x + node.width && node.x < bounds.x + bounds.width && bounds.y < node.y + node.height && node.y < bounds.y + bounds.height) {
      return true;
    }
  }
  return false;
}
function labelCollidesWithOtherLabels(bounds, placedLabels) {
  for (const other of placedLabels) {
    if (bounds.x < other.x + other.width && other.x < bounds.x + bounds.width && bounds.y < other.y + other.height && other.y < bounds.y + bounds.height) {
      return true;
    }
  }
  return false;
}
function solveLabelPlacement(node, edgeWaypoints, nodes, placedLabels) {
  const name = node.element.name || "";
  const isGateway = node.element.$type.endsWith("Gateway");
  let hasTopFlow = false;
  let hasBottomFlow = false;
  let hasLeftFlow = false;
  let hasRightFlow = false;
  for (const [flowId, pts] of edgeWaypoints.entries()) {
    if (!pts || pts.length === 0) continue;
    const flow = (node.element.incoming || []).concat(node.element.outgoing || []).find((f) => f.id === flowId);
    if (!flow) continue;
    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    if (flow.sourceRef?.id === node.id && startPt) {
      if (startPt.y < node.centerY - 5) hasTopFlow = true;
      else if (startPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (startPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (startPt.x > node.centerX + 5) hasRightFlow = true;
    }
    if (flow.targetRef?.id === node.id && endPt) {
      if (endPt.y < node.centerY - 5) hasTopFlow = true;
      else if (endPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (endPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (endPt.x > node.centerX + 5) hasRightFlow = true;
    }
  }
  let preferredTop = false;
  if (isGateway) {
    if (hasBottomFlow && !hasTopFlow) preferredTop = true;
  }
  const initialLines = estimateTextLines(name, 90);
  const isFourDirectionGateway = isGateway && hasTopFlow && hasBottomFlow && hasLeftFlow && hasRightFlow;
  const isLeftFreeGateway = isGateway && hasTopFlow && hasBottomFlow && !hasLeftFlow;
  const isRightFreeGateway = isGateway && hasTopFlow && hasBottomFlow && !hasRightFlow;
  const candidateWidths = getCandidateWidthsForNode(name, isGateway);
  const candidates = [];
  for (const W of candidateWidths) {
    const formatted = formatTextForLines(name, W);
    const lineArray = formatted.split("\n");
    const lines = lineArray.length;
    let maxLineChars = 0;
    for (const l of lineArray) {
      if (l.length > maxLineChars) maxLineChars = l.length;
    }
    const tightW = isGateway ? Math.max(30, Math.min(W, Math.round(maxLineChars * 6.8) + 8)) : W;
    const H = lines === 1 ? isGateway ? 14 : 20 : lines === 2 ? 27 : lines * 14;
    const gap = isGateway ? 0 : 8;
    const snugOffset = isGateway ? 0 : 2;
    const primaryY = preferredTop ? Math.round(node.y - H - gap) : Math.round(node.y + node.height + gap);
    const altY = preferredTop ? Math.round(node.y + node.height + gap) : Math.round(node.y - H - gap);
    if (isFourDirectionGateway) {
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines });
    } else if (isLeftFreeGateway) {
      candidates.push({ x: Math.round(node.x - tightW - 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines });
    } else if (isRightFreeGateway) {
      candidates.push({ x: Math.round(node.x + node.width + 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines });
    } else {
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: primaryY, width: tightW, height: H, lines });
      for (const dx of [20, -20, 40, -40, 60, -60]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: primaryY, width: tightW, height: H, lines });
      }
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: altY, width: tightW, height: H, lines });
      for (const dx of [20, -20, 40, -40]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: altY, width: tightW, height: H, lines });
      }
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.x - tightW - 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.x + node.width + 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
    }
  }
  let chosen = null;
  for (const cand of candidates) {
    if (cand.x < 10 || cand.y < 0) continue;
    if (labelCollidesWithLanes(cand, edgeWaypoints)) continue;
    if (labelCollidesWithElements(cand, node.id, nodes)) continue;
    if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
    chosen = cand;
    break;
  }
  if (!chosen) {
    for (const cand of candidates) {
      if (cand.x < 10 || cand.y < 0) continue;
      if (labelCollidesWithElements(cand, node.id, nodes)) continue;
      if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
      chosen = cand;
      break;
    }
  }
  if (!chosen) {
    const defaultW = 90;
    const defaultLines = estimateTextLines(name, defaultW);
    const defaultH = defaultLines === 1 ? isGateway ? 14 : 20 : defaultLines === 2 ? 27 : defaultLines * 14;
    const defaultGap = isGateway ? 0 : 8;
    const defaultY = preferredTop ? Math.round(node.y - defaultH - defaultGap) : Math.round(node.y + node.height + defaultGap);
    chosen = {
      x: Math.round(node.centerX - defaultW / 2),
      y: defaultY,
      width: defaultW,
      height: defaultH,
      lines: defaultLines
    };
  }
  return {
    x: chosen.x,
    y: chosen.y,
    width: chosen.width,
    height: chosen.height
  };
}
function shouldUseUpsideRoute(src, tgt, layout, flowId) {
  if (!src.element.$type.endsWith("Gateway") || !tgt.element.$type.endsWith("Gateway")) {
    return false;
  }
  if (src.track !== tgt.track) {
    return false;
  }
  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));
  const minCol = Math.min(src.col, tgt.col);
  const maxCol = Math.max(src.col, tgt.col);
  if (minTrack < 0) {
    const hasUpperObstacle = Array.from(layout.nodes.values()).some(
      (n) => n.track < 0 && n.col >= minCol && n.col <= maxCol
    );
    if (hasUpperObstacle) return false;
  }
  const intermediateNodes = Array.from(layout.nodes.values()).filter(
    (n) => n.id !== src.id && n.id !== tgt.id && n.track === src.track && n.col > minCol && n.col < maxCol
  );
  if (intermediateNodes.length === 0) {
    return false;
  }
  const otherIncomingSameTrack = layout.allFlows.filter((f) => {
    if (f.id === flowId || f.targetRef?.id !== tgt.id) return false;
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    return fSrc && fSrc.track === tgt.track && fSrc.id !== src.id;
  });
  const currentSpan = Math.abs(src.col - tgt.col);
  const isLongerThanOtherBypasses = otherIncomingSameTrack.every((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    const otherSpan = Math.abs(fSrc.col - tgt.col);
    return currentSpan > otherSpan;
  });
  if (!isLongerThanOtherBypasses) {
    return false;
  }
  if (tgt.col <= src.col) {
    const hasForwardBypass = layout.allFlows.some((f) => {
      if (f.id === flowId || f.sourceRef?.id !== src.id) return false;
      const fTgt = layout.nodes.get(f.targetRef?.id);
      return fTgt && fTgt.track === src.track && fTgt.col > src.col + 1;
    });
    if (hasForwardBypass) return false;
  }
  const otherOutgoing = layout.allFlows.filter((f) => f.id !== flowId && f.sourceRef?.id === src.id);
  const srcHasBottomOutgoing = otherOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= src.col || fTgt.track > src.track;
  });
  const otherIncoming = layout.allFlows.filter((f) => f.id !== flowId && f.targetRef?.id === tgt.id);
  const tgtHasBottomIncoming = otherIncoming.some((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    if (!fSrc) return false;
    return tgt.col <= fSrc.col || fSrc.track > tgt.track;
  });
  const tgtOutgoing = layout.allFlows.filter((f) => f.sourceRef?.id === tgt.id);
  const tgtHasBottomOutgoing = tgtOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= tgt.col || fTgt.track > tgt.track;
  });
  if (srcHasBottomOutgoing || tgtHasBottomIncoming || tgtHasBottomOutgoing || otherIncoming.length > 0) {
    return true;
  }
  return false;
}
function pickLabel(candidates, fallback, flow, placedLabels, nodes, edgeWaypoints = /* @__PURE__ */ new Map()) {
  const crossedByEdge = (bounds) => {
    let crossings = 0;
    for (const [flowId, pts] of edgeWaypoints) {
      if (flowId === flow?.id) continue;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i];
        const b = pts[i + 1];
        if (Math.abs(a.y - b.y) < 0.5) {
          if (a.y <= bounds.y || a.y >= bounds.y + bounds.height) continue;
          if (Math.max(Math.min(a.x, b.x), bounds.x) < Math.min(Math.max(a.x, b.x), bounds.x + bounds.width)) {
            crossings += 1;
          }
        } else if (Math.abs(a.x - b.x) < 0.5) {
          if (a.x <= bounds.x || a.x >= bounds.x + bounds.width) continue;
          if (Math.max(Math.min(a.y, b.y), bounds.y) < Math.min(Math.max(a.y, b.y), bounds.y + bounds.height)) {
            crossings += 1;
          }
        }
      }
    }
    return crossings;
  };
  const overlapArea = (bounds) => {
    let area = 0;
    for (const node of nodes.values()) {
      if (node.isSubProcessChild || node.element?.$type === "bpmn:SubProcess") continue;
      const overlap = boxOverlap(bounds, node);
      const isOwnEndpoint = node.id === flow?.sourceRef?.id || node.id === flow?.targetRef?.id;
      const rendersNameOutside = node.element?.$type?.endsWith("Event") || node.element?.$type?.endsWith("Gateway");
      if (isOwnEndpoint && rendersNameOutside && overlap < 100) {
        area += 0.1 * overlap;
        continue;
      }
      area += overlap;
      continue;
    }
    for (const other of placedLabels) area += boxOverlap(bounds, other);
    return area + crossedByEdge(bounds) * 120;
  };
  let best = fallback;
  let bestArea = overlapArea(fallback);
  for (const cand of candidates) {
    if (cand.x < 0 || cand.y < 0) continue;
    const area = overlapArea(cand);
    if (area === 0) return cand;
    if (area < bestArea) {
      best = cand;
      bestArea = area;
    }
  }
  return best;
}
function boxOverlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
function computeEdgeLabelBounds(flow, waypoints, edgeWaypoints, placedLabels = [], nodes = /* @__PURE__ */ new Map()) {
  if (!flow.name || typeof flow.name !== "string" || flow.name.trim().length === 0) {
    return null;
  }
  const text = flow.name.trim();
  let bestSeg = null;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    if (!p1 || !p2) continue;
    const isHoriz = p1.y === p2.y;
    const isVert = p1.x === p2.x;
    const len = isHoriz ? Math.abs(p2.x - p1.x) : isVert ? Math.abs(p2.y - p1.y) : 0;
    if (isHoriz && len >= 30) {
      if (!bestSeg || !bestSeg.isHoriz || len > bestSeg.len) {
        bestSeg = { p1, p2, isHoriz: true, len };
      }
    } else if (!bestSeg && len >= 20) {
      bestSeg = { p1, p2, isHoriz: false, len };
    }
  }
  if (!bestSeg) return null;
  const width = Math.min(90, Math.max(30, Math.round(text.length * 6.5) + 10));
  const height = 14;
  if (bestSeg.isHoriz) {
    const minX = Math.min(bestSeg.p1.x, bestSeg.p2.x);
    const maxX = Math.max(bestSeg.p1.x, bestSeg.p2.x);
    const midX = (minX + maxX) / 2;
    const hasFlowAbove = bestSeg.p1.y <= 0 || Array.from(edgeWaypoints.values()).some((pts) => {
      for (let j = 0; j < pts.length - 1; j++) {
        const q1 = pts[j];
        const q2 = pts[j + 1];
        if (!q1 || !q2) continue;
        if (q1.y === q2.y && q1.y < bestSeg.p1.y && bestSeg.p1.y - q1.y <= 40) {
          const qMinX = Math.min(q1.x, q2.x);
          const qMaxX = Math.max(q1.x, q2.x);
          if (Math.max(minX, qMinX) < Math.min(maxX, qMaxX)) return true;
        }
      }
      return false;
    });
    const primaryY = hasFlowAbove ? Math.round(bestSeg.p1.y + 4) : Math.round(bestSeg.p1.y - height - 2);
    const altY = hasFlowAbove ? Math.round(bestSeg.p1.y - height - 2) : Math.round(bestSeg.p1.y + 4);
    const centeredX = Math.round(midX - width / 2);
    const straddled = Array.from(nodes.values()).filter(
      (n) => !n.isSubProcessChild && n.element?.$type !== "bpmn:SubProcess" && // The label is centred on the segment and wider than a short stub, so
      // the elements it can foul are the ones at either end too, not only
      // those strictly inside the segment's own span.
      n.x <= maxX + width / 2 && minX - width / 2 <= n.x + n.width && n.y < bestSeg.p1.y + height && bestSeg.p1.y - height < n.y + n.height
    );
    const clearAbove = straddled.length ? Math.min(...straddled.map((n) => n.y)) - height - 4 : primaryY;
    const clearBelow = straddled.length ? Math.max(...straddled.map((n) => n.y + n.height)) + 4 : altY;
    const candidates = [];
    for (const y of [primaryY, altY, clearAbove, clearBelow]) {
      for (const dx of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
        const x = centeredX + dx;
        if (x + width / 2 < minX - LABEL_SLIDE_SLACK || x + width / 2 > maxX + LABEL_SLIDE_SLACK) continue;
        candidates.push({ x, y, width, height });
      }
    }
    return pickLabel(candidates, { x: centeredX, y: primaryY, width, height }, flow, placedLabels, nodes, edgeWaypoints);
  } else {
    const minY = Math.min(bestSeg.p1.y, bestSeg.p2.y);
    const maxY = Math.max(bestSeg.p1.y, bestSeg.p2.y);
    const midY = (minY + maxY) / 2;
    const y = Math.round(midY - height / 2);
    const rightX = Math.round(bestSeg.p1.x + 4);
    const leftX = Math.round(bestSeg.p1.x - width - 4);
    const candidates = [];
    for (const dy of [0, -18, 18, -36, 36]) {
      candidates.push({ x: rightX, y: y + dy, width, height });
      candidates.push({ x: leftX, y: y + dy, width, height });
    }
    return pickLabel(candidates, { x: rightX, y, width, height }, flow, placedLabels, nodes, edgeWaypoints);
  }
}
function fanOutAttachPoints(edgeWaypoints, layout) {
  const bySide = /* @__PURE__ */ new Map();
  for (const flow of layout.allFlows) {
    const pts = edgeWaypoints.get(flow.id);
    if (!pts || pts.length < 2) continue;
    for (const [index, nodeId] of [
      [0, flow.sourceRef?.id],
      [pts.length - 1, flow.targetRef?.id]
    ]) {
      const node = layout.nodes.get(nodeId);
      const p = pts[index];
      if (!node || !p) continue;
      let side = null;
      if (Math.abs(p.y - node.y) < 0.5) side = "top";
      else if (Math.abs(p.y - (node.y + node.height)) < 0.5) side = "bottom";
      else if (Math.abs(p.x - node.x) < 0.5) side = "left";
      else if (Math.abs(p.x - (node.x + node.width)) < 0.5) side = "right";
      if (!side) continue;
      const key = `${nodeId}:${side}`;
      (bySide.get(key) ?? bySide.set(key, []).get(key)).push({ flowId: flow.id, index });
    }
  }
  for (const [key, attaches] of bySide) {
    if (attaches.length < 2) continue;
    const [nodeId, side] = key.split(":");
    const node = layout.nodes.get(nodeId);
    if (!node) continue;
    const horizontalSide = side === "top" || side === "bottom";
    const extent = horizontalSide ? node.width : node.height;
    const step = extent / 2 / (attaches.length + 1);
    const start = (horizontalSide ? node.x : node.y) + extent / 4 + step;
    attaches.sort((a, b) => a.flowId.localeCompare(b.flowId));
    attaches.forEach((attach, i) => {
      const pts = edgeWaypoints.get(attach.flowId);
      const coord = start + i * step;
      const neighbour = attach.index === 0 ? pts[1] : pts[pts.length - 2];
      const point = pts[attach.index];
      if (horizontalSide) {
        if (neighbour && Math.abs(neighbour.x - point.x) < 0.5) neighbour.x = coord;
        point.x = coord;
      } else {
        if (neighbour && Math.abs(neighbour.y - point.y) < 0.5) neighbour.y = coord;
        point.y = coord;
      }
    });
  }
}
function createProcessDi(moddle, rootElement, process, layout, opts) {
  const planeElements = [];
  const edgeWaypoints = /* @__PURE__ */ new Map();
  const { recorder, resolve } = planChannels(layout.nodes);
  for (const pass of [recorder, null]) {
    layout.channels = pass ?? resolve();
    edgeWaypoints.clear();
    for (const flow of layout.allFlows) {
      const src = layout.nodes.get(flow.sourceRef?.id);
      const tgt = layout.nodes.get(flow.targetRef?.id);
      if (!src || !tgt) continue;
      edgeWaypoints.set(flow.id, repairSegmentCollisions(computeWaypoints(src, tgt, layout, opts, flow), layout, flow));
    }
  }
  fanOutAttachPoints(edgeWaypoints, layout);
  for (const flow of layout.allFlows) {
    const existing = edgeWaypoints.get(flow.id);
    if (!existing) continue;
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    const isLowerMerge = src && tgt && src.track > tgt.track && tgt.element?.$type?.endsWith("Gateway") && !src.element?.$type?.endsWith("Gateway");
    if (isLowerMerge) {
      edgeWaypoints.set(flow.id, computeWaypoints(src, tgt, layout, opts, flow));
      continue;
    }
    edgeWaypoints.set(flow.id, repairSegmentCollisions(existing, layout, flow, edgeWaypoints));
  }
  const placedLabels = [];
  const edgeLabelBounds = /* @__PURE__ */ new Map();
  for (const flow of layout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const edgeLabel = computeEdgeLabelBounds(flow, waypoints, edgeWaypoints, placedLabels, layout.nodes);
    if (edgeLabel) {
      edgeLabelBounds.set(flow.id, edgeLabel);
      placedLabels.push(edgeLabel);
    }
  }
  for (const [id, node] of layout.nodes.entries()) {
    const isMarkerVisible = node.element.$type.endsWith("Gateway") ? true : void 0;
    const isExpanded = node.element.$type === "bpmn:SubProcess" ? true : void 0;
    const shapeAttrs = {
      id: `${id}_di`,
      bpmnElement: node.element,
      bounds: moddle.create("dc:Bounds", {
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: Math.round(node.width),
        height: Math.round(node.height)
      })
    };
    if (isMarkerVisible !== void 0) shapeAttrs.isMarkerVisible = isMarkerVisible;
    if (isExpanded !== void 0) shapeAttrs.isExpanded = isExpanded;
    const hasName = typeof node.element.name === "string" && node.element.name.trim().length > 0;
    const needsLabel = (node.element.$type.endsWith("Event") || node.element.$type.endsWith("Gateway")) && hasName;
    if (needsLabel) {
      const labelBounds = solveLabelPlacement(node, edgeWaypoints, layout.nodes, placedLabels);
      placedLabels.push(labelBounds);
      shapeAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: labelBounds.x,
          y: labelBounds.y,
          width: labelBounds.width,
          height: labelBounds.height
        })
      });
    }
    planeElements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
  }
  for (const flow of layout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const edgeDiAttrs = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      waypoint: waypoints.map(
        (pt) => moddle.create("dc:Point", {
          x: Math.round(pt.x),
          y: Math.round(pt.y)
        })
      )
    };
    const edgeLabel = edgeLabelBounds.get(flow.id);
    if (edgeLabel) {
      edgeDiAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: edgeLabel.x,
          y: edgeLabel.y,
          width: edgeLabel.width,
          height: edgeLabel.height
        })
      });
    }
    const edgeDi = moddle.create("bpmndi:BPMNEdge", edgeDiAttrs);
    planeElements.push(edgeDi);
  }
  const plane = moddle.create("bpmndi:BPMNPlane", {
    id: `BPMNPlane_${process.id}`,
    bpmnElement: process,
    planeElement: planeElements
  });
  const diagram = moddle.create("bpmndi:BPMNDiagram", {
    id: `BPMNDiagram_${process.id}`,
    plane
  });
  rootElement.diagrams.push(diagram);
}
function leavesOutward(pts, srcNode, tgtNode) {
  const ok = (attach, next, node) => {
    if (!node) return true;
    if (Math.abs(attach.y - node.y) < 0.5) return Math.abs(next.x - attach.x) < 0.5 && next.y <= attach.y + 0.5;
    if (Math.abs(attach.y - (node.y + node.height)) < 0.5) return Math.abs(next.x - attach.x) < 0.5 && next.y >= attach.y - 0.5;
    if (Math.abs(attach.x - node.x) < 0.5) return Math.abs(next.y - attach.y) < 0.5 && next.x <= attach.x + 0.5;
    if (Math.abs(attach.x - (node.x + node.width)) < 0.5) return Math.abs(next.y - attach.y) < 0.5 && next.x >= attach.x - 0.5;
    return true;
  };
  return ok(pts[0], pts[1], srcNode) && ok(pts[pts.length - 1], pts[pts.length - 2], tgtNode);
}
function normalizeCardinalDeparture(pts, node) {
  if (!node || pts.length < 2) return pts;
  const attach = pts[0];
  const next = pts[1];
  if (leavesOutward([attach, next], node, void 0)) return pts;
  let departure;
  let bridge;
  if (Math.abs(attach.y - node.y) < 0.5) {
    departure = { x: attach.x, y: attach.y - ROUTE_DEPARTURE_GAP };
    bridge = { x: next.x, y: departure.y };
  } else if (Math.abs(attach.y - (node.y + node.height)) < 0.5) {
    departure = { x: attach.x, y: attach.y + ROUTE_DEPARTURE_GAP };
    bridge = { x: next.x, y: departure.y };
  } else if (Math.abs(attach.x - node.x) < 0.5) {
    departure = { x: attach.x - ROUTE_DEPARTURE_GAP, y: attach.y };
    bridge = { x: departure.x, y: next.y };
  } else if (Math.abs(attach.x - (node.x + node.width)) < 0.5) {
    departure = { x: attach.x + ROUTE_DEPARTURE_GAP, y: attach.y };
    bridge = { x: departure.x, y: next.y };
  } else {
    return pts;
  }
  return [attach, departure, bridge, ...pts.slice(2)];
}
function repairSegmentCollisions(waypoints, layout, flow, blockedPaths = /* @__PURE__ */ new Map()) {
  if (waypoints.length < 2) return waypoints;
  const endpoints = /* @__PURE__ */ new Set([flow?.sourceRef?.id, flow?.targetRef?.id]);
  const internalSubProcessFlow = layout.nodes.get(flow?.sourceRef?.id)?.isSubProcessChild && layout.nodes.get(flow?.targetRef?.id)?.isSubProcessChild;
  const obstacles = Array.from(layout.nodes.values()).filter(
    (n) => !endpoints.has(n.id) && (internalSubProcessFlow || n.element?.$type !== "bpmn:SubProcess")
  );
  obstacles.push(...pathObstacles(blockedPaths, flow?.id));
  const hits = (pts) => {
    let n = 0;
    for (let i = 0; i < pts.length - 1; i += 1) n += segmentHitCount(pts[i], pts[i + 1], obstacles);
    return n;
  };
  let best = normalizeCardinalDeparture(waypoints, layout.nodes.get(flow?.sourceRef?.id));
  let bestHits = hits(best);
  const srcNode = layout.nodes.get(flow?.sourceRef?.id);
  const tgtNode = layout.nodes.get(flow?.targetRef?.id);
  if (bestHits === 0 && leavesOutward(best, srcNode, tgtNode)) return best;
  const targetPoints = tgtNode ? [
    best[best.length - 1],
    { x: tgtNode.centerX, y: tgtNode.y },
    { x: tgtNode.centerX, y: tgtNode.y + tgtNode.height },
    { x: tgtNode.x, y: tgtNode.centerY },
    { x: tgtNode.x + tgtNode.width, y: tgtNode.centerY }
  ] : [best[best.length - 1]];
  let visibilityRoute = null;
  let visibilityQuality = null;
  for (const targetPoint of targetPoints) {
    const routeInput = [...best.slice(0, -1), targetPoint];
    const candidate = findRectilinearRoute(routeInput, obstacles, srcNode, tgtNode);
    if (!candidate || hits(candidate) > 0 || !leavesOutward(candidate, srcNode, tgtNode)) continue;
    let bends = 0;
    for (let i = 1; i < candidate.length - 1; i += 1) {
      const previous = candidate[i - 1];
      const current = candidate[i];
      const next = candidate[i + 1];
      if (previous.x === current.x !== (current.x === next.x)) bends += 1;
    }
    const length = candidate.slice(0, -1).reduce((sum, point, index) => sum + Math.abs(point.x - candidate[index + 1].x) + Math.abs(point.y - candidate[index + 1].y), 0);
    const quality = [bends, length];
    if (!visibilityQuality || quality[0] < visibilityQuality[0] || quality[0] === visibilityQuality[0] && quality[1] < visibilityQuality[1]) {
      visibilityRoute = candidate;
      visibilityQuality = quality;
    }
  }
  if (visibilityRoute) return visibilityRoute;
  if (bestHits === 0) return best;
  const staysOnNode = (idx, moved) => {
    const node = idx === 0 ? srcNode : idx === best.length - 1 ? tgtNode : void 0;
    if (!node) return true;
    return moved.x >= node.x && moved.x <= node.x + node.width && moved.y >= node.y && moved.y <= node.y + node.height;
  };
  for (let i = 0; i < best.length - 1 && bestHits > 0; i += 1) {
    const a = best[i];
    const b = best[i + 1];
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    if (!vertical && !horizontal) continue;
    for (const delta of SEGMENT_NUDGES) {
      const candidate = best.map(
        (p, idx) => idx === i || idx === i + 1 ? vertical ? { x: p.x + delta, y: p.y } : { x: p.x, y: p.y + delta } : { ...p }
      );
      if (!staysOnNode(i, candidate[i]) || !staysOnNode(i + 1, candidate[i + 1])) continue;
      if (!leavesOutward(candidate, srcNode, tgtNode)) continue;
      const candidateHits = hits(candidate);
      if (candidateHits < bestHits) {
        best = candidate;
        bestHits = candidateHits;
        if (bestHits === 0) break;
      }
    }
  }
  if (bestHits > 0 && tgtNode) {
    const siblings = layout.allFlows.filter((f) => f.targetRef?.id === tgtNode.id);
    const rank = Math.max(0, siblings.findIndex((f) => f.id === flow?.id));
    const detour = approachFromSide(best, tgtNode, obstacles, rank * CHANNEL_LANE_GAP);
    if (detour && hits(detour) === 0) return detour;
  }
  return best;
}
function approachFromSide(pts, tgt, obstacles, stagger = 0) {
  if (pts.length < 3) return null;
  const pen = pts[pts.length - 2];
  const end = pts[pts.length - 1];
  if (Math.abs(pen.x - end.x) > 0.5) return null;
  const blocking = obstacles.filter(
    (o) => pen.x > o.x - SEGMENT_CLEARANCE && pen.x < o.x + o.width + SEGMENT_CLEARANCE && Math.max(Math.min(pen.y, end.y), o.y - SEGMENT_CLEARANCE) < Math.min(Math.max(pen.y, end.y), o.y + o.height + SEGMENT_CLEARANCE)
  );
  if (blocking.length === 0) return null;
  for (const dir of [1, -1]) {
    const bypassX = dir === 1 ? Math.max(...blocking.map((o) => o.x + o.width)) + CHANNEL_CLEARANCE + stagger : Math.min(...blocking.map((o) => o.x)) - CHANNEL_CLEARANCE - stagger;
    const entryX = dir === 1 ? tgt.x + tgt.width : tgt.x;
    const candidate = [
      ...pts.slice(0, pts.length - 2).map((p) => ({ ...p })),
      { x: bypassX, y: pen.y },
      { x: bypassX, y: tgt.centerY },
      { x: entryX, y: tgt.centerY }
    ];
    const before = candidate[candidate.length - 4];
    if (before && Math.abs(before.y - pen.y) > 0.5) return null;
    return candidate;
  }
  return null;
}
var SEGMENT_NUDGES = (() => {
  const out = [];
  for (let d = 15; d <= 300; d += 15) out.push(d, -d);
  return out;
})();
var SEGMENT_CLEARANCE = 8;
function segmentHitCount(p, q, obstacles) {
  let n = 0;
  for (const o of obstacles) {
    const x0 = o.x - SEGMENT_CLEARANCE;
    const y0 = o.y - SEGMENT_CLEARANCE;
    const x1 = o.x + o.width + SEGMENT_CLEARANCE;
    const y1 = o.y + o.height + SEGMENT_CLEARANCE;
    if (Math.abs(p.y - q.y) < 0.5) {
      if (p.y <= y0 || p.y >= y1) continue;
      if (Math.max(Math.min(p.x, q.x), x0) < Math.min(Math.max(p.x, q.x), x1)) n += 1;
    } else if (Math.abs(p.x - q.x) < 0.5) {
      if (p.x <= x0 || p.x >= x1) continue;
      if (Math.max(Math.min(p.y, q.y), y0) < Math.min(Math.max(p.y, q.y), y1)) n += 1;
    }
  }
  return n;
}
function pathObstacles(paths, excludedFlowId) {
  const obstacles = [];
  for (const [flowId, points] of paths) {
    if (flowId === excludedFlowId) continue;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (length <= ROUTE_DEPARTURE_GAP) continue;
      const trim = Math.min(ROUTE_DEPARTURE_GAP / 2, length / 3);
      const horizontal = Math.abs(a.y - b.y) < 0.5;
      const x = horizontal ? Math.min(a.x, b.x) + trim : a.x - SEGMENT_CLEARANCE / 2;
      const y = horizontal ? a.y - SEGMENT_CLEARANCE / 2 : Math.min(a.y, b.y) + trim;
      const width = horizontal ? length - trim * 2 : SEGMENT_CLEARANCE;
      const height = horizontal ? SEGMENT_CLEARANCE : length - trim * 2;
      obstacles.push({
        id: `${flowId}:${i}`,
        element: { $type: "bpmn:RouteObstacle" },
        col: 0,
        track: 0,
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
        centerY: y + height / 2
      });
    }
  }
  return obstacles;
}
function findRectilinearRoute(original, obstacles, srcNode, tgtNode) {
  const start = original[0];
  const end = original[original.length - 1];
  if (!start || !end || obstacles.length === 0) return null;
  const xs = new Set(original.map((point) => point.x));
  const ys = new Set(original.map((point) => point.y));
  xs.add(start.x - ROUTE_DEPARTURE_GAP);
  xs.add(start.x + ROUTE_DEPARTURE_GAP);
  ys.add(start.y - ROUTE_DEPARTURE_GAP);
  ys.add(start.y + ROUTE_DEPARTURE_GAP);
  for (const obstacle of obstacles) {
    xs.add(obstacle.x - SEGMENT_CLEARANCE);
    xs.add(obstacle.x + obstacle.width + SEGMENT_CLEARANCE);
    ys.add(obstacle.y - SEGMENT_CLEARANCE);
    ys.add(obstacle.y + obstacle.height + SEGMENT_CLEARANCE);
  }
  const points = [];
  const pointIndex = /* @__PURE__ */ new Map();
  const keyOf = (x, y) => `${x}:${y}`;
  const clearPoint = (x, y) => obstacles.every(
    (obstacle) => x <= obstacle.x - SEGMENT_CLEARANCE || x >= obstacle.x + obstacle.width + SEGMENT_CLEARANCE || y <= obstacle.y - SEGMENT_CLEARANCE || y >= obstacle.y + obstacle.height + SEGMENT_CLEARANCE
  );
  for (const x of xs) {
    for (const y of ys) {
      if (!clearPoint(x, y) && !(x === start.x && y === start.y) && !(x === end.x && y === end.y)) continue;
      const index = points.length;
      points.push({ x, y });
      pointIndex.set(keyOf(x, y), index);
    }
  }
  const edges = /* @__PURE__ */ new Map();
  const addVisiblePair = (a, b) => {
    const first = points[a];
    const second = points[b];
    if (segmentHitCount(first, second, obstacles) > 0) return;
    const direction = Math.abs(first.y - second.y) < 0.5 ? 1 : 2;
    const distance = Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    (edges.get(a) ?? edges.set(a, []).get(a)).push({ to: b, distance, direction });
    (edges.get(b) ?? edges.set(b, []).get(b)).push({ to: a, distance, direction });
  };
  for (const x of xs) {
    const row = points.map((point, index) => ({ point, index })).filter(({ point }) => Math.abs(point.x - x) < 0.5).sort((a, b) => a.point.y - b.point.y);
    for (let i = 0; i + 1 < row.length; i += 1) addVisiblePair(row[i].index, row[i + 1].index);
  }
  for (const y of ys) {
    const column = points.map((point, index) => ({ point, index })).filter(({ point }) => Math.abs(point.y - y) < 0.5).sort((a, b) => a.point.x - b.point.x);
    for (let i = 0; i + 1 < column.length; i += 1) addVisiblePair(column[i].index, column[i + 1].index);
  }
  const startIndex = pointIndex.get(keyOf(start.x, start.y));
  const endIndex = pointIndex.get(keyOf(end.x, end.y));
  if (startIndex === void 0 || endIndex === void 0) return null;
  const stateKey = (state) => `${state.point}:${state.direction}`;
  const initial = { point: startIndex, direction: 0 };
  const distances = /* @__PURE__ */ new Map([[stateKey(initial), 0]]);
  const previous = /* @__PURE__ */ new Map();
  const pending = [initial];
  while (pending.length > 0) {
    let bestPending = 0;
    for (let i = 1; i < pending.length; i += 1) {
      if ((distances.get(stateKey(pending[i])) ?? Infinity) < (distances.get(stateKey(pending[bestPending])) ?? Infinity)) bestPending = i;
    }
    const current = pending.splice(bestPending, 1)[0];
    const currentKey = stateKey(current);
    const currentDistance = distances.get(currentKey);
    for (const edge of edges.get(current.point) || []) {
      const nextPoint = points[edge.to];
      if (current.point === startIndex) {
        if (!leavesOutward([start, nextPoint], srcNode, void 0) || edge.distance < ROUTE_DEPARTURE_GAP) continue;
      }
      const turnPenalty = current.direction !== 0 && current.direction !== edge.direction ? ROUTE_BEND_PENALTY : 0;
      const next = { point: edge.to, direction: edge.direction };
      const nextKey = stateKey(next);
      const distance = currentDistance + edge.distance + turnPenalty;
      if (distance >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, distance);
      previous.set(nextKey, currentKey);
      pending.push(next);
    }
  }
  const endStates = [...distances.keys()].filter((key) => key.startsWith(`${endIndex}:`));
  endStates.sort((a, b) => distances.get(a) - distances.get(b));
  for (const endStateKey of endStates) {
    const route = [];
    let cursor = endStateKey;
    while (cursor) {
      const pointIndexValue = Number(cursor.split(":")[0]);
      route.unshift(points[pointIndexValue]);
      cursor = previous.get(cursor);
    }
    if (!leavesOutward(route, srcNode, tgtNode)) continue;
    const simplified = route.filter((point, index) => {
      if (index === 0 || index === route.length - 1) return true;
      const previousPoint = route[index - 1];
      const nextPoint = route[index + 1];
      return !(Math.abs(previousPoint.x - point.x) < 0.5 && Math.abs(point.x - nextPoint.x) < 0.5 || Math.abs(previousPoint.y - point.y) < 0.5 && Math.abs(point.y - nextPoint.y) < 0.5);
    });
    return simplified;
  }
  return null;
}
function channelY(layout, flow, side, x1, x2) {
  return layout.channels?.channelY(flow?.id ?? "", side, x1, x2) ?? 0;
}
function computeWaypoints(src, tgt, layout, opts, flow) {
  if (src.isSubProcessChild && tgt.isSubProcessChild) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.x, y: tgt.centerY }
    ];
  }
  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));
  if (shouldUseUpsideRoute(src, tgt, layout, flow?.id)) {
    const upperChannelY = channelY(layout, flow, "above", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: upperChannelY },
      { x: tgt.centerX, y: upperChannelY },
      { x: tgt.centerX, y: tgt.y }
    ];
  }
  if (tgt.col <= src.col) {
    const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y + src.height },
      { x: src.centerX, y: lane },
      { x: tgt.centerX, y: lane },
      { x: tgt.centerX, y: tgt.y + tgt.height }
    ];
  }
  if (src.track === tgt.track) {
    const hasObstacle = Array.from(layout.nodes.values()).some(
      (n) => n.id !== src.id && n.id !== tgt.id && n.track === src.track && !n.isSubProcessChild && n.x < tgt.x && n.x + n.width > src.x + src.width && n.y < src.centerY && n.y + n.height > src.centerY
    );
    const srcExitY = src.element.$type === "bpmn:SubProcess" ? opts.track1Y : src.centerY;
    const tgtEntryY = tgt.element.$type === "bpmn:SubProcess" ? opts.track1Y : tgt.centerY;
    if (!hasObstacle) {
      return [
        { x: src.x + src.width, y: srcExitY },
        { x: tgt.x, y: tgtEntryY }
      ];
    }
    const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y + src.height },
      { x: src.centerX, y: lane },
      { x: tgt.centerX, y: lane },
      { x: tgt.centerX, y: tgt.y + tgt.height }
    ];
  }
  if (src.track > tgt.track && src.element.$type.endsWith("Gateway") && !tgt.element.$type.endsWith("Gateway")) {
    if (src.centerX >= tgt.x && src.centerX <= tgt.x + tgt.width) {
      return [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: tgt.y + tgt.height }
      ];
    }
    const entryX = src.centerX > tgt.x + tgt.width ? tgt.x + tgt.width : tgt.x;
    const direct = [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: tgt.centerY },
      { x: entryX, y: tgt.centerY }
    ];
    const blockers = Array.from(layout.nodes.values()).filter(
      (n) => n.id !== src.id && n.id !== tgt.id && n.element?.$type !== "bpmn:SubProcess"
    );
    if (segmentHitCount(direct[0], direct[1], blockers) > 0 && entryX === tgt.x) {
      const gapX = (src.x + src.width + tgt.x) / 2;
      const blockerBottom = Math.max(
        tgt.y + tgt.height,
        ...blockers.filter((n) => n.x < src.centerX && src.centerX < n.x + n.width && n.y + n.height < src.y).map((n) => n.y + n.height)
      );
      const midY = (blockerBottom + src.y) / 2;
      const jog = [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: midY },
        { x: gapX, y: midY },
        { x: gapX, y: tgt.centerY },
        { x: tgt.x, y: tgt.centerY }
      ];
      let jogHits = 0;
      for (let i = 0; i < jog.length - 1; i += 1) jogHits += segmentHitCount(jog[i], jog[i + 1], blockers);
      if (jogHits === 0) return jog;
    }
    return direct;
  }
  if (src.track < tgt.track && tgt.element.$type.endsWith("Gateway") && src.centerY < tgt.centerY) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y }
    ];
  }
  if (src.track < tgt.track) {
    if (src.element.$type.endsWith("Gateway")) {
      if (src.centerX >= tgt.x && src.centerX <= tgt.x + tgt.width) {
        return [
          { x: src.centerX, y: src.y + src.height },
          { x: src.centerX, y: tgt.y }
        ];
      }
      const entryX = src.centerX > tgt.x + tgt.width ? tgt.x + tgt.width : tgt.x;
      const direct = [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: tgt.centerY },
        { x: entryX, y: tgt.centerY }
      ];
      const blockers = Array.from(layout.nodes.values()).filter(
        (n) => n.id !== src.id && n.id !== tgt.id && !n.isSubProcessChild && n.element?.$type !== "bpmn:SubProcess"
      );
      const directHits = direct.slice(0, -1).reduce((count, point, index) => count + segmentHitCount(point, direct[index + 1], blockers), 0);
      if (directHits > 0) {
        const relevant = blockers.filter(
          (n) => n.x < Math.max(src.centerX, tgt.centerX) && n.x + n.width > Math.min(src.centerX, tgt.centerX) && n.y < tgt.centerY && n.y + n.height > src.y + src.height
        );
        const crossY = Math.max(tgt.centerY, ...relevant.map((n) => n.y + n.height + CHANNEL_CLEARANCE));
        for (const direction of [1, -1]) {
          const bypassX = direction > 0 ? Math.max(src.x + src.width, ...relevant.map((n) => n.x + n.width)) + CHANNEL_CLEARANCE : Math.min(src.x, ...relevant.map((n) => n.x)) - CHANNEL_CLEARANCE;
          const bypass = [
            { x: src.centerX, y: src.y + src.height },
            { x: bypassX, y: src.y + src.height },
            { x: bypassX, y: crossY },
            { x: entryX, y: crossY },
            { x: entryX, y: tgt.centerY }
          ];
          const bypassHits = bypass.slice(0, -1).reduce((count, point, index) => count + segmentHitCount(point, bypass[index + 1], blockers), 0);
          if (bypassHits === 0) return bypass;
        }
      }
      return direct;
    }
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: tgt.centerY },
      { x: tgt.x, y: tgt.centerY }
    ];
  }
  if (src.track > tgt.track && tgt.element.$type.endsWith("Gateway")) {
    const isOtherExit = layout.allFlows.some(
      (f) => f.id !== flow?.id && f.sourceRef?.id === src.id && (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track
    );
    const otherFlow = layout.allFlows.find(
      (f) => f.id !== flow?.id && f.sourceRef?.id === src.id && (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track
    );
    const otherTgt = otherFlow ? layout.nodes.get(otherFlow.targetRef?.id) : null;
    const isLonger = otherTgt ? tgt.col > otherTgt.col : false;
    if (isOtherExit && isLonger && src.element.$type.endsWith("Gateway")) {
      const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height }
      ];
    }
    const straight = [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y + tgt.height }
    ];
    const between = Array.from(layout.nodes.values()).filter(
      (n) => n.id !== src.id && n.id !== tgt.id && n.element?.$type !== "bpmn:SubProcess"
    );
    if (segmentHitCount(straight[0], straight[1], between) > 0) {
      const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height }
      ];
    }
    return straight;
  }
  return [
    { x: src.x + src.width, y: src.centerY },
    { x: tgt.centerX, y: src.centerY },
    { x: tgt.centerX, y: tgt.centerY },
    { x: tgt.x, y: tgt.centerY }
  ];
}

// src/label-layout.ts
import { BpmnModdle as BpmnModdle2 } from "bpmn-moddle";
function isEventOrGateway(element) {
  return element.$type.endsWith("Event") || element.$type.endsWith("Gateway");
}
function isExternalLabelTarget(element) {
  return isEventOrGateway(element) || element.$type === "bpmn:SequenceFlow" || element.$type === "bpmn:MessageFlow" || element.$type === "bpmn:DataStoreReference" || element.$type === "bpmn:DataObjectReference" || element.$type === "bpmn:Group";
}
function hasVisibleName(element) {
  return typeof element.name === "string" && element.name.trim().length > 0;
}
async function ensureLabelDi(xml) {
  const moddle = new BpmnModdle2();
  const { rootElement } = await moddle.fromXML(xml);
  const definitions = rootElement;
  const diagrams = definitions.diagrams ?? [];
  const addForProcess = (process) => {
    const diagram = diagrams.find((candidate) => candidate.plane?.bpmnElement?.id === process.id);
    if (!diagram?.plane) return;
    const diById = new Map(
      (diagram.plane.planeElement ?? []).filter((di) => di.bpmnElement?.id).map((di) => [di.bpmnElement.id, di])
    );
    const elements = [];
    const visit = (element) => {
      elements.push(element);
      for (const child of element.flowElements ?? []) visit(child);
    };
    for (const element of process.flowElements ?? []) visit(element);
    for (const laneSet of process.laneSets ?? []) for (const lane of laneSet.lanes ?? []) elements.push(lane);
    for (const lane of process.childLaneSet?.lanes ?? []) elements.push(lane);
    for (const element of elements) {
      const needsLabel = (isEventOrGateway(element) || element.$type === "bpmn:Lane") && hasVisibleName(element);
      if (!needsLabel) continue;
      const di = diById.get(element.id);
      if (!di?.bounds || !validBounds(di.bounds) || validBounds(di.label?.bounds)) continue;
      const labelBounds = element.$type === "bpmn:Lane" ? { x: di.bounds.x - di.bounds.height / 2 + 15, y: di.bounds.y + di.bounds.height / 2 - 15, width: di.bounds.height, height: 30 } : { x: di.bounds.x + di.bounds.width / 2 - 45, y: di.bounds.y + di.bounds.height, width: 90, height: 20 };
      di.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", labelBounds)
      });
    }
  };
  for (const process of definitions.rootElements ?? []) {
    if (process.$type === "bpmn:Process") addForProcess(process);
  }
  return (await moddle.toXML(definitions, { format: true })).xml;
}
function validBounds(bounds) {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) && typeof width === "number" && Number.isFinite(width) && typeof height === "number" && Number.isFinite(height) && width >= 0 && height >= 0;
}
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function isContainer(element) {
  return ["bpmn:Lane", "bpmn:Participant", "bpmn:SubProcess"].includes(element.$type);
}
function labelLayout() {
  return {
    check(node, reporter) {
      if (node.$type !== "bpmn:Definitions") return;
      const definitions = node;
      const processes = (definitions.rootElements ?? []).filter((element) => element.$type === "bpmn:Process");
      for (const process of processes) {
        const diagram = (definitions.diagrams ?? []).find(
          (candidate) => candidate.plane?.bpmnElement?.id === process.id
        );
        if (!diagram?.plane) continue;
        const diElements = diagram.plane.planeElement ?? [];
        const diById = new Map(
          diElements.filter((di) => di.bpmnElement?.id).map((di) => [di.bpmnElement.id, di])
        );
        const elements = [];
        const visit = (element) => {
          elements.push(element);
          for (const child of element.flowElements ?? []) visit(child);
        };
        for (const element of process.flowElements ?? []) visit(element);
        for (const laneSet of process.laneSets ?? []) {
          for (const lane of laneSet.lanes ?? []) elements.push(lane);
        }
        for (const lane of process.childLaneSet?.lanes ?? []) elements.push(lane);
        const labels = [];
        for (const element of elements) {
          const di = diById.get(element.id);
          const hasName = typeof element.name === "string" && element.name.trim().length > 0;
          const requiresLabel = isEventOrGateway(element) || element.$type === "bpmn:Lane";
          if (requiresLabel && hasName && !di?.label) {
            reporter.report(element.id, "Named element is missing its BPMN label DI");
          }
          if (!di?.label) continue;
          if (!validBounds(di.label.bounds)) {
            reporter.report(element.id, "BPMN label is missing valid bounds");
            continue;
          }
          if (isExternalLabelTarget(element)) labels.push({ target: element, bounds: di.label.bounds, di });
          if (element.$type === "bpmn:Lane" && di.bounds && validBounds(di.bounds) && !contains(di.bounds, di.label.bounds)) {
            reporter.report(element.id, "Lane label must remain inside its lane boundary");
          }
        }
        for (let i = 0; i < labels.length; i += 1) {
          const label = labels[i];
          const targetDi = diById.get(label.target.id);
          const targetBounds = targetDi?.bounds;
          if (validBounds(targetBounds)) {
            for (const di of diElements) {
              const element = di.bpmnElement;
              if (!element || element.id === label.target.id || !validBounds(di.bounds)) continue;
              if (isContainer(element) && contains(di.bounds, targetBounds)) continue;
              if (element.$type.endsWith("Flow") || element.$type === "bpmn:SequenceFlow") continue;
              if (overlaps(label.bounds, di.bounds)) {
                reporter.report(label.target.id, `BPMN label overlaps element '${element.id}'`);
              }
            }
          }
          for (let j = i + 1; j < labels.length; j += 1) {
            const other = labels[j];
            if (other.target.id !== label.target.id && overlaps(label.bounds, other.bounds)) {
              reporter.report(label.target.id, `BPMN label overlaps label for '${other.target.id}'`);
              reporter.report(other.target.id, `BPMN label overlaps label for '${label.target.id}'`);
            }
          }
          if (validBounds(targetBounds)) {
            const boundaries = diElements.filter((di) => {
              const element = di.bpmnElement;
              return element && (element.$type === "bpmn:Lane" || element.$type === "bpmn:Participant") && element.id !== label.target.id && validBounds(di.bounds) && contains(di.bounds, targetBounds);
            });
            for (const boundary of boundaries) {
              if (validBounds(boundary.bounds) && !contains(boundary.bounds, label.bounds)) {
                reporter.report(label.target.id, `BPMN label must remain inside boundary '${boundary.bpmnElement.id}'`);
              }
            }
          }
        }
      }
    }
  };
}
export {
  ensureLabelDi,
  labelLayout,
  layoutProcess
};
