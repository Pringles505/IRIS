import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Ellipse, Group, Layer, Line, Path, Rect, Stage, Text } from 'react-konva';
import { pageColors, withAlpha } from '../colorThemes';
import { getNodeLabelFrame } from '../nodeLabelFrame';
import { AnimationEngine } from '../animation/AnimationEngine';
import { applyAnimState, computeLinkRenders } from '../animation/applyAnimState';
import { computeManualTokenTimingByLinkId, getManualTokenBaseText, normalizeManualTokenTextKeyframes } from '../animation/manualTokenTiming';
import { buildLinkRenderData } from '../links/linkGeometry';
import { buildWebByLinkId } from '../variables/flow';
import useStore from '../store/useStore';
import { getNodeDisplayText, getNodeTextFontFamily } from '../text/equationText';
import NodeStatusMark, { getNodeStatusDash, getNodeStatusStroke, getNodeStatusTextColor } from './canvas/NodeStatusMark';
import LinkFailureMark from './canvas/LinkFailureMark';
import { getCustomShapeOutline } from '../shapes/customShape';
import { getLinkFailureStyle } from '../animation/nodeFailureStyle';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updatePreference);
      return () => mediaQuery.removeEventListener('change', updatePreference);
    }

    mediaQuery.addListener(updatePreference);
    return () => mediaQuery.removeListener(updatePreference);
  }, []);

  return prefersReducedMotion;
}

// ── Minimal read-only shape renderers ─────────────────────────────────────────

function renderBodyShape(node, extraProps = {}) {
  const { width: w, height: h, shape, cornerRadius, fill, stroke, strokeWidth } = node;
  const props = {
    fill: fill ?? pageColors.blueNodeFill,
    stroke: getNodeStatusStroke(node, stroke ?? pageColors.blueNodeStroke),
    strokeWidth: strokeWidth ?? 2,
    dash: getNodeStatusDash(node),
    dashEnabled: !!node.offline,
    listening: false,
    ...extraProps,
  };

  if (shape === 'custom') {
    const outline = getCustomShapeOutline(node.customShape, w, h);
    if (outline) return <Line points={outline} closed {...props} />;
  }
  if (shape === 'diamond') {
    return <Line points={[w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]} closed {...props} />;
  }
  if (shape === 'hexagon') {
    const inset = Math.min(w * 0.24, h * 0.5);
    return <Line points={[inset, 0, w - inset, 0, w, h / 2, w - inset, h, inset, h, 0, h / 2]} closed {...props} />;
  }
  if (shape === 'circle') {
    return <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} {...props} />;
  }
  if (shape === 'pillar' || shape === 'cylinder' || shape === 'database') {
    const curve = Math.min(w, h) * 0.12;
    const pathData = [
      `M ${curve},0`,
      `L ${w - curve},0`,
      `Q ${w - curve * 0.2},${h / 2} ${w - curve},${h}`,
      `L ${curve},${h}`,
      `Q ${curve * 0.2},${h / 2} ${curve},0`,
      'Z',
    ].join(' ');
    return <Path data={pathData} {...props} />;
  }
  if (shape === 'slanted') {
    const inset = Math.min(w * 0.18, h * 0.42);
    return <Line points={[inset, 0, w, 0, w - inset, h, 0, h]} closed {...props} />;
  }
  const cr = shape === 'pill' ? Math.min(w, h) / 2 : (cornerRadius ?? 8);
  return <Rect width={w} height={h} cornerRadius={cr} {...props} />;
}

// Thin top-edge highlight stripe — matches NodeShape/SubdiagramShape's renderNodeHighlight.
function renderHighlight(node, extraProps = {}) {
  const { width: w, height: h, shape, cornerRadius } = node;
  if (shape === 'diamond' || shape === 'hexagon' || shape === 'circle' || shape === 'pillar' || shape === 'cylinder' || shape === 'database' || shape === 'slanted' || shape === 'custom') return null;
  const inset = shape === 'pill' ? h / 2 : (cornerRadius ?? 8);
  return (
    <Rect
      x={inset}
      y={1}
      width={Math.max(0, w - inset * 2)}
      height={1}
      fill={pageColors.whiteInnerHighlight}
      listening={false}
      {...extraProps}
    />
  );
}

// Derive transform target style from snapshot data (no store access needed).
function getReadonlyTransformStyle(node, allNodes) {
  const mode = node.transformMode;
  if (!mode || mode === 'none') return null;
  if (mode === 'existing') {
    const target = allNodes?.find(n =>
      n.id === node.transformTargetNodeId &&
      n.id !== node.id &&
      n.type !== 'area' && n.type !== 'mirror' && n.type !== 'text'
    ) ?? null;
    if (!target) return null;
    return {
      width: target.width ?? node.width,
      height: target.height ?? node.height,
      shape: target.shape ?? 'rounded',
      cornerRadius: target.cornerRadius ?? 8,
      fill: target.fill ?? node.fill,
      stroke: target.stroke ?? node.stroke,
      strokeWidth: target.strokeWidth ?? 2,
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

function ReadonlyNodeShape({ node, allNodes }) {
  const w = node.width ?? 150;
  const h = node.height ?? 52;
  const cx = node.x + w / 2;
  const cy = node.y + h / 2;
  const isText = node.type === 'text';
  const isArea = node.type === 'area';
  const isSubdiagram = node.type === 'subdiagram';
  const labelFrame = getNodeLabelFrame(node, {
    reserveBottomRightBadge: isSubdiagram && !isText && (node.showSubBadge ?? true),
  });
  const transformStyle = (!isText && !isArea)
    ? getReadonlyTransformStyle(node, allNodes)
    : null;

  if (isArea) {
    return (
      <Group id={`node-${node.id}`} x={node.x} y={node.y} listening={false}>
        <Rect
          id={`area-rect-${node.id}`}
          baseWidth={w}
          baseHeight={h}
          areaAnimMode={node.areaAnimMode ?? 'fade'}
          width={w}
          height={h}
          fill={node.fill ?? withAlpha(pageColors.purpleAccent, 0.07)}
          stroke={node.stroke ?? pageColors.purpleAccent}
          strokeWidth={node.strokeWidth ?? 1.5}
          cornerRadius={node.cornerRadius ?? 12}
          dash={[10, 6]}
          dashEnabled
          listening={false}
        />
        <Text
          id={`area-label-${node.id}`}
          x={16}
          y={14}
          text={node.label ?? ''}
          fontSize={node.fontSize ?? 12}
          fill={node.textColor ?? node.stroke ?? pageColors.purpleAccent}
          fontFamily="Inter, system-ui, sans-serif"
          fontStyle="600"
          listening={false}
        />
      </Group>
    );
  }

  return (
    <Group
      id={`node-${node.id}`}
      x={cx}
      y={cy}
      offsetX={w / 2}
      offsetY={h / 2}
      listening={false}
    >
      {!isText && renderBodyShape(node, {
        id: `node-body-${node.id}`,
        baseFill: node.fill ?? pageColors.blueNodeFill,
        baseStroke: node.stroke ?? pageColors.blueNodeStroke,
        baseStrokeWidth: node.strokeWidth ?? 2,
      })}

      {/* Transform target body + highlight — hidden until applyAnimState cross-fades them in */}
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
            {renderBodyShape(pseudoNode, {
              id: `node-body-transform-${node.id}`,
              fill: transformStyle.fill,
              stroke: transformStyle.stroke,
              strokeWidth: transformStyle.strokeWidth ?? 2,
              opacity: 0,
            })}
            {renderHighlight(pseudoNode, { id: `node-highlight-transform-${node.id}`, opacity: 0 })}
          </Group>
        );
      })()}

      {/* Failure tint overlay: above both base and transform bodies, below label */}
      {!isText && renderBodyShape(node, {
        id: `node-fail-tint-${node.id}`,
        fill: pageColors.dangerSurfaceSoft,
        stroke: pageColors.transparent,
        strokeWidth: 0,
        opacity: node.failing ? 1 : 0,
        listening: false,
      })}

      {/* Highlight stripe on the original body */}
      {!isText && renderHighlight(node, { id: `node-highlight-${node.id}` })}

      <Text
        id={`node-label-${node.id}`}
        baseText={node.label ?? ''}
        equationMode={!!node.equationMode}
        x={labelFrame.x}
        y={labelFrame.y}
        width={labelFrame.width}
        height={labelFrame.height}
        text={getNodeDisplayText(node)}
        align="center"
        verticalAlign="middle"
        fontSize={node.fontSize ?? 13}
        fill={getNodeStatusTextColor(node, node.textColor ?? pageColors.white)}
        baseFill={getNodeStatusTextColor(node, node.textColor ?? pageColors.white)}
        fontFamily={getNodeTextFontFamily(node)}
        fontStyle={node.bold ? '700' : '500'}
        listening={false}
      />

      <Text
        id={`node-label-morph-${node.id}`}
        equationMode={!!node.equationMode}
        x={labelFrame.x}
        y={labelFrame.y}
        width={labelFrame.width}
        height={labelFrame.height}
        text=""
        align="center"
        verticalAlign="middle"
        fontSize={node.fontSize ?? 13}
        fill={getNodeStatusTextColor(node, node.textColor ?? pageColors.white)}
        baseFill={getNodeStatusTextColor(node, node.textColor ?? pageColors.white)}
        fontFamily={getNodeTextFontFamily(node)}
        fontStyle={node.bold ? '700' : '500'}
        opacity={0}
        listening={false}
      />

      <NodeStatusMark node={node} />

      {isSubdiagram && !isText && (node.showSubBadge ?? true) && (
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
    </Group>
  );
}

function ReadonlyLinkShape({ link, fromNode, toNode, allNodes, allLinks }) {
  const render = useMemo(
    () => buildLinkRenderData(link, fromNode, toNode, allLinks, allNodes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [link.id, fromNode?.id, toNode?.id]
  );
  if (!render) return null;

  const isFailing = !!link.failing;
  const failStyle = getLinkFailureStyle(link);
  const color = isFailing && failStyle.tint ? failStyle.color : link.stroke ?? pageColors.blueNodeStroke;
  const sw = link.strokeWidth ?? 2;

  // Simulation options (readonly overlay)
  const simulateOptions = useStore(state => state.simulateOptions);
  const tokenR = Math.max(2, Math.min(24,
    link.manualTokenEnabled && Number.isFinite(link.manualTokenSize)
      ? link.manualTokenSize
      : (simulateOptions?.tokenSize ?? 7)
  ));
  const tokenFill = link.manualTokenEnabled && link.manualTokenColor
    ? link.manualTokenColor
    : (simulateOptions?.tokenFill ?? '#ffffff');
  const tokenStroke = simulateOptions?.tokenStroke ?? pageColors.blueLink;
  const baseTokenText = simulateOptions?.tokenText ?? '';
  const varTextOverride = (fromNode?.tokenText ?? '').trim();
  const sourceVar = (fromNode?.variableLabel ?? '').trim();
  const inheritedText = varTextOverride || sourceVar || baseTokenText;
  const eff = link.manualTokenEnabled
    ? getManualTokenBaseText(link, inheritedText)
    : ((link.messageLabel && link.messageLabel.trim()) ? link.messageLabel : inheritedText);
  const messageOverlapsToken = !link.manualTokenEnabled || link.manualTokenMessageOverlap !== false;
  const manualTextKeyframes = normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes);
  const longestTokenText = [eff, ...manualTextKeyframes.map(keyframe => keyframe.text)]
    .reduce((longest, text) => text.length > longest.length ? text : longest, '');
  const effectiveTokenText = eff.slice(0, messageOverlapsToken ? 6 : 24);
  const longestVisibleTokenText = longestTokenText.slice(0, messageOverlapsToken ? 6 : 24);
  const tokenTextColor = link.manualTokenEnabled && link.manualTokenTextColor
    ? link.manualTokenTextColor
    : (simulateOptions?.tokenTextColor ?? tokenStroke);
  const tokenTextSize = Math.max(8, Math.min(24,
    link.manualTokenEnabled && Number.isFinite(link.manualTokenTextSize)
      ? link.manualTokenTextSize
      : (simulateOptions?.tokenTextSize ?? 10)
  ));
  const tokenShape = simulateOptions?.tokenShape ?? 'circle';
  const tokenLabelWidth = messageOverlapsToken
    ? tokenR * 2
    : Math.max(tokenR * 2, Math.min(160, longestVisibleTokenText.length * tokenTextSize * 0.65 + 8));
  const tokenLabelHeight = messageOverlapsToken ? tokenR * 2 : tokenTextSize * 1.4;
  const tokenLabelY = messageOverlapsToken ? 0 : -(tokenR + tokenLabelHeight + 4);

  return (
    <Group listening={false}>
      <Path
        id={`link-shaft-${link.id}`}
        data={render.pathData}
        stroke={color}
        strokeWidth={sw}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
      <LinkFailureMark link={link} render={render} />
      {/* Fail tint overlay */}
      <Path
        id={`link-shaft-fail-overlay-${link.id}`}
        data={render.pathData}
        stroke={pageColors.dangerBright}
        strokeWidth={sw}
        lineCap="round"
        lineJoin="round"
        opacity={0}
        listening={false}
      />
      <Line
        id={`link-head-${link.id}`}
        points={render.arrowHeadPoints}
        basePoints={render.arrowHeadPoints}
        showTip={render.showArrowTip && !isFailing}
        closed
        fill={color}
        stroke={color}
        strokeWidth={1}
        opacity={render.showArrowTip && !isFailing ? 1 : 0}
        listening={false}
      />
      {/* Message token (simulation) — moved by applyAnimState when enabled */}
      <Group id={`link-token-${link.id}`} opacity={0} listening={false}>
        {tokenShape === 'square' ? (
          <Rect width={tokenR * 2} height={tokenR * 2} offsetX={tokenR} offsetY={tokenR} fill={tokenFill} stroke={tokenStroke} strokeWidth={2} cornerRadius={3} />
        ) : tokenShape === 'diamond' ? (
          <Line points={[0, -tokenR, tokenR, 0, 0, tokenR, -tokenR, 0]} closed fill={tokenFill} stroke={tokenStroke} strokeWidth={2} />
        ) : (
          <Ellipse radiusX={tokenR} radiusY={tokenR} fill={tokenFill} stroke={tokenStroke} strokeWidth={2} />
        )}
        {(!!effectiveTokenText || manualTextKeyframes.length > 0) && (
          <Text
            id={`link-token-label-${link.id}`}
            text={effectiveTokenText}
            align="center"
            verticalAlign="middle"
            x={0}
            y={tokenLabelY}
            offsetX={tokenLabelWidth / 2}
            offsetY={messageOverlapsToken ? tokenR : 0}
            width={tokenLabelWidth}
            height={tokenLabelHeight}
            fill={tokenTextColor}
            fontSize={tokenTextSize}
            fontFamily="Inter, system-ui, sans-serif"
            listening={false}
          />
        )}
      </Group>

      {/* Screen-centered fail X (overlay) */}
      <Group id={`link-fail-screen-x-${link.id}`} opacity={0} listening={false}>
        <Line
          points={[-28, -28, 28, 28]}
          stroke={pageColors.dangerBright}
          strokeWidth={4}
          lineCap="round"
        />
        <Line
          points={[-28, 28, 28, -28]}
          stroke={pageColors.dangerBright}
          strokeWidth={4}
          lineCap="round"
        />
      </Group>
    </Group>
  );
}

// ── Control button ─────────────────────────────────────────────────────────────

function CtrlBtn({ label, onClick, primary, disabled }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: primary
          ? hovered ? pageColors.purpleSurfacePanel : withAlpha(pageColors.purpleAccent, 0.15)
          : hovered ? 'var(--border-strong)' : 'none',
        border: primary
          ? `1px solid ${pageColors.purpleBorderSoft}`
          : '1px solid var(--border-strong)',
        borderRadius: 7,
        color: disabled
          ? pageColors.textFaint
          : primary ? pageColors.purpleAccent : pageColors.textMuted,
        fontSize: 12,
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: '7px 16px',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.1s',
        userSelect: 'none',
      }}
    >
      {label}
    </button>
  );
}

// ── Main overlay ───────────────────────────────────────────────────────────────

const STAGE_W = 820;
const STAGE_H = 430;
const PAD = 48;

const SubdiagramOverlay = forwardRef(function SubdiagramOverlayInner({
  node,
  onClose,
  controlledTime = null,
  dismissible = true,
  showControls = false,
  visible = true,
  onExited,
  depth = 0,
  ancestryNodeIds = [],
  sourceRect = null,
  viewportSize = null,
  originX = 50,
  originY = 50,
}, imperativeRef) {
  const layerRef = useRef(null);
  const rafRef = useRef(null);
  const exitTimeoutRef = useRef(null);
  const playingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [displayTime, setDisplayTime] = useState(0);
  const [nestedPopupState, setNestedPopupState] = useState(null);
  const isControlled = controlledTime != null;
  const prefersReducedMotion = usePrefersReducedMotion();

  // Refs for engine/linkRenders so the imperative handle captures latest values without rebuilding
  const engineRef = useRef(null);
  const linkRendersRef = useRef(null);
  // Refs for nested popup imperative management
  const nestedPopupWindowsRef = useRef([]);
  const currentActiveNestedRef = useRef(null);
  const nestedOverlayRef = useRef(null);

  const snapshotNodes = node.snapshotNodes ?? [];
  const snapshotLinks = node.snapshotLinks ?? [];
  const isEmpty = snapshotNodes.length === 0;

  // Strip animStartTime/animDuration from nested sub-diagram nodes so their
  // main-timeline scheduling doesn't inflate this overlay's AnimationEngine
  // duration (which caused the "massive delay" bug when importing self-project).
  const cleanedSnapshotNodes = useMemo(
    () => snapshotNodes.map(n =>
      n.type === 'subdiagram'
        ? { ...n, animStartTime: null, animDuration: null }
        : n
    ),
    [snapshotNodes]
  );

  const nodeMap = useMemo(
    () => Object.fromEntries(snapshotNodes.map(n => [n.id, n])),
    [snapshotNodes]
  );

  const engine = useMemo(
    () => new AnimationEngine(cleanedSnapshotNodes, snapshotLinks, {
      ancestorSubdiagramIds: ancestryNodeIds,
    }),
    [ancestryNodeIds, cleanedSnapshotNodes, snapshotLinks]
  );
  const linkRenders = useMemo(
    () => computeLinkRenders(cleanedSnapshotNodes, snapshotLinks),
    [cleanedSnapshotNodes, snapshotLinks]
  );
  const overlayWebs = useMemo(
    () => engine.getVariableWebs(),
    [engine]
  );
  const overlayWebByLinkId = useMemo(() => buildWebByLinkId(overlayWebs), [overlayWebs]);
  const bindToTokenHopById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, !!l.bindToTokenHop])), [snapshotLinks]);
  const bindMetaById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, { offset: Number.isFinite(l.bindHopOffset) ? l.bindHopOffset : 0, scale: Number.isFinite(l.bindHopScale) && l.bindHopScale > 0 ? l.bindHopScale : 1 }])), [snapshotLinks]);
  const linkStartOverrideById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animStartTime)) ? l.animStartTime : null])), [snapshotLinks]);
  const linkDurationOverrideById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animDuration)) ? l.animDuration : null])), [snapshotLinks]);
  const manualTokenTimingById = useMemo(
    () => computeManualTokenTimingByLinkId(snapshotLinks, engine.getTimeline()),
    [engine, snapshotLinks]
  );
  const failAtEndsById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, !!l.failAtEnds])), [snapshotLinks]);
  const failOnTokenEndById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, !!l.failOnTokenEnd])), [snapshotLinks]);
  const failingById = useMemo(() => Object.fromEntries((snapshotLinks ?? []).map(l => [l.id, !!l.failing])), [snapshotLinks]);
  const linkFailureById = useMemo(() => Object.fromEntries((snapshotLinks ?? [])
    .filter(l => l.failureKeyframes?.length)
    .map(l => [l.id, { failureKeyframes: l.failureKeyframes }])), [snapshotLinks]);
  const overlayMonitors = useMemo(
    () => cleanedSnapshotNodes.filter(n => n.type === 'monitor'),
    [cleanedSnapshotNodes]
  );
  const timeline = useMemo(() => engine.getTimeline(), [engine]);
  const bb = useMemo(() => engine.getBoundingBox(), [engine]);
  const timelineNodeEventsById = useMemo(
    () => Object.fromEntries(
      timeline
        .filter(event => event.type === 'node')
        .map(event => [event.id, event])
    ),
    [timeline]
  );
  const timelineLinkEventsById = useMemo(
    () => Object.fromEntries(
      timeline
        .filter(event => event.type === 'link')
        .map(event => [event.id, event])
    ),
    [timeline]
  );

  const scale = Math.min(
    (STAGE_W - PAD * 2) / Math.max(bb.w, 1),
    (STAGE_H - PAD * 2) / Math.max(bb.h, 1),
    2.5
  );
  const stageX = STAGE_W / 2 - bb.cx * scale;
  const stageY = STAGE_H / 2 - bb.cy * scale;
  const controlledDisplayTime = Math.max(0, Math.min(engine.getContentDuration(), controlledTime ?? 0));

  // Keep refs in sync so the imperative handle always has the latest values
  useEffect(() => { engineRef.current = engine; }, [engine]);
  useEffect(() => { linkRendersRef.current = linkRenders; }, [linkRenders]);

  // Imperative nested popup updater — called 60fps from setTime() or the standalone tick.
  // Only uses refs + the stable setNestedPopupState setter, so it never goes stale.
  const updateNestedPopupImperatively = useCallback((ct) => {
    const windows = nestedPopupWindowsRef.current;
    if (!windows.length) return;
    const active = windows.find(w => ct >= w.popupStart && ct <= w.popupEnd);
    if (active) {
      const nestedT = clamp(
        (ct - active.popupStart) * active.popupPlaybackSpeed,
        0,
        active.nestedContentDuration
      );
      if (currentActiveNestedRef.current?.node.id === active.node.id) {
        // Same popup is visible — update its time imperatively (zero React re-renders)
        nestedOverlayRef.current?.setTime(nestedT);
      } else {
        // Popup identity changed — use React state to mount the new overlay
        currentActiveNestedRef.current = active;
        setNestedPopupState({
          node: active.node,
          controlledTime: nestedT,
          visible: true,
          sourceRect: active.sourceRect ?? null,
          originX: active.originX,
          originY: active.originY,
        });
      }
    } else if (currentActiveNestedRef.current) {
      currentActiveNestedRef.current = null;
      setNestedPopupState(prev => prev ? { ...prev, visible: false } : null);
    }
  }, []);

  // Expose setTime() so parent overlays and DiagramCanvas can drive us imperatively.
  // This is the hot path: called every animation frame with zero React re-renders.
  const earliestStart = useMemo(() => {
    const tl = engine.getTimeline();
    return tl && tl.length ? Math.min(...tl.map(ev => ev.start)) : 0;
  }, [engine]);

  useImperativeHandle(imperativeRef, () => ({
    setTime(t) {
      if (!layerRef.current || !engineRef.current || !linkRendersRef.current) return;
      const ct = Math.max(0, Math.min(engineRef.current.getContentDuration(), t));
      const state = engineRef.current.getStateAtTime(ct);
      applyAnimState(layerRef.current, state, linkRendersRef.current, null, {
        webs: overlayWebs, webByLinkId: overlayWebByLinkId, monitors: overlayMonitors, currentTime: ct, timelineStart: earliestStart, bindToTokenHopById, bindMetaById, linkStartOverrideById, linkDurationOverrideById, manualTokenTimingById, failAtEndsById, failOnTokenEndById, failingById, linkFailureById, isPlaying: true,
      });
      layerRef.current.draw();
      updateNestedPopupImperatively(ct);
    },
  }), [
    bindMetaById,
    bindToTokenHopById,
    earliestStart,
    linkDurationOverrideById,
    linkStartOverrideById,
    manualTokenTimingById,
    failAtEndsById,
    failOnTokenEndById,
    failingById,
    linkFailureById,
    overlayMonitors,
    overlayWebByLinkId,
    overlayWebs,
    updateNestedPopupImperatively,
  ]);

  // Show end state on first render (after shapes are mounted)
  const showEndState = useCallback(() => {
    if (!layerRef.current) return;
    const ct = engine.getContentDuration();
    const state = engine.getStateAtTime(ct);
    applyAnimState(layerRef.current, state, linkRenders, null, {
      webs: overlayWebs, webByLinkId: overlayWebByLinkId, monitors: overlayMonitors, currentTime: ct, timelineStart: earliestStart, bindToTokenHopById, bindMetaById, linkStartOverrideById, linkDurationOverrideById, manualTokenTimingById, failAtEndsById, failOnTokenEndById, failingById, linkFailureById, isPlaying: false,
    });
    layerRef.current.draw();
    setDisplayTime(ct);
  }, [
    bindMetaById,
    bindToTokenHopById,
    earliestStart,
    engine,
    linkDurationOverrideById,
    linkRenders,
    linkStartOverrideById,
    manualTokenTimingById,
    failAtEndsById,
    failOnTokenEndById,
    failingById,
    linkFailureById,
    overlayMonitors,
    overlayWebByLinkId,
    overlayWebs,
  ]);

  useEffect(() => {
    if (isControlled) return undefined;
    // Give React-Konva one tick to mount shapes before we apply state
    const id = setTimeout(showEndState, 30);
    return () => clearTimeout(id);
  }, [isControlled, showEndState]);

  useEffect(() => {
    if (!isControlled || !layerRef.current) return;
    // Apply initial state when the overlay first mounts or controlledTime prop first arrives.
    // Subsequent per-frame updates are driven imperatively via setTime() — no React re-renders.
    const state = engine.getStateAtTime(controlledDisplayTime);
    applyAnimState(layerRef.current, state, linkRenders, null, {
      webs: overlayWebs, webByLinkId: overlayWebByLinkId, monitors: overlayMonitors, currentTime: controlledDisplayTime, timelineStart: earliestStart, bindToTokenHopById, bindMetaById, linkStartOverrideById, linkDurationOverrideById, manualTokenTimingById, failAtEndsById, failOnTokenEndById, failingById, linkFailureById, isPlaying: false,
    });
    layerRef.current.draw();
  }, [
    bindMetaById,
    bindToTokenHopById,
    controlledDisplayTime,
    earliestStart,
    engine,
    isControlled,
    linkDurationOverrideById,
    linkRenders,
    linkStartOverrideById,
    manualTokenTimingById,
    failAtEndsById,
    failOnTokenEndById,
    failingById,
    linkFailureById,
    overlayMonitors,
    overlayWebByLinkId,
    overlayWebs,
  ]);

  // Cleanup RAF on unmount
  useEffect(() => () => {
    playingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    clearTimeout(exitTimeoutRef.current);
  }, []);

  useEffect(() => {
    clearTimeout(exitTimeoutRef.current);
    if (!visible) {
      exitTimeoutRef.current = setTimeout(() => {
        onExited?.();
      }, 240);
    }
    return () => clearTimeout(exitTimeoutRef.current);
  }, [onExited, visible]);

  const startAnimation = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    playingRef.current = true;
    setIsPlaying(true);

    // Jump to t=0 visually
    if (layerRef.current) {
      const state = engine.getStateAtTime(0);
      applyAnimState(layerRef.current, state, linkRenders, null, {
        webs: overlayWebs, webByLinkId: overlayWebByLinkId, monitors: overlayMonitors, currentTime: 0, timelineStart: earliestStart, bindToTokenHopById, bindMetaById, linkStartOverrideById, linkDurationOverrideById, manualTokenTimingById, failAtEndsById, failOnTokenEndById, failingById, linkFailureById, isPlaying: true,
      });
      layerRef.current.draw();
    }
    setDisplayTime(0);

    const startT = performance.now();
    const totalDuration = engine.getTotalDuration();
    const contentDuration = engine.getContentDuration();
    let lastDisplayTimeUpdate = 0;

    const tick = () => {
      if (!playingRef.current) return;
      const elapsed = (performance.now() - startT) / 1000;
      if (elapsed >= totalDuration) {
        playingRef.current = false;
        setIsPlaying(false);
        const state = engine.getStateAtTime(contentDuration);
        setDisplayTime(contentDuration);
        if (layerRef.current) {
          applyAnimState(layerRef.current, state, linkRenders, null, {
            webs: overlayWebs, webByLinkId: overlayWebByLinkId, monitors: overlayMonitors, currentTime: contentDuration, timelineStart: earliestStart, bindToTokenHopById, bindMetaById, linkStartOverrideById, linkDurationOverrideById, manualTokenTimingById, failAtEndsById, failOnTokenEndById, failingById, linkFailureById, isPlaying: false,
          });
          layerRef.current.draw();
        }
        return;
      }
      // Canvas runs at full 60fps (imperative Konva), React state throttled to ~30fps
      const state = engine.getStateAtTime(elapsed);
      if (layerRef.current) {
        applyAnimState(layerRef.current, state, linkRenders, null, {
          webs: overlayWebs, webByLinkId: overlayWebByLinkId, monitors: overlayMonitors, currentTime: elapsed, timelineStart: earliestStart, bindToTokenHopById, bindMetaById, linkStartOverrideById, linkDurationOverrideById, manualTokenTimingById, failAtEndsById, failOnTokenEndById, failingById, linkFailureById, isPlaying: true,
        });
        layerRef.current.draw();
      }
      // Update nested popup time imperatively at 60fps (no React re-renders)
      updateNestedPopupImperatively(elapsed);
      const now = performance.now();
      if (now - lastDisplayTimeUpdate >= 33) {
        lastDisplayTimeUpdate = now;
        setDisplayTime(Math.min(elapsed, contentDuration));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [
    bindMetaById,
    bindToTokenHopById,
    earliestStart,
    engine,
    linkDurationOverrideById,
    linkRenders,
    linkStartOverrideById,
    manualTokenTimingById,
    failAtEndsById,
    failOnTokenEndById,
    failingById,
    linkFailureById,
    overlayMonitors,
    overlayWebByLinkId,
    overlayWebs,
    updateNestedPopupImperatively,
  ]);

  const stopAnimation = useCallback(() => {
    playingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    setIsPlaying(false);
    showEndState();
  }, [showEndState]);

  const handleKeyDown = useCallback((e) => {
    if (dismissible && e.key === 'Escape') onClose?.();
  }, [dismissible, onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Compute popup windows once per snapshot change (expensive: creates engines).
  // Does NOT depend on displayTime so it doesn't rebuild every frame.
  const nestedPopupWindows = useMemo(() => {
    if (depth >= 4) return [];

    // Compute stage layout for transform-origin derivation
    const _scale = Math.min(
      (STAGE_W - PAD * 2) / Math.max(bb.w, 1),
      (STAGE_H - PAD * 2) / Math.max(bb.h, 1),
      2.5
    );
    const _stageX = STAGE_W / 2 - bb.cx * _scale;
    const _stageY = STAGE_H / 2 - bb.cy * _scale;

    return snapshotNodes
      .filter(subNode =>
        subNode.type === 'subdiagram' &&
        !ancestryNodeIds.includes(subNode.id) &&
        subNode.showPopupInPlayback === true &&
        (subNode.snapshotNodes?.length ?? 0) > 0
      )
      .map(subNode => {
        const event = timelineNodeEventsById[subNode.id];
        if (!event) return null;
        const triggerLinkEvent = subNode.triggerAfterLinkId
          ? timelineLinkEventsById[subNode.triggerAfterLinkId]
          : null;
        const cleanedNestedNodes = (subNode.snapshotNodes ?? []).map(n =>
          n.type === 'subdiagram' ? { ...n, animStartTime: null, animDuration: null } : n
        );
        const nestedEngine = new AnimationEngine(cleanedNestedNodes, subNode.snapshotLinks ?? [], {
          holdAfter: 0,
          ancestorSubdiagramIds: [...ancestryNodeIds, subNode.id],
        });
        const popupDelay = Math.max(0, subNode.popupDelay ?? 0);
        const popupPlaybackSpeed = Math.max(0.25, subNode.popupPlaybackSpeed ?? 1);
        const popupHold = Math.max(0, subNode.popupHold ?? 0);
        const popupStart = Math.max(
          event.start + popupDelay,
          triggerLinkEvent ? triggerLinkEvent.start + triggerLinkEvent.duration + popupDelay : -Infinity
        );
        const nestedContentDuration = nestedEngine.getContentDuration();
        const popupEnd = popupStart + nestedContentDuration / popupPlaybackSpeed + popupHold;

        // Compute where this subnode sits inside the full overlay viewport so the
        // nested popup can visibly expand from the source node footprint.
        const subW = subNode.width ?? 150;
        const subH = subNode.height ?? 52;
        const screenCx = _stageX + (subNode.x + subW / 2) * _scale;
        const screenCy = _stageY + (subNode.y + subH / 2) * _scale;
        const subOriginX = Math.max(5, Math.min(95, (screenCx / STAGE_W) * 100));
        const subOriginY = Math.max(5, Math.min(95, (screenCy / STAGE_H) * 100));
        const viewportW = viewportSize?.w ?? STAGE_W;
        const viewportH = viewportSize?.h ?? STAGE_H;
        const cardW = STAGE_W;
        const cardH = STAGE_H + (showControls ? 54 : 0);
        const cardLeft = (viewportW - cardW) / 2;
        const cardTop = (viewportH - cardH) / 2;
        const sourceRect = {
          x: cardLeft + _stageX + subNode.x * _scale,
          y: cardTop + _stageY + subNode.y * _scale,
          width: subW * _scale,
          height: subH * _scale,
        };

        return {
          node: subNode,
          popupStart,
          popupEnd,
          popupPlaybackSpeed,
          nestedContentDuration,
          eventStart: event.start,
          sourceRect,
          originX: subOriginX,
          originY: subOriginY,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.eventStart - a.eventStart || a.node.id.localeCompare(b.node.id));
  }, [ancestryNodeIds, bb, depth, snapshotNodes, timelineLinkEventsById, timelineNodeEventsById]);

  // Keep ref in sync so updateNestedPopupImperatively always has the latest windows
  useEffect(() => { nestedPopupWindowsRef.current = nestedPopupWindows; }, [nestedPopupWindows]);

  const areaNodes = snapshotNodes.filter(n => n.type === 'area');
  const contentNodes = snapshotNodes.filter(n => n.type !== 'area');
  const isNestedOverlay = depth > 0;
  const popupTitle = (node.popupTitle ?? '').trim();
  const viewportWidth = viewportSize?.w ?? STAGE_W;
  const viewportHeight = viewportSize?.h ?? STAGE_H;
  const cardHeight = STAGE_H + (showControls ? 54 : 0);
  const sourceCenterX = sourceRect ? sourceRect.x + sourceRect.width / 2 : viewportWidth / 2;
  const sourceCenterY = sourceRect ? sourceRect.y + sourceRect.height / 2 : viewportHeight / 2;
  const enterTranslateX = sourceCenterX - viewportWidth / 2;
  const enterTranslateY = sourceCenterY - viewportHeight / 2;
  const enterScaleX = sourceRect ? clamp(sourceRect.width / STAGE_W, 0.08, 1) : 0.9;
  const enterScaleY = sourceRect ? clamp(sourceRect.height / cardHeight, 0.08, 1) : 0.9;
  const enterBlur = sourceRect ? clamp(26 - Math.max(sourceRect.width, sourceRect.height) * 0.03, 10, 24) : 12;
  const exitBlur = Math.max(8, Math.round(enterBlur * 0.7));
  const overshootX = Math.round(-enterTranslateX * 0.06);
  const overshootY = Math.round(-enterTranslateY * 0.06);
  const cardLeft = (viewportWidth - STAGE_W) / 2;
  const cardTop = (viewportHeight - cardHeight) / 2;
  const motionOriginX = sourceRect
    ? clamp(sourceCenterX - cardLeft, 24, STAGE_W - 24)
    : (STAGE_W * originX) / 100;
  const motionOriginY = sourceRect
    ? clamp(sourceCenterY - cardTop, 24, cardHeight - 24)
    : (cardHeight * originY) / 100;
  const sourcePulseRadius = sourceRect
    ? clamp(Math.min(sourceRect.height, sourceRect.width) * 0.3, 10, 22)
    : 14;
  const backdropInAnimation = isNestedOverlay ? 'sdNestedBackdropIn 0.18s ease-out both' : 'sdBackdropIn 0.22s ease-out both';
  const backdropOutAnimation = isNestedOverlay ? 'sdNestedBackdropOut 0.16s ease-in both' : 'sdBackdropOut 0.2s ease-in both';
  const popupInAnimation = prefersReducedMotion
    ? 'sdPopupFadeIn 0.14s ease-out both'
    : sourceRect
      ? `sdPopupExpandIn ${isNestedOverlay ? '0.58s' : '0.54s'} cubic-bezier(0.16, 1, 0.3, 1) both`
      : isNestedOverlay
        ? 'sdNestedPopupIn 0.42s cubic-bezier(0.12, 0.88, 0.22, 1) both'
        : 'sdPopupIn 0.28s cubic-bezier(0.18, 0.9, 0.22, 1) both';
  const popupOutAnimation = prefersReducedMotion
    ? 'sdPopupFadeOut 0.1s ease-out both'
    : sourceRect
      ? `sdPopupCollapseOut ${isNestedOverlay ? '0.2s' : '0.18s'} cubic-bezier(0.4, 0, 0.2, 1) both`
      : isNestedOverlay
        ? 'sdNestedPopupOut 0.18s cubic-bezier(0.4, 0, 0.8, 0.2) both'
        : 'sdPopupOut 0.22s cubic-bezier(0.4, 0, 0.2, 1) both';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: withAlpha(pageColors.uiBase, isNestedOverlay ? 0.92 : 0.86),
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        perspective: isNestedOverlay ? '1400px' : undefined,
        animation: visible
          ? backdropInAnimation
          : backdropOutAnimation,
      }}
      onClick={(e) => { if (dismissible && e.target === e.currentTarget) onClose?.(); }}
    >
      {sourceRect && !prefersReducedMotion && (
        <div
          style={{
            position: 'absolute',
            left: sourceRect.x,
            top: sourceRect.y,
            width: Math.max(16, sourceRect.width),
            height: Math.max(16, sourceRect.height),
            borderRadius: sourcePulseRadius,
            border: `1px solid ${withAlpha(pageColors.blueSelection, isNestedOverlay ? 0.52 : 0.42)}`,
            background: `radial-gradient(circle at center, ${withAlpha(pageColors.blueLink, 0.24)} 0, ${withAlpha(pageColors.blueLink, 0.12)} 48%, transparent 78%)`,
            boxShadow: `0 0 0 1px ${withAlpha(pageColors.blueLink, 0.16)}, 0 0 32px ${withAlpha(pageColors.blueLink, isNestedOverlay ? 0.24 : 0.18)}`,
            pointerEvents: 'none',
            animation: visible
              ? 'sdSourceEcho 0.56s cubic-bezier(0.16, 1, 0.3, 1) both'
              : 'sdSourceEchoOut 0.16s ease-out both',
          }}
        />
      )}
      <div style={{
        width: STAGE_W,
        background: pageColors.canvasBackground,
        border: `1px solid ${withAlpha(isNestedOverlay ? pageColors.blueLink : pageColors.uiBorderStrong, isNestedOverlay ? 0.72 : 0.85)}`,
        borderRadius: 18,
        overflow: 'hidden',
        boxShadow: isNestedOverlay
          ? `0 38px 120px ${withAlpha(pageColors.black, 0.76)}, 0 0 0 1px ${withAlpha(pageColors.blueLink, 0.28)}, 0 0 42px ${withAlpha(pageColors.blueLink, 0.16)}`
          : `0 28px 72px ${withAlpha(pageColors.black, 0.65)}`,
        transformOrigin: `${motionOriginX}px ${motionOriginY}px`,
        willChange: 'transform, opacity, filter',
        '--sd-enter-x': `${Math.round(enterTranslateX)}px`,
        '--sd-enter-y': `${Math.round(enterTranslateY)}px`,
        '--sd-exit-x': `${Math.round(enterTranslateX)}px`,
        '--sd-exit-y': `${Math.round(enterTranslateY)}px`,
        '--sd-enter-scale-x': enterScaleX.toFixed(3),
        '--sd-enter-scale-y': enterScaleY.toFixed(3),
        '--sd-enter-blur': `${Math.round(enterBlur)}px`,
        '--sd-exit-blur': `${Math.round(exitBlur)}px`,
        '--sd-overshoot-x': `${overshootX}px`,
        '--sd-overshoot-y': `${overshootY}px`,
        animation: visible
          ? popupInAnimation
          : popupOutAnimation,
      }}>
        <style>{`
          @keyframes sdBackdropIn {
            from { opacity: 0; }
            to   { opacity: 1; }
          }

          @keyframes sdNestedBackdropIn {
            from { opacity: 0; }
            to   { opacity: 1; }
          }

          @keyframes sdBackdropOut {
            from { opacity: 1; }
            to   { opacity: 0; }
          }

          @keyframes sdNestedBackdropOut {
            from { opacity: 1; }
            to   { opacity: 0; }
          }

          @keyframes sdPopupIn {
            0% {
              opacity: 0;
              transform: scale(0.86) translateY(24px);
              filter: blur(12px);
            }
            68% {
              opacity: 1;
              transform: scale(1.015) translateY(-2px);
              filter: blur(0);
            }
            100% {
              opacity: 1;
              transform: scale(1) translateY(0);
              filter: blur(0);
            }
          }

          @keyframes sdPopupExpandIn {
            0% {
              opacity: 0;
              transform: translate3d(var(--sd-enter-x), var(--sd-enter-y), 0) scale(var(--sd-enter-scale-x), var(--sd-enter-scale-y));
              filter: blur(var(--sd-enter-blur)) saturate(0.62) brightness(1.12);
            }
            60% {
              opacity: 1;
              transform: translate3d(var(--sd-overshoot-x), var(--sd-overshoot-y), 0) scale(1.02, 1.02);
              filter: blur(0) saturate(1.03) brightness(1);
            }
            100% {
              opacity: 1;
              transform: translate3d(0, 0, 0) scale(1, 1);
              filter: blur(0) saturate(1) brightness(1);
            }
          }

          @keyframes sdNestedPopupIn {
            0% {
              opacity: 0;
              transform: scale(0.06);
              filter: blur(22px) saturate(0.4) brightness(1.4);
              box-shadow: 0 4px 12px ${withAlpha(pageColors.black, 0.2)}, 0 0 0 1px ${withAlpha(pageColors.blueLink, 0.04)};
            }
            55% {
              opacity: 1;
              transform: scale(1.038);
              filter: blur(0) saturate(1.06) brightness(1);
              box-shadow: 0 46px 122px ${withAlpha(pageColors.black, 0.78)}, 0 0 0 1px ${withAlpha(pageColors.blueLink, 0.34)}, 0 0 48px ${withAlpha(pageColors.blueLink, 0.18)};
            }
            100% {
              opacity: 1;
              transform: scale(1);
              filter: blur(0) saturate(1) brightness(1);
              box-shadow: 0 38px 120px ${withAlpha(pageColors.black, 0.76)}, 0 0 0 1px ${withAlpha(pageColors.blueLink, 0.28)}, 0 0 42px ${withAlpha(pageColors.blueLink, 0.16)};
            }
          }

          @keyframes sdSourceEcho {
            0% {
              opacity: 0.92;
              transform: scale(1);
              filter: blur(0);
            }
            55% {
              opacity: 0.34;
              transform: scale(2.4);
              filter: blur(10px);
            }
            100% {
              opacity: 0;
              transform: scale(3.1);
              filter: blur(16px);
            }
          }

          @keyframes sdSourceEchoOut {
            from {
              opacity: 0.22;
              transform: scale(1.08);
              filter: blur(6px);
            }
            to {
              opacity: 0;
              transform: scale(0.96);
              filter: blur(10px);
            }
          }

          @keyframes sdPopupOut {
            from {
              opacity: 1;
              transform: scale(1) translateY(0);
              filter: blur(0);
            }
            to {
              opacity: 0;
              transform: scale(0.92) translateY(16px);
              filter: blur(8px);
            }
          }

          @keyframes sdNestedPopupOut {
            from {
              opacity: 1;
              transform: scale(1);
              filter: blur(0) saturate(1);
            }
            to {
              opacity: 0;
              transform: scale(0.06);
              filter: blur(18px) saturate(0.4);
            }
          }

          @keyframes sdPopupCollapseOut {
            from {
              opacity: 1;
              transform: translate3d(0, 0, 0) scale(1, 1);
              filter: blur(0) saturate(1);
            }
            to {
              opacity: 0;
              transform: translate3d(var(--sd-exit-x), var(--sd-exit-y), 0) scale(var(--sd-enter-scale-x), var(--sd-enter-scale-y));
              filter: blur(var(--sd-exit-blur)) saturate(0.55);
            }
          }

          @keyframes sdPopupFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }

          @keyframes sdPopupFadeOut {
            from { opacity: 1; }
            to { opacity: 0; }
          }
        `}</style>

        <div style={{
          background: pageColors.canvasBackground,
          backgroundImage: [
            `radial-gradient(circle at 20% 20%, ${withAlpha(pageColors.canvasTexturePrimary, 0.1)}, transparent 40%)`,
            `radial-gradient(circle at 80% 75%, ${withAlpha(pageColors.canvasTextureSecondary, 0.08)}, transparent 40%)`,
          ].join(', '),
          position: 'relative',
        }}>
          {popupTitle && (
            <div
              style={{
                position: 'absolute',
                top: 14,
                left: 14,
                zIndex: 2,
                pointerEvents: 'none',
                padding: '7px 11px',
                borderRadius: 999,
                background: withAlpha(pageColors.black, isNestedOverlay ? 0.42 : 0.34),
                border: `1px solid ${withAlpha(isNestedOverlay ? pageColors.blueLink : pageColors.uiBorderStrong, isNestedOverlay ? 0.34 : 0.22)}`,
                boxShadow: `0 10px 24px ${withAlpha(pageColors.black, 0.18)}`,
                color: pageColors.white,
                fontSize: 12,
                fontFamily: 'Inter, system-ui, sans-serif',
                fontWeight: 600,
                letterSpacing: 0.2,
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            >
              {popupTitle}
            </div>
          )}
          {isEmpty ? (
            <div style={{
              width: STAGE_W,
              height: STAGE_H,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}>
              <div style={{ fontSize: 36, opacity: 0.2 }}>⬡</div>
              <div style={{ color: pageColors.textDim, fontSize: 13 }}>No content yet</div>
              <div style={{ color: pageColors.textFaint, fontSize: 11 }}>
                Import a project using the Properties panel
              </div>
            </div>
          ) : (
            <Stage
              width={STAGE_W}
              height={STAGE_H}
              scaleX={scale}
              scaleY={scale}
              x={stageX}
              y={stageY}
            >
              <Layer ref={layerRef}>
                {/* Areas first (behind everything) */}
                {areaNodes.map(n => (
                  <ReadonlyNodeShape key={n.id} node={n} allNodes={snapshotNodes} />
                ))}

                {/* Links */}
                {snapshotLinks.map(link => {
                  const from = nodeMap[link.fromId];
                  const to = nodeMap[link.toId];
                  if (!from || !to) return null;
                  return (
                    <ReadonlyLinkShape
                      key={link.id}
                      link={link}
                      fromNode={from}
                      toNode={to}
                      allNodes={snapshotNodes}
                      allLinks={snapshotLinks}
                    />
                  );
                })}

                {/* Content nodes on top */}
                {contentNodes.map(n => (
                  <ReadonlyNodeShape key={n.id} node={n} allNodes={snapshotNodes} />
                ))}
              </Layer>
            </Stage>
          )}
        </div>

        {showControls && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            padding: '12px 16px',
            borderTop: `1px solid ${pageColors.uiBorderStrong}`,
            gap: 8,
          }}>
            <CtrlBtn
              label={isPlaying ? '■ Stop' : '▶ Play'}
              onClick={isPlaying ? stopAnimation : startAnimation}
              primary={!isPlaying}
              disabled={isEmpty}
            />
            <CtrlBtn
              label="↺ Reset"
              onClick={stopAnimation}
              disabled={isEmpty}
            />
            <div style={{ flex: 1 }} />
            <div style={{
              color: pageColors.textFaint,
              fontSize: 10,
              fontFamily: 'Inter, system-ui, sans-serif',
            }}>
              Press Esc or click outside to close
            </div>
            <CtrlBtn label="✕ Collapse" onClick={onClose} />
          </div>
        )}
      </div>

      {nestedPopupState && (
        <SubdiagramOverlay
          ref={nestedOverlayRef}
          key={nestedPopupState.node.id}
          node={nestedPopupState.node}
          controlledTime={nestedPopupState.controlledTime}
          dismissible={false}
          showControls={false}
          visible={nestedPopupState.visible}
          onExited={() => setNestedPopupState(null)}
          depth={depth + 1}
          ancestryNodeIds={[...ancestryNodeIds, nestedPopupState.node.id]}
          sourceRect={nestedPopupState.sourceRect ?? null}
          viewportSize={viewportSize}
          originX={nestedPopupState.originX ?? 50}
          originY={nestedPopupState.originY ?? 50}
        />
      )}
    </div>
  );
});

SubdiagramOverlay.displayName = 'SubdiagramOverlay';

export default SubdiagramOverlay;
