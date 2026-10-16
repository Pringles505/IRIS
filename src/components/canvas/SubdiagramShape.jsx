import React, { useRef, useState } from 'react';
import { Circle, Ellipse, Group, Line, Path, Rect, Text } from 'react-konva';
import { pageColors } from '../../colorThemes';
import { getNodeLabelFrame } from '../../nodeLabelFrame';
import useStore from '../../store/useStore';
import { snapDraggedBox } from './dragSnap';
import NodeStatusMark, { getNodeStatusDash, getNodeStatusStroke, getNodeStatusTextColor } from './NodeStatusMark';
import { getCustomShapeOutline } from '../../shapes/customShape';

const PORT_R = 7;

const PORT_POSITIONS = (w, h) => [
  { x: w / 2, y: 0, side: 'top' },
  { x: w, y: h / 2, side: 'right' },
  { x: w / 2, y: h, side: 'bottom' },
  { x: 0, y: h / 2, side: 'left' },
  { x: w / 2, y: h / 2, side: 'center' },
];

function getSubdiagramTransformStyle(node, resolvedTargetNode) {
  const mode = node.transformMode;
  if (!mode || mode === 'none') return null;
  if (mode === 'existing') {
    if (!resolvedTargetNode) return null;
    return {
      width: resolvedTargetNode.width ?? node.width,
      height: resolvedTargetNode.height ?? node.height,
      shape: resolvedTargetNode.shape ?? 'rounded',
      cornerRadius: resolvedTargetNode.cornerRadius ?? 8,
      fill: resolvedTargetNode.fill ?? node.fill,
      stroke: resolvedTargetNode.stroke ?? node.stroke,
      strokeWidth: resolvedTargetNode.strokeWidth ?? 2,
    };
  }
  if (!node.transformTarget) return null;
  return {
    width: node.transformTarget.width ?? node.width,
    height: node.transformTarget.height ?? node.height,
    shape: node.transformTarget.shape ?? node.shape ?? 'rounded',
    cornerRadius: node.transformTarget.cornerRadius ?? node.cornerRadius ?? 8,
    fill: node.transformTarget.fill ?? node.fill,
    stroke: node.transformTarget.stroke ?? node.stroke,
    strokeWidth: node.transformTarget.strokeWidth ?? 2,
  };
}

function renderSubdiagramHighlight(node, extraProps = {}) {
  if (node.shape === 'diamond' || node.shape === 'hexagon' || node.shape === 'circle' || node.shape === 'pillar' || node.shape === 'cylinder' || node.shape === 'database' || node.shape === 'slanted' || node.shape === 'custom') return null;
  return (
    <Rect
      x={node.shape === 'pill' ? node.height / 2 : (node.cornerRadius ?? 10)}
      y={1}
      width={node.width - (node.shape === 'pill' ? node.height : (node.cornerRadius ?? 10) * 2)}
      height={1}
      fill={pageColors.whiteInnerHighlight}
      listening={false}
      {...extraProps}
    />
  );
}

function renderSubdiagramBody(node, stroke, strokeWidth, fill, shadow = false, extraProps = {}) {
  const common = { stroke, strokeWidth, fill, ...extraProps };

  if (node.shape === 'custom') {
    const outline = getCustomShapeOutline(node.customShape, node.width, node.height);
    if (outline) {
      return <Line points={outline} closed {...common} x={shadow ? 4 : 0} y={shadow ? 4 : 0} />;
    }
  }

  if (node.shape === 'diamond') {
    const points = [
      node.width / 2, 0,
      node.width, node.height / 2,
      node.width / 2, node.height,
      0, node.height / 2,
    ];
    return (
      <Line
        points={points}
        closed
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'hexagon') {
    const inset = Math.min(node.width * 0.24, node.height * 0.5);
    const points = [
      inset, 0,
      node.width - inset, 0,
      node.width, node.height / 2,
      node.width - inset, node.height,
      inset, node.height,
      0, node.height / 2,
    ];
    return (
      <Line
        points={points}
        closed
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'circle') {
    return (
      <Ellipse
        x={node.width / 2 + (shadow ? 4 : 0)}
        y={node.height / 2 + (shadow ? 4 : 0)}
        radiusX={node.width / 2}
        radiusY={node.height / 2}
        {...common}
      />
    );
  }

  if (node.shape === 'pillar' || node.shape === 'cylinder' || node.shape === 'database') {
    const w = node.width;
    const h = node.height;
    const curve = Math.min(w, h) * 0.12;
    const pathData = [
      `M ${curve},0`,
      `L ${w - curve},0`,
      `Q ${w - curve * 0.2},${h / 2} ${w - curve},${h}`,
      `L ${curve},${h}`,
      `Q ${curve * 0.2},${h / 2} ${curve},0`,
      'Z',
    ].join(' ');
    return (
      <Path
        data={pathData}
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  if (node.shape === 'slanted') {
    const inset = Math.min(node.width * 0.18, node.height * 0.42);
    const points = [
      inset, 0,
      node.width, 0,
      node.width - inset, node.height,
      0, node.height,
    ];
    return (
      <Line
        points={points}
        closed
        {...common}
        x={shadow ? 4 : 0}
        y={shadow ? 4 : 0}
      />
    );
  }

  const cornerRadius = node.shape === 'pill'
    ? Math.min(node.width, node.height) / 2
    : (node.cornerRadius ?? 10);

  return (
    <Rect
      x={shadow ? 4 : 0}
      y={shadow ? 4 : 0}
      width={node.width}
      height={node.height}
      cornerRadius={cornerRadius}
      {...common}
    />
  );
}

function SubdiagramShape({
  node,
  isSelected,
  isInSelection,
  onSelect,
  onStartLink,
  onEndLink,
  onContextMenu,
  isLinking,
  onGroupDragStart,
  onGroupDragMove,
  onExpand,
  renderEditorChrome = true,
}) {
  const {
    updateNode,
    setAlignmentGuides,
  } = useStore();
  const [hovered, setHovered] = useState(false);
  const dragStartPosRef = useRef(null);
  const transformTargetNodeId = node.transformMode === 'existing' ? node.transformTargetNodeId : null;
  const transformTargetNode = useStore(state =>
    transformTargetNodeId
      ? (state.nodes.find(n =>
          n.id === transformTargetNodeId &&
          n.id !== node.id &&
          n.type !== 'area' && n.type !== 'mirror' && n.type !== 'text'
        ) ?? null)
      : null
  );

  const w = node.width ?? 190;
  const h = node.height ?? 72;
  const cx = node.x + w / 2;
  const cy = node.y + h / 2;
  const editorHovered = renderEditorChrome && hovered;
  const showPorts = renderEditorChrome && (isSelected || hovered || isLinking);
  const ports = PORT_POSITIONS(w, h);
  const labelFrame = getNodeLabelFrame(node, { reserveBottomRightBadge: node.showSubBadge ?? true });
  const transformStyle = node.transformMode && node.transformMode !== 'none'
    ? getSubdiagramTransformStyle(node, transformTargetNode)
    : null;

  const borderColor = isSelected
    ? pageColors.blueSelection
    : isInSelection
      ? pageColors.purpleAccent
        : (node.failing || node.offline)
          ? getNodeStatusStroke(node, node.stroke ?? pageColors.blueNodeStroke)
          : editorHovered
        ? pageColors.blueLink
        : (node.stroke ?? pageColors.blueNodeStroke);

  const applyDraggedPosition = (target, nextPos) => {
    target.x(nextPos.x + w / 2);
    target.y(nextPos.y + h / 2);
  };

  const handleDragStart = (e) => {
    e.cancelBubble = true;
    if (!isSelected && !isInSelection) onSelect(false);
    setAlignmentGuides?.([]);
    dragStartPosRef.current = { x: node.x, y: node.y };
    onGroupDragStart?.(node.id);
  };

  const handleDragMove = (e) => {
    const raw = {
      id: node.id,
      x: e.target.x() - w / 2,
      y: e.target.y() - h / 2,
      width: w,
      height: h,
    };
    const { x, y, guides } = snapDraggedBox(raw, e, dragStartPosRef.current);
    const nextPos = { x, y };

    setAlignmentGuides(guides);
    applyDraggedPosition(e.target, nextPos);
    updateNode(node.id, { x: nextPos.x, y: nextPos.y });

    if (dragStartPosRef.current) {
      onGroupDragMove?.(node.id, nextPos.x - dragStartPosRef.current.x, nextPos.y - dragStartPosRef.current.y);
    }
  };

  const handleDragEnd = (e) => {
    setAlignmentGuides([]);
    dragStartPosRef.current = null;
    updateNode(node.id, {
      x: e.target.x() - w / 2,
      y: e.target.y() - h / 2,
    });
  };

  return (
    <Group
      id={`node-${node.id}`}
      x={cx}
      y={cy}
      offsetX={w / 2}
      offsetY={h / 2}
      draggable={!isLinking}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onClick={(e) => { e.cancelBubble = true; onSelect(e.evt?.shiftKey); }}
      onTap={(e) => { e.cancelBubble = true; onSelect(false); }}
      onDblClick={(e) => { e.cancelBubble = true; onExpand?.(); }}
      onDblTap={(e) => { e.cancelBubble = true; onExpand?.(); }}
      onContextMenu={(e) => { e.cancelBubble = true; onSelect(false); onContextMenu?.(e, node.id); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseUp={(e) => { if (isLinking) { e.cancelBubble = true; onEndLink?.(node.id, null); } }}
    >
      {renderEditorChrome && (
        <Rect width={w} height={h} fill={pageColors.blackHitArea} />
      )}
      {renderSubdiagramBody(
        node,
        borderColor,
        isSelected ? 3 : 2,
        node.fill ?? pageColors.uiRaised,
        false,
        {
          id: `node-body-${node.id}`,
          baseFill: node.fill ?? pageColors.uiRaised,
          baseStroke: getNodeStatusStroke(node, node.stroke ?? pageColors.blueNodeStroke),
          baseStrokeWidth: isSelected ? 3 : 2,
          ...(node.offline ? { dash: getNodeStatusDash(node), dashEnabled: true } : {}),
        }
      )}

      {transformStyle && (() => {
        const pseudoNode = {
          ...node,
          width: transformStyle.width ?? w,
          height: transformStyle.height ?? h,
          shape: transformStyle.shape,
          cornerRadius: transformStyle.cornerRadius,
        };
        const dx = (w - (pseudoNode.width ?? w)) / 2;
        const dy = (h - (pseudoNode.height ?? h)) / 2;
        return (
          <Group x={dx} y={dy} listening={false}>
            {renderSubdiagramBody(
              pseudoNode,
              transformStyle.stroke,
              transformStyle.strokeWidth ?? 2,
              transformStyle.fill,
              false,
              { id: `node-body-transform-${node.id}`, opacity: 0 }
            )}
            {renderSubdiagramHighlight(pseudoNode, { id: `node-highlight-transform-${node.id}`, opacity: 0 })}
          </Group>
        );
      })()}

      {renderSubdiagramHighlight(node, { id: `node-highlight-${node.id}` })}

      {(node.showSubBadge ?? true) && (
        <>
          <Rect
            id={`node-sub-badge-bg-${node.id}`}
            baseOpacity={1}
            x={w - 48}
            y={h - 24}
            width={38}
            height={16}
            cornerRadius={999}
            fill={pageColors.purpleSurfacePanel}
            stroke={pageColors.purpleBorderSoft}
            strokeWidth={1}
            listening={false}
          />
          <Text
            id={`node-sub-badge-text-${node.id}`}
            baseOpacity={1}
            x={w - 48}
            y={h - 24}
            width={38}
            height={16}
            text="SUB"
            align="center"
            verticalAlign="middle"
            fontSize={8}
            fill={pageColors.purpleAccent}
            fontFamily="Inter, system-ui, sans-serif"
            fontStyle="700"
            letterSpacing={0.5}
            listening={false}
          />
        </>
      )}

      <Text
        id={`node-label-${node.id}`}
        baseText={node.label ?? 'Sub-diagram'}
        x={labelFrame.x}
        y={labelFrame.y}
        width={labelFrame.width}
        height={labelFrame.height}
        text={node.label ?? 'Sub-diagram'}
        align="center"
        verticalAlign="middle"
        fontSize={node.fontSize ?? 13}
        fill={getNodeStatusTextColor(node, node.textColor ?? pageColors.textMain)}
        baseFill={getNodeStatusTextColor(node, node.textColor ?? pageColors.textMain)}
        fontFamily="Inter, system-ui, sans-serif"
        fontStyle={node.bold ? '700' : '500'}
        listening={false}
      />

      <Text
        id={`node-label-morph-${node.id}`}
        x={labelFrame.x}
        y={labelFrame.y}
        width={labelFrame.width}
        height={labelFrame.height}
        text=""
        align="center"
        verticalAlign="middle"
        fontSize={node.fontSize ?? 13}
        fill={getNodeStatusTextColor(node, node.textColor ?? pageColors.textMain)}
        baseFill={getNodeStatusTextColor(node, node.textColor ?? pageColors.textMain)}
        fontFamily="Inter, system-ui, sans-serif"
        opacity={0}
        listening={false}
      />

      <NodeStatusMark node={node} />

      {showPorts && ports.map((port, index) => {
        const isCenter = port.side === 'center';
        return (
          <Circle
            key={index}
            x={port.x}
            y={port.y}
            radius={isCenter ? PORT_R - 2 : PORT_R}
            fill={isCenter ? pageColors.transparent : pageColors.blueMain}
            stroke={pageColors.blueSelection}
            strokeWidth={isCenter ? 1.5 : 2}
            dash={isCenter ? [3, 2] : undefined}
            onMouseDown={(e) => {
              e.cancelBubble = true;
              onStartLink?.(node.id, { side: port.side, along: 0, anchorId: null, centered: port.side !== 'center' });
            }}
            onMouseUp={(e) => {
              e.cancelBubble = true;
              onEndLink?.(node.id, { side: port.side, along: 0, anchorId: null, centered: port.side !== 'center' });
            }}
            onMouseEnter={(e) => { e.target.getStage().container().style.cursor = 'crosshair'; }}
            onMouseLeave={(e) => { e.target.getStage().container().style.cursor = 'default'; }}
          />
        );
      })}
    </Group>
  );
}

export default SubdiagramShape;
