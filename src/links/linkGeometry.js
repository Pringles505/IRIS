export const LINK_POINTER_LENGTH = 11;
export const LINK_POINTER_WIDTH = 8;
export const JOINT_HIT_RADIUS = 12;

const LINK_LANE_GAP = 18;
const CORNER_PAD = 12;
const EPSILON = 0.0001;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function pointOnQuadratic(p0, p1, p2, t) {
  const inv = 1 - t;
  return {
    x: inv * inv * p0.x + 2 * inv * t * p1.x + t * t * p2.x,
    y: inv * inv * p0.y + 2 * inv * t * p1.y + t * t * p2.y,
  };
}

function tangentOnQuadratic(p0, p1, p2, t) {
  return {
    x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
  };
}

function pointOnSegment(segment, t) {
  if (segment.type === 'line') {
    return {
      x: lerp(segment.start.x, segment.end.x, t),
      y: lerp(segment.start.y, segment.end.y, t),
    };
  }

  return pointOnQuadratic(segment.start, segment.control, segment.end, t);
}

function pointAlong(point, target, distance) {
  const length = dist(point, target);
  if (length < EPSILON || distance <= 0) return { ...point };
  const ratio = distance / length;
  return {
    x: point.x + (target.x - point.x) * ratio,
    y: point.y + (target.y - point.y) * ratio,
  };
}

function normalize(dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function getNodeCenter(node) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function getNodeAnchorCandidates(node, offset = { x: 0, y: 0 }) {
  const center = getNodeCenter(node);
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;

  return {
    top: {
      x: center.x + clamp(offset.x, -halfWidth + CORNER_PAD, halfWidth - CORNER_PAD),
      y: center.y - halfHeight,
    },
    right: {
      x: center.x + halfWidth,
      y: center.y + clamp(offset.y, -halfHeight + CORNER_PAD, halfHeight - CORNER_PAD),
    },
    bottom: {
      x: center.x + clamp(offset.x, -halfWidth + CORNER_PAD, halfWidth - CORNER_PAD),
      y: center.y + halfHeight,
    },
    left: {
      x: center.x - halfWidth,
      y: center.y + clamp(offset.y, -halfHeight + CORNER_PAD, halfHeight - CORNER_PAD),
    },
    center: {
      x: center.x + offset.x,
      y: center.y + offset.y,
    },
  };
}

export { getNodeAnchorCandidates };

export function getClosestNodeOutlinePosition(node, canvasPoint, offset = { x: 0, y: 0 }) {
  const left = node.x + offset.x;
  const right = node.x + node.width + offset.x;
  const top = node.y + offset.y;
  const bottom = node.y + node.height + offset.y;
  const center = {
    x: node.x + node.width / 2 + offset.x,
    y: node.y + node.height / 2 + offset.y,
  };

  const distances = [
    { side: 'top', value: Math.abs(canvasPoint.y - top) },
    { side: 'right', value: Math.abs(canvasPoint.x - right) },
    { side: 'bottom', value: Math.abs(canvasPoint.y - bottom) },
    { side: 'left', value: Math.abs(canvasPoint.x - left) },
  ].sort((a, b) => a.value - b.value);

  const side = distances[0]?.side ?? 'right';
  const along = side === 'top' || side === 'bottom'
    ? clamp(canvasPoint.x - center.x, -node.width / 2, node.width / 2)
    : clamp(canvasPoint.y - center.y, -node.height / 2, node.height / 2);

  return {
    side,
    along,
    point: {
      x: side === 'left' ? left : side === 'right' ? right : center.x + along,
      y: side === 'top' ? top : side === 'bottom' ? bottom : center.y + along,
    },
  };
}

// Anchors placed at an exact spot (e.g. on a custom shape outline) store their position
// as fractions of the node box in posX/posY.
function hasExactAnchorPosition(anchorLike) {
  return Number.isFinite(anchorLike?.posX) && Number.isFinite(anchorLike?.posY);
}

export function getNodeAnchorPoint(node, anchorLike, offset = { x: 0, y: 0 }) {
  if (hasExactAnchorPosition(anchorLike)) {
    return {
      x: node.x + anchorLike.posX * node.width + offset.x,
      y: node.y + anchorLike.posY * node.height + offset.y,
    };
  }

  if (!anchorLike) {
    const center = getNodeCenter(node);
    return { x: center.x + offset.x, y: center.y + offset.y };
  }

  if (anchorLike.side === 'center') {
    const center = getNodeCenter(node);
    return { x: center.x + offset.x, y: center.y + offset.y };
  }

  const point = getPointOnNodeSide(
    node,
    anchorLike.side,
    anchorLike.along ?? 0,
    anchorLike.anchorId || anchorLike.id ? 0 : CORNER_PAD
  );
  return translatePoint(point, offset);
}

function getNodeAnchorById(node, anchorId) {
  return (node.anchors ?? []).find(anchor => anchor.id === anchorId) ?? null;
}

function translatePoint(point, offset) {
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
  };
}

function getDirectionalBasis(fromNode, toNode) {
  const startCenter = getNodeCenter(fromNode);
  const endCenter = getNodeCenter(toNode);
  const direction = normalize(endCenter.x - startCenter.x, endCenter.y - startCenter.y);
  const normal = { x: -direction.y, y: direction.x };

  return { startCenter, endCenter, direction, normal };
}

function getNodeSupportAlongNormal(node, normal) {
  return (node.width / 2) * Math.abs(normal.x) + (node.height / 2) * Math.abs(normal.y);
}

function getRectRayBoundaryPoint(node, localStart, direction) {
  return getRectRayBoundaryInfo(node, localStart, direction).point;
}

function getRectRayBoundaryInfo(node, localStart, direction) {
  const center = getNodeCenter(node);
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  let best = null;

  if (Math.abs(direction.x) > EPSILON) {
    for (const edgeX of [-halfWidth, halfWidth]) {
      const t = (edgeX - localStart.x) / direction.x;
      if (t < 0) continue;
      const y = localStart.y + direction.y * t;
      if (y >= -halfHeight - EPSILON && y <= halfHeight + EPSILON) {
        if (!best || t < best.t) {
          best = { t, axis: 'x', edge: edgeX, along: y };
        }
      }
    }
  }

  if (Math.abs(direction.y) > EPSILON) {
    for (const edgeY of [-halfHeight, halfHeight]) {
      const t = (edgeY - localStart.y) / direction.y;
      if (t < 0) continue;
      const x = localStart.x + direction.x * t;
      if (x >= -halfWidth - EPSILON && x <= halfWidth + EPSILON) {
        if (!best || t < best.t) {
          best = { t, axis: 'y', edge: edgeY, along: x };
        }
      }
    }
  }

  if (!best) {
    return {
      side: null,
      along: 0,
      point: translatePoint(center, localStart),
    };
  }

  if (best.axis === 'x') {
    const side = best.edge < 0 ? 'left' : 'right';
    return {
      side,
      along: best.along,
      point: {
        x: center.x + best.edge,
        y: center.y + clamp(best.along, -halfHeight + CORNER_PAD, halfHeight - CORNER_PAD),
      },
    };
  }

  const side = best.edge < 0 ? 'top' : 'bottom';
  return {
    side,
    along: best.along,
    point: {
      x: center.x + clamp(best.along, -halfWidth + CORNER_PAD, halfWidth - CORNER_PAD),
      y: center.y + best.edge,
    },
  };
}

function getPairKey(link) {
  return [link.fromId, link.toId].sort().join('::');
}

function getPairLinks(link, allLinks) {
  if (!Array.isArray(allLinks)) return [link];
  const pairKey = getPairKey(link);
  const pairLinks = allLinks.filter(item => getPairKey(item) === pairKey);
  return pairLinks.length ? pairLinks : [link];
}

function getLaneOffsetScalar(link, allLinks, maxOffset) {
  const pairLinks = getPairLinks(link, allLinks);
  if (pairLinks.length <= 1 || maxOffset <= EPSILON) return 0;

  const laneIndex = pairLinks.findIndex(item => item.id === link.id);
  if (laneIndex < 0) return 0;

  const preferredSpan = LINK_LANE_GAP * (pairLinks.length - 1);
  const usableSpan = Math.min(preferredSpan, maxOffset * 2);
  const step = pairLinks.length > 1 ? usableSpan / (pairLinks.length - 1) : 0;
  return -usableSpan / 2 + laneIndex * step;
}

export function getLinkParallelOffset(link, fromNode, toNode, allLinks = []) {
  if (link.fromJunctionLinkId && link.fromJunctionJointId) {
    return { x: 0, y: 0 };
  }

  const { normal } = getDirectionalBasis(fromNode, toNode);
  const maxOffset = Math.max(
    0,
    Math.min(
      getNodeSupportAlongNormal(fromNode, normal),
      getNodeSupportAlongNormal(toNode, normal)
    ) - 2
  );
  const pairLinks = getPairLinks(link, allLinks);
  const laneScalar = getLaneOffsetScalar(link, pairLinks, maxOffset);
  const parallelOffset = laneScalar;

  return {
    x: normal.x * parallelOffset,
    y: normal.y * parallelOffset,
  };
}

function getBoundaryAlongLimit(node, side) {
  return side === 'top' || side === 'bottom'
    ? Math.max(0, node.width / 2 - CORNER_PAD)
    : Math.max(0, node.height / 2 - CORNER_PAD);
}

function getPointOnNodeSide(node, side, along, edgePad = CORNER_PAD) {
  const center = getNodeCenter(node);
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;

  if (side === 'top') {
    return {
      x: center.x + clamp(along, -halfWidth + edgePad, halfWidth - edgePad),
      y: center.y - halfHeight,
    };
  }

  if (side === 'right') {
    return {
      x: center.x + halfWidth,
      y: center.y + clamp(along, -halfHeight + edgePad, halfHeight - edgePad),
    };
  }

  if (side === 'bottom') {
    return {
      x: center.x + clamp(along, -halfWidth + edgePad, halfWidth - edgePad),
      y: center.y + halfHeight,
    };
  }

  return {
    x: center.x - halfWidth,
    y: center.y + clamp(along, -halfHeight + edgePad, halfHeight - edgePad),
  };
}

function getEndpointTargetPoint(link, fromNode, toNode, offset, isStart) {
  if (isStart) {
    const firstJoint = link.joints?.[0];
    return firstJoint
      ? translatePoint({ x: firstJoint.x, y: firstJoint.y }, offset)
      : translatePoint(getNodeCenter(toNode), offset);
  }

  const lastJoint = link.joints?.[link.joints.length - 1];
  return lastJoint
    ? translatePoint({ x: lastJoint.x, y: lastJoint.y }, offset)
    : translatePoint(getNodeCenter(fromNode), offset);
}

function getEndpointDescriptor(link, node, oppositeNode, allLinks = [], isStart) {
  const offset = isStart
    ? getLinkParallelOffset(link, node, oppositeNode, allLinks)
    : getLinkParallelOffset(link, oppositeNode, node, allLinks);
  const explicitSide = isStart ? link.fromAnchorSide : link.toAnchorSide;
  const explicitAnchorId = isStart ? link.fromAnchorId : link.toAnchorId;
  const lockCenter = isStart ? !!link.fromAnchorLockedCenter : !!link.toAnchorLockedCenter;
  const explicitAnchor = explicitAnchorId ? getNodeAnchorById(node, explicitAnchorId) : null;
  const targetPoint = getEndpointTargetPoint(
    link,
    isStart ? node : oppositeNode,
    isStart ? oppositeNode : node,
    offset,
    isStart
  );
  const center = getNodeCenter(node);
  const direction = {
    x: targetPoint.x - (center.x + offset.x),
    y: targetPoint.y - (center.y + offset.y),
  };

  if (explicitSide === 'center') {
    return {
      usesBoundaryAnchor: false,
      side: 'center',
      desiredAlong: 0,
      sortAlong: 0,
      fallbackPoint: translatePoint(getNodeCenter(node), offset),
    };
  }

  let side = explicitSide;
  let desiredAlong;
  let sortAlong;

  if (explicitAnchor && hasExactAnchorPosition(explicitAnchor)) {
    // Exact anchors attach exactly where they were placed and don't share lanes.
    return {
      usesBoundaryAnchor: false,
      side: explicitAnchor.side,
      desiredAlong: explicitAnchor.along ?? 0,
      sortAlong: explicitAnchor.along ?? 0,
      fallbackPoint: getNodeAnchorPoint(node, explicitAnchor),
      anchorId: explicitAnchor.id,
      lockCenter: false,
    };
  }

  // Nodes whose default side anchors were replaced (custom shape editor) attach links
  // that aren't pinned to an anchor at the anchor nearest the other end.
  const customAnchors = node.customAnchorsOnly ? (node.anchors ?? []) : [];
  if (!explicitAnchor && customAnchors.length && explicitSide !== 'center') {
    let best = null;
    let bestDist = Infinity;
    for (const anchor of customAnchors) {
      const point = getNodeAnchorPoint(node, anchor);
      const d = dist(point, targetPoint);
      if (d < bestDist) { best = { anchor, point }; bestDist = d; }
    }
    return {
      usesBoundaryAnchor: false,
      side: best.anchor.side,
      desiredAlong: best.anchor.along ?? 0,
      sortAlong: best.anchor.along ?? 0,
      fallbackPoint: best.point,
      anchorId: best.anchor.id,
      lockCenter: false,
    };
  }

  if (explicitAnchor) {
    return {
      usesBoundaryAnchor: true,
      side: explicitAnchor.side,
      desiredAlong: explicitAnchor.along ?? 0,
      sortAlong: explicitAnchor.along ?? 0,
      fallbackPoint: getNodeAnchorPoint(node, explicitAnchor),
      anchorId: explicitAnchor.id,
      lockCenter: false,
    };
  }

  if (side) {
    const alongKey = isStart ? 'fromAlongPos' : 'toAlongPos';
    const rawAlong = link[alongKey] ?? 0;
    desiredAlong = rawAlong;
    sortAlong = side === 'top' || side === 'bottom'
      ? targetPoint.x - center.x
      : targetPoint.y - center.y;
  } else {
    const boundary = getRectRayBoundaryInfo(node, offset, direction);
    side = boundary.side ?? 'right';
    desiredAlong = boundary.along;
    sortAlong = boundary.along;
  }

  return {
    usesBoundaryAnchor: true,
    side,
    desiredAlong,
    sortAlong,
    fallbackPoint: getPointOnNodeSide(node, side, desiredAlong),
    anchorId: null,
    lockCenter,
  };
}

function packAlongPositions(entries, node, side) {
  if (!entries.length) return new Map();

  const limit = getBoundaryAlongLimit(node, side);
  const min = -limit;
  const max = limit;
  const span = Math.max(0, max - min);
  const desiredGap = LINK_LANE_GAP;
  const gap = entries.length > 1
    ? Math.min(desiredGap, span / (entries.length - 1))
    : 0;
  const positions = entries.map(entry => clamp(entry.desiredAlong, min, max));

  positions[0] = Math.max(positions[0], min);
  for (let i = 1; i < positions.length; i++) {
    positions[i] = Math.max(positions[i], positions[i - 1] + gap);
  }

  if (positions[positions.length - 1] > max) {
    positions[positions.length - 1] = max;
    for (let i = positions.length - 2; i >= 0; i--) {
      positions[i] = Math.min(positions[i], positions[i + 1] - gap);
    }
  }

  if (positions[0] < min) {
    positions[0] = min;
    for (let i = 1; i < positions.length; i++) {
      positions[i] = Math.max(positions[i], positions[i - 1] + gap);
    }
  }

  const desiredCenter = entries.reduce((sum, entry) => sum + clamp(entry.desiredAlong, min, max), 0) / entries.length;
  const currentCenter = positions.reduce((sum, pos) => sum + pos, 0) / positions.length;
  const shift = clamp(desiredCenter - currentCenter, min - positions[0], max - positions[positions.length - 1]);
  for (let i = 0; i < positions.length; i++) {
    positions[i] += shift;
  }

  return new Map(entries.map((entry, index) => [entry.id, positions[index]]));
}

function getNodeSideAnchorPoint(link, node, oppositeNode, allLinks = [], allNodes = [], isStart) {
  const descriptor = getEndpointDescriptor(
    link,
    node,
    oppositeNode,
    allLinks,
    isStart
  );

  if (!descriptor.usesBoundaryAnchor) {
    return descriptor.fallbackPoint;
  }

  const nodeMap = Object.fromEntries((allNodes ?? []).map(item => [item.id, item]));
  const relevantEntries = (allLinks ?? [])
    .map(item => {
      const attachedAtStart = item.fromId === node.id;
      const attachedAtEnd = item.toId === node.id;
      if (!attachedAtStart && !attachedAtEnd) return null;

      const itemFromNode = attachedAtStart ? node : nodeMap[item.fromId];
      const itemToNode = attachedAtEnd ? node : nodeMap[item.toId];
      if (!itemFromNode || !itemToNode) return null;

      const itemDescriptor = getEndpointDescriptor(
        item,
        attachedAtStart ? itemFromNode : itemToNode,
        attachedAtStart ? itemToNode : itemFromNode,
        allLinks,
        attachedAtStart
      );
      if (!itemDescriptor.usesBoundaryAnchor || itemDescriptor.side !== descriptor.side) {
        return null;
      }

      return {
        id: item.id,
        desiredAlong: itemDescriptor.desiredAlong,
        sortAlong: itemDescriptor.sortAlong ?? itemDescriptor.desiredAlong,
        anchorId: itemDescriptor.anchorId ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.sortAlong - b.sortAlong || a.id.localeCompare(b.id));

  if (!relevantEntries.length) {
    return descriptor.fallbackPoint;
  }

  const packedAlongById = packAlongPositions(relevantEntries, node, descriptor.side);
  const packedAlong = packedAlongById.get(link.id);
  if (packedAlong == null) {
    return descriptor.fallbackPoint;
  }

  if (descriptor.anchorId) {
    return getNodeAnchorPoint(node, { side: descriptor.side, along: descriptor.desiredAlong });
  }

  if (descriptor.lockCenter) {
    return getPointOnNodeSide(node, descriptor.side, 0);
  }

  return getPointOnNodeSide(node, descriptor.side, packedAlong);
}

export function getLinkAnchorPoints(link, fromNode, toNode, allLinks = [], allNodes = []) {
  const { startCenter, endCenter } = getDirectionalBasis(fromNode, toNode);
  const offset = getLinkParallelOffset(link, fromNode, toNode, allLinks);
  const sourceAnchors = getNodeAnchorCandidates(fromNode, offset);
  const targetAnchors = getNodeAnchorCandidates(toNode, offset);
  const start = resolveLinkJunctionPoint(
    link.fromJunctionLinkId,
    link.fromJunctionJointId,
    allLinks,
    allNodes
  ) ?? getNodeSideAnchorPoint(link, fromNode, toNode, allLinks, allNodes, true);
  const end = link.toAnchorSide
    ? getNodeSideAnchorPoint(link, toNode, fromNode, allLinks, allNodes, false)
    : link.showArrowTip
      ? getNodeSideAnchorPoint(link, toNode, fromNode, allLinks, allNodes, false)
      : translatePoint(endCenter, offset);

  return {
    start,
    end,
    startCenter,
    endCenter,
    offset,
    sourceAnchors,
    targetAnchors,
  };
}

function getRoutePoints(link, fromNode, toNode, allLinks = [], allNodes = []) {
  const anchors = getLinkAnchorPoints(link, fromNode, toNode, allLinks, allNodes);
  const { offset } = anchors;
  const joints = (link.joints ?? []).map(joint => ({
    ...joint,
    point: translatePoint({ x: joint.x, y: joint.y }, offset),
  }));

  return [
    { type: 'endpoint', point: anchors.start },
    ...joints,
    { type: 'endpoint', point: anchors.end },
  ];
}

export function resolveLinkJunctionPoint(linkId, jointId, allLinks = [], allNodes = [], visited = new Set()) {
  if (!linkId || !jointId) return null;

  const visitKey = `${linkId}::${jointId}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const link = (allLinks ?? []).find(item => item.id === linkId);
  if (!link) return null;

  const fromNode = (allNodes ?? []).find(node => node.id === link.fromId);
  const toNode = (allNodes ?? []).find(node => node.id === link.toId);
  if (!fromNode || !toNode) return null;

  const render = buildLinkRenderData(link, fromNode, toNode, allLinks, allNodes, visited);
  const joint = render.jointRenderPoints.find(item => item.id === jointId);
  return joint ? { x: joint.x, y: joint.y } : null;
}

export function getLinkDistanceMetricsToJoint(linkId, jointId, allLinks = [], allNodes = [], visited = new Set()) {
  if (!linkId || !jointId) return null;

  const visitKey = `${linkId}::${jointId}::distance`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const link = (allLinks ?? []).find(item => item.id === linkId);
  if (!link) return null;

  const fromNode = (allNodes ?? []).find(node => node.id === link.fromId);
  const toNode = (allNodes ?? []).find(node => node.id === link.toId);
  if (!fromNode || !toNode) return null;

  const render = buildLinkRenderData(link, fromNode, toNode, allLinks, allNodes, visited);
  if (!render.length || render.length <= EPSILON) {
    return {
      distanceToJoint: 0,
      totalDistance: 0,
    };
  }

  const jointPoint = render.jointRenderPoints.find(point => point.id === jointId);
  if (!jointPoint) return null;

  let traversed = 0;
  let distanceToJoint = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const segment of render.segments) {
    const result = segment.type === 'line'
      ? getClosestLengthOnLineSegment(segment, jointPoint)
      : getClosestLengthOnQuadraticSegment(segment, jointPoint);

    if (result.distance < bestDistance) {
      bestDistance = result.distance;
      distanceToJoint = traversed + result.length;
    }
    traversed += segment.length;
  }

  return {
    distanceToJoint,
    totalDistance: render.length,
  };
}

export function getLinkJointProgress(linkId, jointId, allLinks = [], allNodes = [], visited = new Set()) {
  const metrics = getLinkDistanceMetricsToJoint(linkId, jointId, allLinks, allNodes, visited);
  if (!metrics) return null;
  if (metrics.totalDistance <= EPSILON) return 0;
  return clamp(metrics.distanceToJoint / metrics.totalDistance, 0, 1);
}

export function getLinkTravelTimeToJoint(linkId, jointId, duration, allLinks = [], allNodes = [], visited = new Set()) {
  const metrics = getLinkDistanceMetricsToJoint(linkId, jointId, allLinks, allNodes, visited);
  if (!metrics) return null;
  if (metrics.totalDistance <= EPSILON) return 0;
  const speed = metrics.totalDistance / Math.max(duration ?? 0, EPSILON);
  return metrics.distanceToJoint / speed;
}

function getClosestLengthOnLineSegment(segment, target) {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < EPSILON
    ? 0
    : clamp(((target.x - segment.start.x) * dx + (target.y - segment.start.y) * dy) / lenSq, 0, 1);
  const point = {
    x: lerp(segment.start.x, segment.end.x, t),
    y: lerp(segment.start.y, segment.end.y, t),
  };
  return {
    distance: dist(point, target),
    length: segment.length * t,
  };
}

function getClosestLengthOnQuadraticSegment(segment, target) {
  let bestT = 0;
  let bestPoint = segment.start;
  let bestDistance = dist(segment.start, target);

  for (let i = 1; i <= 80; i++) {
    const t = i / 80;
    const point = pointOnQuadratic(segment.start, segment.control, segment.end, t);
    const distance = dist(point, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestT = t;
      bestPoint = point;
    }
  }

  return {
    distance: bestDistance,
    length: segment.length * bestT,
    point: bestPoint,
  };
}

// Which boundary side of `node` the point sits closest to.
function sideOfPointOnNode(point, node) {
  const left = node.x;
  const right = node.x + node.width;
  const top = node.y;
  const bottom = node.y + node.height;
  const candidates = [
    { side: 'left', d: Math.abs(point.x - left) },
    { side: 'right', d: Math.abs(point.x - right) },
    { side: 'top', d: Math.abs(point.y - top) },
    { side: 'bottom', d: Math.abs(point.y - bottom) },
  ];
  return candidates.sort((a, b) => a.d - b.d)[0].side;
}

function sideNormal(side) {
  switch (side) {
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
    case 'top': return { x: 0, y: -1 };
    default: return { x: 0, y: 1 };
  }
}

// Generate intermediate right-angle waypoints between two anchored endpoints.
// Each endpoint leaves its node along the outward normal of its side, then the
// two stubs are joined with horizontal/vertical segments — draw.io's default
// orthogonal connector behaviour.
function buildOrthogonalWaypoints(start, fromNode, end, toNode) {
  const STUB = 22;
  const sideStart = sideOfPointOnNode(start, fromNode);
  const sideEnd = sideOfPointOnNode(end, toNode);
  const n0 = sideNormal(sideStart);
  const n1 = sideNormal(sideEnd);
  const a = { x: start.x + n0.x * STUB, y: start.y + n0.y * STUB };
  const b = { x: end.x + n1.x * STUB, y: end.y + n1.y * STUB };
  const horizA = sideStart === 'left' || sideStart === 'right';
  const horizB = sideEnd === 'left' || sideEnd === 'right';

  const points = [a];
  if (horizA && horizB) {
    const midX = (a.x + b.x) / 2;
    points.push({ x: midX, y: a.y }, { x: midX, y: b.y });
  } else if (!horizA && !horizB) {
    const midY = (a.y + b.y) / 2;
    points.push({ x: a.x, y: midY }, { x: b.x, y: midY });
  } else if (horizA) {
    points.push({ x: b.x, y: a.y });
  } else {
    points.push({ x: a.x, y: b.y });
  }
  points.push(b);
  return points;
}

function buildSegments(routePoints) {
  const segments = [];
  let current = routePoints[0].point;

  for (let i = 1; i < routePoints.length - 1; i++) {
    const prev = routePoints[i - 1].point;
    const joint = routePoints[i];
    const next = routePoints[i + 1].point;

    const prevLimit = dist(prev, joint.point) / 2;
    const nextLimit = dist(next, joint.point) / 2;
    const curveIn = clamp(joint.prevCurve ?? 0, 0, prevLimit);
    const curveOut = clamp(joint.nextCurve ?? 0, 0, nextLimit);
    const before = curveIn > EPSILON ? pointAlong(joint.point, prev, curveIn) : { ...joint.point };
    const after = curveOut > EPSILON ? pointAlong(joint.point, next, curveOut) : { ...joint.point };

    if (dist(current, before) > EPSILON) {
      segments.push({ type: 'line', start: current, end: before });
    }

    if (curveIn > EPSILON || curveOut > EPSILON) {
      segments.push({ type: 'quadratic', start: before, control: joint.point, end: after });
      current = after;
    } else {
      current = joint.point;
    }
  }

  const end = routePoints[routePoints.length - 1].point;
  if (dist(current, end) > EPSILON) {
    segments.push({ type: 'line', start: current, end });
  }

  return segments;
}

function segmentLength(segment) {
  if (segment.type === 'line') return dist(segment.start, segment.end);

  let length = 0;
  let prev = segment.start;
  for (let i = 1; i <= 14; i++) {
    const point = pointOnQuadratic(segment.start, segment.control, segment.end, i / 14);
    length += dist(prev, point);
    prev = point;
  }
  return length;
}

function buildPathData(segments) {
  if (!segments.length) return '';

  const commands = [`M ${segments[0].start.x} ${segments[0].start.y}`];
  for (const segment of segments) {
    if (segment.type === 'line') {
      commands.push(`L ${segment.end.x} ${segment.end.y}`);
    } else {
      commands.push(`Q ${segment.control.x} ${segment.control.y} ${segment.end.x} ${segment.end.y}`);
    }
  }
  return commands.join(' ');
}

function getPointAndTangentAtLength(segments, targetLength) {
  if (!segments.length) {
    return {
      point: { x: 0, y: 0 },
      tangent: { x: 1, y: 0 },
    };
  }

  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = clamp(targetLength, 0, totalLength);

  for (const segment of segments) {
    if (remaining <= segment.length || segment === segments[segments.length - 1]) {
      const t = segment.length < EPSILON ? 1 : clamp(remaining / segment.length, 0, 1);
      if (segment.type === 'line') {
        return {
          point: {
            x: lerp(segment.start.x, segment.end.x, t),
            y: lerp(segment.start.y, segment.end.y, t),
          },
          tangent: {
            x: segment.end.x - segment.start.x,
            y: segment.end.y - segment.start.y,
          },
        };
      }

      return {
        point: pointOnQuadratic(segment.start, segment.control, segment.end, t),
        tangent: tangentOnQuadratic(segment.start, segment.control, segment.end, t),
      };
    }

    remaining -= segment.length;
  }

  const last = segments[segments.length - 1];
  return {
    point: last.end,
    tangent: last.type === 'line'
      ? { x: last.end.x - last.start.x, y: last.end.y - last.start.y }
      : { x: last.end.x - last.control.x, y: last.end.y - last.control.y },
  };
}

function getArrowHead(endPoint, tangent, length = LINK_POINTER_LENGTH, width = LINK_POINTER_WIDTH) {
  const direction = normalize(tangent.x, tangent.y);
  const normal = { x: -direction.y, y: direction.x };
  const base = {
    x: endPoint.x - direction.x * length,
    y: endPoint.y - direction.y * length,
  };

  return [
    endPoint.x,
    endPoint.y,
    base.x + normal.x * (width / 2),
    base.y + normal.y * (width / 2),
    base.x - normal.x * (width / 2),
    base.y - normal.y * (width / 2),
  ];
}

function getFinalTangent(segments, routePoints) {
  if (segments.length) {
    const last = segments[segments.length - 1];
    if (last.type === 'line') {
      return {
        x: last.end.x - last.start.x,
        y: last.end.y - last.start.y,
      };
    }

    return {
      x: last.end.x - last.control.x,
      y: last.end.y - last.control.y,
    };
  }

  const start = routePoints[0].point;
  const end = routePoints[routePoints.length - 1].point;
  return { x: end.x - start.x, y: end.y - start.y };
}

function pointInNode(point, node) {
  return (
    point.x >= node.x - EPSILON &&
    point.x <= node.x + node.width + EPSILON &&
    point.y >= node.y - EPSILON &&
    point.y <= node.y + node.height + EPSILON
  );
}

function getVisibleLength(segmentList, toNode, keepHiddenTail) {
  if (keepHiddenTail) {
    return segmentList.reduce((sum, segment) => sum + segment.length, 0);
  }

  let totalLength = segmentList.reduce((sum, segment) => sum + segment.length, 0);
  let hiddenTailLength = 0;

  for (let index = segmentList.length - 1; index >= 0; index -= 1) {
    const segment = segmentList[index];
    const samples = segment.type === 'line' ? 24 : 72;
    let firstOutsideT = null;

    for (let step = samples; step >= 0; step -= 1) {
      const t = step / samples;
      const point = pointOnSegment(segment, t);
      if (!pointInNode(point, toNode)) {
        firstOutsideT = t;
        break;
      }
    }

    if (firstOutsideT == null) {
      hiddenTailLength += segment.length;
      continue;
    }

    if (firstOutsideT >= 1) {
      break;
    }

    hiddenTailLength += segment.length * (1 - firstOutsideT);
    break;
  }

  return Math.max(0, totalLength - hiddenTailLength);
}

export function buildLinkRenderData(link, fromNode, toNode, allLinks = [], allNodes = [], visited = new Set()) {
  const anchors = (() => {
    const hasFromJunction = !!(link.fromJunctionLinkId && link.fromJunctionJointId);
    const hasToJunction = !!(link.toJunctionLinkId && link.toJunctionJointId);

    if (!hasFromJunction && !hasToJunction) {
      return getLinkAnchorPoints(link, fromNode, toNode, allLinks, allNodes);
    }

    const fallbackAnchors = getLinkAnchorPoints(link, fromNode, toNode, allLinks, allNodes);
    let result = { ...fallbackAnchors };

    if (hasFromJunction) {
      const junctionPoint = resolveLinkJunctionPoint(
        link.fromJunctionLinkId,
        link.fromJunctionJointId,
        allLinks,
        allNodes,
        visited
      );
      if (junctionPoint) {
        result = {
          ...result,
          start: junctionPoint,
          startCenter: junctionPoint,
          offset: { x: 0, y: 0 },
          sourceAnchors: {},
        };
      }
    }

    if (hasToJunction) {
      const junctionPoint = resolveLinkJunctionPoint(
        link.toJunctionLinkId,
        link.toJunctionJointId,
        allLinks,
        allNodes,
        visited
      );
      if (junctionPoint) {
        result = {
          ...result,
          end: junctionPoint,
          endCenter: junctionPoint,
          targetAnchors: {},
        };
      }
    }

    return result;
  })();
  const routePoints = (() => {
    const joints = (link.joints ?? []).map(joint => ({
      ...joint,
      point: translatePoint({ x: joint.x, y: joint.y }, anchors.offset),
    }));

    // Orthogonal routing: when the link is set to right-angle style and has no
    // manual bend points, auto-insert right-angle waypoints. These are render-
    // only (type 'auto') and not draggable joints.
    if (link.routeStyle === 'orthogonal' && joints.length === 0) {
      const autoPoints = buildOrthogonalWaypoints(anchors.start, fromNode, anchors.end, toNode)
        .map(point => ({ type: 'auto', point }));
      return [
        { type: 'endpoint', point: anchors.start },
        ...autoPoints,
        { type: 'endpoint', point: anchors.end },
      ];
    }

    return [
      { type: 'endpoint', point: anchors.start },
      ...joints,
      { type: 'endpoint', point: anchors.end },
    ];
  })();
  const segments = buildSegments(routePoints).map(segment => ({
    ...segment,
    length: segmentLength(segment),
  }));
  const pathData = buildPathData(segments);
  const tangent = getFinalTangent(segments, routePoints);
  const endPoint = routePoints[routePoints.length - 1].point;
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const visibleLength = getVisibleLength(
    segments,
    toNode,
    !!(link.showArrowTip || link.toAnchorSide || link.toAnchorId || (link.toJunctionLinkId && link.toJunctionJointId))
  );
  const jointRenderPoints = routePoints
    .filter(point => point.type !== 'endpoint' && point.type !== 'auto')
    .map(point => ({
      id: point.id,
      x: point.point.x,
      y: point.point.y,
    }));

  const startPoint = routePoints[0].point;
  return {
    pathData,
    routePoints,
    segments,
    jointRenderPoints,
    startPoint,
    endPoint,
    arrowHeadPoints: link.showArrowTip ? getArrowHead(endPoint, tangent) : [endPoint.x, endPoint.y, endPoint.x, endPoint.y, endPoint.x, endPoint.y],
    showArrowTip: !!link.showArrowTip,
    arrowTipMode: link.arrowTipMode ?? 'flow',
    length: totalLength,
    visibleLength,
  };
}

export function getAnimatedArrowHead(renderData, progress) {
  if (!renderData?.showArrowTip) {
    return { points: [0, 0, 0, 0, 0, 0], opacity: 0 };
  }

  const p = clamp(progress, 0, 1);

  if (renderData.arrowTipMode === 'end') {
    const FADE_START = 0.85;
    const raw = p < FADE_START ? 0 : (p - FADE_START) / (1 - FADE_START);
    const opacity = raw * raw * (3 - 2 * raw);
    return {
      points: renderData.arrowHeadPoints,
      opacity,
    };
  }

  const pathLength = renderData.visibleLength ?? renderData.length;
  const dashLength = pathLength + 2;
  const traveledLength = Math.min(dashLength * p, pathLength);
  if (traveledLength < EPSILON) {
    return { points: renderData.arrowHeadPoints, opacity: 0 };
  }
  const { point, tangent } = getPointAndTangentAtLength(renderData.segments, traveledLength);
  return {
    points: getArrowHead(point, tangent, LINK_POINTER_LENGTH, LINK_POINTER_WIDTH),
    opacity: 1,
  };
}

// Utility: get the point (and tangent) along this link's path for a given progress (0..1)
// Optionally uses the visible length (default) to avoid traveling under target nodes.
export function getPointAtProgress(renderData, progress, useVisibleLength = true) {
  if (!renderData) return { point: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
  const p = clamp(progress ?? 0, 0, 1);
  const pathLength = (useVisibleLength ? (renderData.visibleLength ?? renderData.length) : renderData.length) ?? 0;
  const traveled = Math.min(pathLength * p, pathLength);
  return getPointAndTangentAtLength(renderData.segments ?? [], traveled);
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPSILON) {
    return { distance: dist(point, start), projected: { ...start } };
  }

  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq, 0, 1);
  const projected = {
    x: lerp(start.x, end.x, t),
    y: lerp(start.y, end.y, t),
  };

  return {
    distance: dist(point, projected),
    projected,
  };
}

export function createJointForLink(link, fromNode, toNode, canvasPoint, createId, allLinks = [], allNodes = []) {
  const routePoints = getRoutePoints(link, fromNode, toNode, allLinks, allNodes);
  const offset = getLinkParallelOffset(link, fromNode, toNode, allLinks);
  let best = null;

  for (let i = 0; i < routePoints.length - 1; i++) {
    const result = distanceToSegment(canvasPoint, routePoints[i].point, routePoints[i + 1].point);
    if (!best || result.distance < best.distance) {
      best = { ...result, insertAt: i };
    }
  }

  const projected = best?.projected ?? canvasPoint;
  return {
    insertIndex: Math.max(0, best?.insertAt ?? link.joints?.length ?? 0),
    joint: {
      id: createId(),
      x: projected.x - offset.x,
      y: projected.y - offset.y,
      size: 6,
      prevCurve: 0,
      nextCurve: 0,
    },
  };
}
