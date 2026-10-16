import { buildLinkRenderData } from '../links/linkGeometry';

export const MIRROR_PADDING = 18;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getNodeCenter(node) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function getSourceBounds(nodes) {
  if (!nodes.length) return null;
  return {
    minX: Math.min(...nodes.map(node => node.x)),
    minY: Math.min(...nodes.map(node => node.y)),
    maxX: Math.max(...nodes.map(node => node.x + node.width)),
    maxY: Math.max(...nodes.map(node => node.y + node.height)),
  };
}

function getMirrorScale(mirror, bounds) {
  const sourceWidth = Math.max(1, bounds.maxX - bounds.minX);
  const sourceHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(24, mirror.width - MIRROR_PADDING * 2);
  const availableHeight = Math.max(24, mirror.height - MIRROR_PADDING * 2);
  return Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
}

function getMirrorFrameMetrics(mirror, bounds) {
  const sourceWidth = Math.max(1, bounds.maxX - bounds.minX);
  const sourceHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Number.isFinite(mirror.mirrorScale) && mirror.mirrorScale > 0
    ? mirror.mirrorScale
    : getMirrorScale(mirror, bounds);

  return {
    scale,
    sourceWidth,
    sourceHeight,
    frameWidth: Math.max(180, sourceWidth * scale + MIRROR_PADDING * 2),
    frameHeight: Math.max(120, sourceHeight * scale + MIRROR_PADDING * 2),
  };
}

function flipMirrorSide(side) {
  if (side === 'left') return 'right';
  if (side === 'right') return 'left';
  return side;
}

function transformPoint(point, mirror, bounds, scale, mode) {
  const srcCenterX = (bounds.minX + bounds.maxX) / 2;
  const srcCenterY = (bounds.minY + bounds.maxY) / 2;
  const mirrorCenterX = mirror.x + mirror.width / 2;
  const mirrorCenterY = mirror.y + mirror.height / 2;
  const relX = point.x - srcCenterX;
  const relY = point.y - srcCenterY;
  return {
    x: mirrorCenterX + (mode === 'mirror' ? -relX : relX) * scale,
    y: mirrorCenterY + relY * scale,
  };
}

function inverseTransformPoint(point, mirror, bounds, scale, mode) {
  const srcCenterX = (bounds.minX + bounds.maxX) / 2;
  const srcCenterY = (bounds.minY + bounds.maxY) / 2;
  const mirrorCenterX = mirror.x + mirror.width / 2;
  const mirrorCenterY = mirror.y + mirror.height / 2;
  const relX = (point.x - mirrorCenterX) / scale;
  const relY = (point.y - mirrorCenterY) / scale;
  return {
    x: srcCenterX + (mode === 'mirror' ? -relX : relX),
    y: srcCenterY + relY,
  };
}

function transformAnchor(anchor, mode) {
  if (!anchor) return anchor;
  const next = { ...anchor };
  if (mode === 'mirror') {
    next.side = flipMirrorSide(anchor.side);
    if (anchor.side === 'top' || anchor.side === 'bottom') {
      next.along = -(anchor.along ?? 0);
    }
  }
  return next;
}

function transformLinkAnchor(link, keyPrefix, mode) {
  const sideKey = `${keyPrefix}AnchorSide`;
  const alongKey = `${keyPrefix}AlongPos`;
  const centeredKey = `${keyPrefix}AnchorLockedCenter`;
  const next = {
    [sideKey]: link[sideKey],
    [alongKey]: link[alongKey] ?? 0,
    [centeredKey]: link[centeredKey] ?? false,
  };

  if (mode !== 'mirror') return next;
  next[sideKey] = flipMirrorSide(link[sideKey]);
  if (link[sideKey] === 'top' || link[sideKey] === 'bottom') {
    next[alongKey] = -(link[alongKey] ?? 0);
  }
  return next;
}

function getMirrorNodeOverride(mirror, sourceNodeId) {
  return mirror.mirrorNodeOverrides?.[sourceNodeId] ?? {};
}

function getMirrorLinkOverride(mirror, sourceLinkId) {
  return mirror.mirrorLinkOverrides?.[sourceLinkId] ?? {};
}

export function isMirrorNode(node) {
  return node?.type === 'mirror';
}

export function getMirrorSourceItems(mirror, nodes, links) {
  const sourceNodeIds = new Set((mirror.sourceNodeIds ?? []).filter(id => id !== mirror.id));
  const sourceNodes = nodes.filter(node => sourceNodeIds.has(node.id) && !isMirrorNode(node));
  const sourceNodeIdSet = new Set(sourceNodes.map(node => node.id));
  const requestedLinks = new Set(mirror.sourceLinkIds ?? []);
  const sourceLinks = links.filter(link => (
    requestedLinks.has(link.id) ||
    (sourceNodeIdSet.has(link.fromId) && sourceNodeIdSet.has(link.toId))
  ));
  return { sourceNodes, sourceLinks };
}

export function buildMirrorBinding(mirror, nodes, links) {
  if (!isMirrorNode(mirror)) return null;

  const { sourceNodes, sourceLinks } = getMirrorSourceItems(mirror, nodes, links);
  if (!sourceNodes.length) {
    return {
      mirrorId: mirror.id,
      frame: mirror,
      childNodes: [],
      childLinks: [],
      linkRenders: {},
      nodeIdsBySourceId: {},
      linkIdsBySourceId: {},
    };
  }

  const bounds = getSourceBounds(sourceNodes);
  const frameMetrics = getMirrorFrameMetrics(mirror, bounds);
  const scale = frameMetrics.scale;
  const mode = mirror.mirrorMode === 'exact' ? 'exact' : 'mirror';
  const frame = {
    ...mirror,
    width: frameMetrics.frameWidth,
    height: frameMetrics.frameHeight,
  };
  const childNodeBySourceId = {};

  for (const sourceNode of sourceNodes) {
    const sourceCenter = getNodeCenter(sourceNode);
    const transformedCenter = transformPoint(sourceCenter, frame, bounds, scale, mode);
    const override = getMirrorNodeOverride(mirror, sourceNode.id);
    const baseNode = {
      ...sourceNode,
      id: `mirror-node:${mirror.id}:${sourceNode.id}`,
      width: Math.max(24, sourceNode.width * scale),
      height: Math.max(24, sourceNode.height * scale),
      fontSize: Math.max(10, sourceNode.fontSize * scale),
      x: transformedCenter.x - Math.max(24, sourceNode.width * scale) / 2,
      y: transformedCenter.y - Math.max(24, sourceNode.height * scale) / 2,
      fill: override.fill ?? sourceNode.fill,
      stroke: override.stroke ?? sourceNode.stroke,
      textColor: override.textColor ?? sourceNode.textColor,
      label: override.label ?? sourceNode.label,
      type: sourceNode.type,
      shape: sourceNode.shape,
      customShape: sourceNode.customShape,
      textMorphs: sourceNode.textMorphs ?? [],
      triggerAfterLinkId: null,
      anchors: (sourceNode.anchors ?? []).map(anchor => ({
        ...anchor,
        ...transformAnchor(anchor, mode),
      })),
      sourceNodeId: sourceNode.id,
      sourceMirrorId: mirror.id,
    };
    childNodeBySourceId[sourceNode.id] = baseNode;
  }

  const childLinks = sourceLinks
    .filter(link => childNodeBySourceId[link.fromId] && childNodeBySourceId[link.toId])
    .map(sourceLink => {
      const override = getMirrorLinkOverride(mirror, sourceLink.id);
      const baseLink = {
        ...sourceLink,
        id: `mirror-link:${mirror.id}:${sourceLink.id}`,
        fromId: childNodeBySourceId[sourceLink.fromId].id,
        toId: childNodeBySourceId[sourceLink.toId].id,
        joints: (sourceLink.joints ?? []).map(joint => ({
        ...joint,
          ...transformPoint({ x: joint.x, y: joint.y }, frame, bounds, scale, mode),
        })),
        stroke: override.stroke ?? sourceLink.stroke,
        fromAnchorId: sourceLink.fromAnchorId,
        toAnchorId: sourceLink.toAnchorId,
        fromJunctionLinkId: null,
        fromJunctionJointId: null,
        syncGroupKey: null,
        ...transformLinkAnchor(sourceLink, 'from', mode),
        ...transformLinkAnchor(sourceLink, 'to', mode),
        sourceLinkId: sourceLink.id,
        sourceMirrorId: mirror.id,
      };
      return baseLink;
    });

  const childNodes = Object.values(childNodeBySourceId);
  const linkRenders = Object.fromEntries(childLinks.map(link => {
    const fromNode = childNodes.find(node => node.id === link.fromId);
    const toNode = childNodes.find(node => node.id === link.toId);
    return [link.id, buildLinkRenderData(link, fromNode, toNode, childLinks, childNodes)];
  }));

  return {
    mirrorId: mirror.id,
    frame,
    bounds,
    scale,
    sourceWidth: frameMetrics.sourceWidth,
    sourceHeight: frameMetrics.sourceHeight,
    frameWidth: frameMetrics.frameWidth,
    frameHeight: frameMetrics.frameHeight,
    mode,
    sourceNodeMap: Object.fromEntries(sourceNodes.map(node => [node.id, node])),
    sourceLinkMap: Object.fromEntries(sourceLinks.map(link => [link.id, link])),
    childNodes,
    childLinks,
    linkRenders,
    nodeIdsBySourceId: Object.fromEntries(childNodes.map(node => [node.sourceNodeId, node.id])),
    linkIdsBySourceId: Object.fromEntries(childLinks.map(link => [link.sourceLinkId, link.id])),
  };
}

export function buildMirrorBindings(nodes, links) {
  const mirrorNodes = nodes.filter(isMirrorNode);
  const bindings = mirrorNodes.map(mirror => buildMirrorBinding(mirror, nodes, links)).filter(Boolean);
  const nodeIdsBySourceId = {};
  const linkIdsBySourceId = {};
  const linkRenders = {};

  for (const binding of bindings) {
    Object.assign(linkRenders, binding.linkRenders);
    for (const [sourceId, mirrorId] of Object.entries(binding.nodeIdsBySourceId)) {
      if (!nodeIdsBySourceId[sourceId]) nodeIdsBySourceId[sourceId] = [];
      nodeIdsBySourceId[sourceId].push(mirrorId);
    }
    for (const [sourceId, mirrorId] of Object.entries(binding.linkIdsBySourceId)) {
      if (!linkIdsBySourceId[sourceId]) linkIdsBySourceId[sourceId] = [];
      linkIdsBySourceId[sourceId].push(mirrorId);
    }
  }

  return {
    bindings,
    linkRenders,
    nodeIdsBySourceId,
    linkIdsBySourceId,
  };
}

export function getSourceCenterFromMirrorPoint(binding, point) {
  if (!binding?.bounds || !binding?.scale) return point;
  return inverseTransformPoint(point, binding.frame, binding.bounds, binding.scale, binding.mode);
}

export function getMirrorSelectionPayload(selectionIds, nodes, links, mirrorId = null) {
  const selected = new Set(selectionIds ?? []);
  const sourceNodes = nodes.filter(node => selected.has(node.id) && node.id !== mirrorId && !isMirrorNode(node));
  const sourceNodeIds = sourceNodes.map(node => node.id);
  const sourceNodeIdSet = new Set(sourceNodeIds);
  const sourceLinks = links.filter(link =>
    selected.has(link.id) ||
    (sourceNodeIdSet.has(link.fromId) && sourceNodeIdSet.has(link.toId))
  );
  return {
    sourceNodeIds,
    sourceLinkIds: sourceLinks.map(link => link.id),
  };
}

export function getMirrorOverlapPayload(mirror, nodes, links) {
  const minX = mirror.x;
  const minY = mirror.y;
  const maxX = mirror.x + mirror.width;
  const maxY = mirror.y + mirror.height;

  const sourceNodes = nodes.filter(node =>
    node.id !== mirror.id &&
    !isMirrorNode(node) &&
    node.x < maxX &&
    node.x + node.width > minX &&
    node.y < maxY &&
    node.y + node.height > minY
  );
  const sourceNodeIds = sourceNodes.map(node => node.id);
  const sourceNodeIdSet = new Set(sourceNodeIds);
  const sourceLinks = links.filter(link =>
    sourceNodeIdSet.has(link.fromId) && sourceNodeIdSet.has(link.toId)
  );

  return {
    sourceNodeIds,
    sourceLinkIds: sourceLinks.map(link => link.id),
  };
}
