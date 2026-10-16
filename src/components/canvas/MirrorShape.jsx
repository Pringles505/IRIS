import React, { useRef, useState } from 'react';
import { Circle, Ellipse, Group, Line, Path, Rect, Text } from 'react-konva';
import { pageColors, withAlpha } from '../../colorThemes';
import { getNodeLabelFrame } from '../../nodeLabelFrame';
import useStore from '../../store/useStore';
import { getSourceCenterFromMirrorPoint } from '../../mirror/mirrorData';
import { getNodeDisplayText, getNodeTextFontFamily } from '../../text/equationText';
import { snapDraggedBox } from './dragSnap';
import NodeStatusMark, { getNodeStatusDash, getNodeStatusStroke, getNodeStatusTextColor } from './NodeStatusMark';
import LinkFailureMark from './LinkFailureMark';
import { getCustomShapeOutline } from '../../shapes/customShape';
import { getLinkFailureStyle } from '../../animation/nodeFailureStyle';

const PORT_R = 7;
const PORT_POSITIONS = (w, h) => [
  { x: w / 2, y: 0, side: 'top' },
  { x: w, y: h / 2, side: 'right' },
  { x: w / 2, y: h, side: 'bottom' },
  { x: 0, y: h / 2, side: 'left' },
  { x: w / 2, y: h / 2, side: 'center' },
];

function renderNodeBody(node, stroke, strokeWidth, fill) {
  const common = {
    stroke: getNodeStatusStroke(node, stroke),
    strokeWidth,
    fill,
    dash: getNodeStatusDash(node),
    dashEnabled: !!node.offline,
  };

  if (node.shape === 'custom') {
    const outline = getCustomShapeOutline(node.customShape, node.width, node.height);
    if (outline) return <Line points={outline} closed {...common} />;
  }

  if (node.shape === 'diamond') {
    return (
      <Line
        points={[
          node.width / 2, 0,
          node.width, node.height / 2,
          node.width / 2, node.height,
          0, node.height / 2,
        ]}
        closed
        {...common}
      />
    );
  }

  if (node.shape === 'hexagon') {
    const inset = Math.min(node.width * 0.24, node.height * 0.5);
    return (
      <Line
        points={[
          inset, 0,
          node.width - inset, 0,
          node.width, node.height / 2,
          node.width - inset, node.height,
          inset, node.height,
          0, node.height / 2,
        ]}
        closed
        {...common}
      />
    );
  }

  if (node.shape === 'circle') {
    return (
      <Ellipse
        x={node.width / 2}
        y={node.height / 2}
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
    return <Path data={pathData} {...common} />;
  }

  if (node.shape === 'slanted') {
    const inset = Math.min(node.width * 0.18, node.height * 0.42);
    return (
      <Line
        points={[
          inset, 0,
          node.width, 0,
          node.width - inset, node.height,
          0, node.height,
        ]}
        closed
        {...common}
      />
    );
  }

  const cornerRadius = node.shape === 'pill'
    ? Math.min(node.width, node.height) / 2
    : node.cornerRadius;

  return (
    <Rect
      width={node.width}
      height={node.height}
      cornerRadius={cornerRadius}
      {...common}
    />
  );
}

function MirrorChildNode({
  node,
  sourceNode,
  binding,
  isSelected,
  isInSelection,
  isLinking,
  onSelectSourceNode,
  onSourceNodeContextMenu,
  onMirrorNodeRename,
  onStartSourceLink,
  onEndSourceLink,
  onGroupDragStart,
  onGroupDragMove,
  renderEditorChrome = true,
}) {
  const { updateNode } = useStore();
  const isTextNode = node.type === 'text';
  const labelFrame = getNodeLabelFrame(node);
  const [hovered, setHovered] = useState(false);
  const dragStartRef = useRef(null);

  const commitSourcePosition = (targetX, targetY) => {
    const sourceCenter = getSourceCenterFromMirrorPoint(binding, {
      x: targetX + node.width / 2,
      y: targetY + node.height / 2,
    });
    const nextSourcePos = {
      x: sourceCenter.x - sourceNode.width / 2,
      y: sourceCenter.y - sourceNode.height / 2,
    };
    updateNode(sourceNode.id, nextSourcePos);
    return nextSourcePos;
  };

  const showPorts = renderEditorChrome && (isSelected || isInSelection || hovered || isLinking);
  const ports = PORT_POSITIONS(node.width, node.height);

  return (
    <Group
      id={`node-${node.id}`}
      x={node.x + node.width / 2}
      y={node.y + node.height / 2}
      offsetX={node.width / 2}
      offsetY={node.height / 2}
      draggable={!isLinking}
      onDragStart={(e) => {
        e.cancelBubble = true;
        dragStartRef.current = { x: sourceNode.x, y: sourceNode.y };
        onSelectSourceNode?.(sourceNode.id, false);
        onGroupDragStart?.(sourceNode.id);
      }}
      onDragMove={(e) => {
        e.cancelBubble = true;
        const nextSourcePos = commitSourcePosition(e.target.x() - node.width / 2, e.target.y() - node.height / 2);
        if (dragStartRef.current && isInSelection) {
          onGroupDragMove?.(
            sourceNode.id,
            nextSourcePos.x - dragStartRef.current.x,
            nextSourcePos.y - dragStartRef.current.y
          );
        }
      }}
      onDragEnd={(e) => {
        e.cancelBubble = true;
        commitSourcePosition(e.target.x() - node.width / 2, e.target.y() - node.height / 2);
        dragStartRef.current = null;
      }}
      onClick={(e) => {
        e.cancelBubble = true;
        onSelectSourceNode?.(sourceNode.id, e.evt?.shiftKey);
      }}
      onTap={(e) => {
        e.cancelBubble = true;
        onSelectSourceNode?.(sourceNode.id, false);
      }}
      onDblClick={(e) => {
        e.cancelBubble = true;
        onSelectSourceNode?.(sourceNode.id, false);
        onMirrorNodeRename?.(binding.mirrorId, sourceNode.id, node);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseUp={(e) => {
        if (isLinking) { e.cancelBubble = true; onEndSourceLink?.(node.id, null); }
      }}
      onContextMenu={(e) => {
        e.cancelBubble = true;
        onSelectSourceNode?.(sourceNode.id, false);
        onSourceNodeContextMenu?.(e, sourceNode.id);
      }}
    >
      {!isTextNode && renderNodeBody(node, node.stroke, node.strokeWidth, node.fill)}
      {isTextNode && (
        <Rect
          width={node.width}
          height={node.height}
          cornerRadius={6}
          stroke={getNodeStatusStroke(node, withAlpha(node.textColor, 0.2))}
          strokeWidth={1}
          dash={[5, 4]}
          opacity={0.4}
          listening={false}
        />
      )}
      {isTextNode && showPorts && (
        <Rect
          width={node.width}
          height={node.height}
          cornerRadius={6}
          stroke={isSelected ? pageColors.blueSelection : pageColors.purpleAccent}
          strokeWidth={1}
          dash={[5, 4]}
          opacity={0.35}
          listening={false}
        />
      )}
      <Text
        id={`node-label-${node.id}`}
        baseText={node.label}
        equationMode={!!node.equationMode}
        independentText
        x={labelFrame.x}
        y={labelFrame.y}
        width={labelFrame.width}
        height={labelFrame.height}
        text={getNodeDisplayText(node)}
        align="center"
        verticalAlign="middle"
        fontSize={node.fontSize}
        fill={getNodeStatusTextColor(node, node.textColor)}
        fontFamily={getNodeTextFontFamily(node)}
        fontStyle={node.bold ? '700' : '500'}
        listening={false}
      />
      <Text
        id={`node-label-morph-${node.id}`}
        independentText
        equationMode={!!node.equationMode}
        x={labelFrame.x}
        y={labelFrame.y}
        width={labelFrame.width}
        height={labelFrame.height}
        text=""
        align="center"
        verticalAlign="middle"
        fontSize={node.fontSize}
        fill={getNodeStatusTextColor(node, node.textColor)}
        fontFamily={getNodeTextFontFamily(node)}
        fontStyle={node.bold ? '700' : '500'}
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
              onStartSourceLink?.(node.id, { side: port.side, along: 0, anchorId: null, centered: port.side !== 'center' });
            }}
            onMouseUp={(e) => {
              e.cancelBubble = true;
              onEndSourceLink?.(node.id, { side: port.side, along: 0, anchorId: null, centered: port.side !== 'center' });
            }}
            onMouseEnter={e => { e.target.getStage().container().style.cursor = 'crosshair'; }}
            onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
          />
        );
      })}
    </Group>
  );
}

function MirrorShape({
  mirror,
  binding,
  isSelected,
  isInSelection,
  onSelect,
  onContextMenu,
  onGroupDragStart,
  onGroupDragMove,
  onSelectSourceNode,
  onSelectSourceLink,
  onSourceNodeContextMenu,
  onSourceLinkContextMenu,
  onMirrorNodeRename,
  onStartSourceLink,
  onEndSourceLink,
  selectedSourceId,
  selectedSourceIds,
  isLinking,
  onResizeMirror,
  onSourceGroupDragStart,
  onSourceGroupDragMove,
  renderEditorChrome = true,
}) {
  const {
    updateNode,
    setAlignmentGuides,
  } = useStore();
  const dragStartPosRef = useRef(null);

  const frameWidth = binding.frameWidth ?? mirror.width;
  const frameHeight = binding.frameHeight ?? mirror.height;

  const handleDragStart = (e) => {
    setAlignmentGuides([]);
    e.cancelBubble = true;
    if (!isSelected && !isInSelection) {
      onSelect(false);
    }
    dragStartPosRef.current = { x: mirror.x, y: mirror.y };
    onGroupDragStart?.(mirror.id);
  };

  const handleDragMove = (e) => {
    const raw = {
      id: mirror.id,
      x: e.target.x() - frameWidth / 2,
      y: e.target.y() - frameHeight / 2,
      width: frameWidth,
      height: frameHeight,
    };
    const { x, y, guides } = snapDraggedBox(raw, e, dragStartPosRef.current);
    const nextPos = { x, y };

    setAlignmentGuides(guides);
    e.target.x(nextPos.x + frameWidth / 2);
    e.target.y(nextPos.y + frameHeight / 2);
    updateNode(mirror.id, { x: nextPos.x, y: nextPos.y });

    if (dragStartPosRef.current) {
      onGroupDragMove?.(mirror.id, nextPos.x - dragStartPosRef.current.x, nextPos.y - dragStartPosRef.current.y);
    }
  };

  const handleDragEnd = (e) => {
    setAlignmentGuides([]);
    updateNode(mirror.id, {
      x: e.target.x() - frameWidth / 2,
      y: e.target.y() - frameHeight / 2,
    });
  };

  return (
    <Group>
      <Group
        id={`node-${mirror.id}`}
        x={mirror.x + frameWidth / 2}
        y={mirror.y + frameHeight / 2}
        offsetX={frameWidth / 2}
        offsetY={frameHeight / 2}
        draggable
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onClick={(e) => { e.cancelBubble = true; onSelect(e.evt?.shiftKey); }}
        onTap={(e) => { e.cancelBubble = true; onSelect(false); }}
        onContextMenu={(e) => {
          e.cancelBubble = true;
          onSelect(false);
          onContextMenu?.(e, mirror.id);
        }}
      >
        {renderEditorChrome && (
          <Rect width={frameWidth} height={frameHeight} fill={pageColors.blackHitArea} />
        )}
        <Group id={`mirror-chrome-${mirror.id}`}>
          <Rect
            width={frameWidth}
            height={frameHeight}
            cornerRadius={mirror.cornerRadius ?? 12}
            fill={withAlpha(pageColors.purpleAccent, 0.05)}
            stroke={isSelected ? pageColors.blueSelection : isInSelection ? pageColors.purpleAccent : mirror.stroke}
            strokeWidth={isSelected ? mirror.strokeWidth + 1 : mirror.strokeWidth}
            dash={[10, 6]}
          />
          <Text
            x={12}
            y={10}
            text={mirror.mirrorMode === 'exact' ? 'Mirror · Exact' : 'Mirror · Flipped'}
            fontSize={11}
            fontStyle="600"
            fill={pageColors.textMuted}
            listening={false}
          />
          <Group
            x={frameWidth}
            y={frameHeight}
            draggable
            onMouseDown={(e) => { e.cancelBubble = true; }}
            onTouchStart={(e) => { e.cancelBubble = true; }}
            onDragStart={(e) => { e.cancelBubble = true; }}
            onDragMove={(e) => {
              e.cancelBubble = true;
              const nextWidth = Math.max(180, e.target.x());
              const nextHeight = Math.max(120, e.target.y());
              onResizeMirror?.(mirror.id, nextWidth, nextHeight, binding);
            }}
            onDragEnd={(e) => {
              e.cancelBubble = true;
              const nextWidth = Math.max(180, e.target.x());
              const nextHeight = Math.max(120, e.target.y());
              onResizeMirror?.(mirror.id, nextWidth, nextHeight, binding);
            }}
          >
            <Rect x={-8} y={-8} width={16} height={16} fill={pageColors.blackHitArea} />
            <Rect
              x={-5}
              y={-5}
              width={10}
              height={10}
              cornerRadius={2}
              fill={pageColors.blueMain}
              stroke={pageColors.blueSelection}
              strokeWidth={1.5}
            />
          </Group>
        </Group>
      </Group>

      <Group clipX={mirror.x + 8} clipY={mirror.y + 8} clipWidth={Math.max(0, frameWidth - 16)} clipHeight={Math.max(0, frameHeight - 16)}>
        {binding.childLinks.map((link) => {
          const render = binding.linkRenders[link.id];
          if (!render) return null;
          const linkFailStyle = getLinkFailureStyle(link);
          const linkColor = link.failing && linkFailStyle.tint ? linkFailStyle.color : link.stroke;
          return (
            <Group
              key={link.id}
              onClick={(e) => {
                e.cancelBubble = true;
                onSelectSourceLink?.(link.sourceLinkId, e.evt?.shiftKey);
              }}
              onTap={(e) => {
                e.cancelBubble = true;
                onSelectSourceLink?.(link.sourceLinkId, false);
              }}
              onContextMenu={(e) => {
                e.cancelBubble = true;
                onSelectSourceLink?.(link.sourceLinkId, false);
                onSourceLinkContextMenu?.(e, link.sourceLinkId);
              }}
            >
              <Path
                data={render.pathData}
                stroke={pageColors.blackHitArea}
                strokeWidth={Math.max(14, link.strokeWidth + 12)}
                lineCap="round"
                lineJoin="round"
              />
              <Path
                id={`link-shaft-${link.id}`}
                data={render.pathData}
                stroke={linkColor}
                baseStroke={linkColor}
                strokeWidth={link.strokeWidth}
                lineCap="round"
                lineJoin="round"
                listening={false}
              />
              <Path
                id={`link-shaft-fail-overlay-${link.id}`}
                data={render.pathData}
                stroke={pageColors.dangerBright}
                strokeWidth={link.strokeWidth}
                lineCap="round"
                lineJoin="round"
                opacity={0}
                listening={false}
              />
              <Line
                id={`link-head-${link.id}`}
                points={render.arrowHeadPoints}
                basePoints={render.arrowHeadPoints}
                showTip={render.showArrowTip && !link.failing}
                closed
                fill={linkColor}
                stroke={linkColor}
                strokeWidth={1}
                opacity={render.showArrowTip && !link.failing ? 1 : 0}
                listening={false}
              />
              <LinkFailureMark link={link} render={render} />
            </Group>
          );
        })}
        {binding.childNodes.map(node => (
          <MirrorChildNode
            key={node.id}
            node={node}
            sourceNode={binding.sourceNodeMap?.[node.sourceNodeId] ?? {
              id: node.sourceNodeId,
              width: node.width,
              height: node.height,
            }}
            binding={binding}
            isSelected={selectedSourceId === node.sourceNodeId}
            isInSelection={(selectedSourceIds ?? []).includes(node.sourceNodeId)}
            isLinking={isLinking}
            onSelectSourceNode={onSelectSourceNode}
            onSourceNodeContextMenu={onSourceNodeContextMenu}
            onMirrorNodeRename={onMirrorNodeRename}
            onStartSourceLink={onStartSourceLink}
            onEndSourceLink={onEndSourceLink}
            onGroupDragStart={onSourceGroupDragStart}
            onGroupDragMove={onSourceGroupDragMove}
            renderEditorChrome={renderEditorChrome}
          />
        ))}
      </Group>
    </Group>
  );
}

export default MirrorShape;
