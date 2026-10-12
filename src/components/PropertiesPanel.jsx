import React, { useEffect, useMemo, useRef, useState } from 'react';
import { docsNav } from '../docsNav';
import { toColorInputValue } from '../colorValue';
import { v4 as uuid } from 'uuid';
import useStore, { NODE_SHAPE_PRESETS, isSubdiagramNode } from '../store/useStore';
import { getMirrorOverlapPayload, getMirrorSourceItems, getMirrorSelectionPayload, isMirrorNode } from '../mirror/mirrorData';
import { getNextTextMorphStart, getNodeTextMorphs, normalizeTextMorphList } from '../text/textMorphs';
import { EQUATION_FONT_FAMILY, formatEquationText } from '../text/equationText';
import { listProjects, readProject } from '../projects/projectStore';
import { computeVariableWebs } from '../variables/flow';
import {
  getManualTokenBaseText,
  getManualTokenTextAtTime,
  getManualTokenTrackId,
  normalizeManualTokenTextKeyframes,
} from '../animation/manualTokenTiming';
import { getTimelineCursor } from '../timelineCursor';
import { DEFAULT_NODE_FAILURE_DURATION, normalizeNodeFailureKeyframes } from '../animation/nodeFailureTiming';
import { DEFAULT_SCROLL_STEP_DURATION, normalizeScrollSteps } from '../animation/scrollStepTiming';

function InfoBtn({ anchor }) {
  return (
    <button
      onClick={() => docsNav.open(anchor)}
      title="Open documentation"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 16, height: 16, flexShrink: 0,
        borderRadius: '50%',
        border: '1px solid currentColor',
        background: 'none', cursor: 'pointer', padding: 0,
        color: 'var(--text-dim)',
        fontSize: 10, fontWeight: 700, lineHeight: 1,
        fontFamily: 'serif', fontStyle: 'italic',
        opacity: 0.65,
        verticalAlign: 'middle',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--purple-bright)'; e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.opacity = '0.65'; }}
    >
      i
    </button>
  );
}

// `hint` renders as a hover tooltip on the section header — detailed guidance
// lives there instead of in always-visible helper paragraphs.
function Section({ title, hint, docAnchor }) {
  return (
    <div title={hint} style={{
      display: 'flex', alignItems: 'center', gap: 5,
      color: 'var(--purple-bright)',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      marginBottom: 14,
      marginTop: 6,
      paddingBottom: 6,
      borderBottom: '1px solid var(--border-strong)',
      cursor: hint ? 'help' : 'default',
    }}>
      <span>{title}</span>
      {docAnchor && <InfoBtn anchor={docAnchor} />}
    </div>
  );
}

function Row({ label, title, docAnchor, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <label
        title={title}
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          color: 'var(--text-muted)',
          fontSize: 11,
          width: 72,
          flexShrink: 0,
          cursor: title ? 'help' : 'default',
        }}
      >
        <span>{label}</span>
        {docAnchor && <InfoBtn anchor={docAnchor} />}
      </label>
      {children}
    </div>
  );
}

// Single-line empty state — the only always-visible hint format in this panel.
function EmptyHint({ children }) {
  return (
    <div style={{ color: 'var(--text-faint)', fontSize: 11, marginBottom: 10 }}>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, title, placeholder }) {
  return (
    <input
      value={value}
      title={title}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      style={{
        flex: 1,
        background: 'var(--panel-bg-3)',
        border: '1px solid var(--border-strong)',
        borderRadius: 5,
        color: 'var(--text-main)',
        padding: '5px 8px',
        fontSize: 12,
      }}
    />
  );
}

function NumberInput({ value, onChange, min, max, step = 1 }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={e => onChange(Number(e.target.value))}
      style={{
        width: 62,
        background: 'var(--panel-bg-3)',
        border: '1px solid var(--border-strong)',
        borderRadius: 5,
        color: 'var(--text-main)',
        padding: '5px 8px',
        fontSize: 12,
      }}
    />
  );
}

function ColorInput({ value, onChange }) {
  const colorClipboard = useStore(state => state.colorClipboard);
  const setColorClipboard = useStore(state => state.setColorClipboard);

  const handleCopy = () => {
    setColorClipboard(value);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(value).catch(() => {});
    }
  };

  const handlePaste = () => {
    if (!colorClipboard) return;
    onChange(colorClipboard);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <div style={{ position: 'relative', width: 28, height: 28, flexShrink: 0 }}>
          <input
            type="color"
            value={toColorInputValue(value)}
            onChange={e => onChange(e.target.value)}
            style={{
              position: 'absolute', inset: 0,
              opacity: 0, cursor: 'pointer', width: '100%', height: '100%',
            }}
          />
          <div style={{
            width: 28, height: 28,
            borderRadius: 5,
            background: value,
            border: '2px solid var(--text-faint)',
            pointerEvents: 'none',
          }} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <button
            type="button"
            onClick={handleCopy}
            title="Copy this color"
            style={{
              background: 'var(--panel-bg)',
              border: '1px solid var(--border-strong)',
              borderRadius: 5,
              color: 'var(--text-muted)',
              fontSize: 10,
              padding: '4px 7px',
              cursor: 'pointer',
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={handlePaste}
            title={colorClipboard ? `Paste ${colorClipboard}` : 'Copy a color first'}
            disabled={!colorClipboard}
            style={{
              background: colorClipboard ? 'var(--purple-surface-panel)' : 'var(--panel-bg)',
              border: `1px solid ${colorClipboard ? 'var(--purple-border-strong)' : 'var(--border-strong)'}`,
              borderRadius: 5,
              color: colorClipboard ? 'var(--text-main)' : 'var(--text-dim)',
              fontSize: 10,
              padding: '4px 7px',
              cursor: colorClipboard ? 'pointer' : 'not-allowed',
              opacity: colorClipboard ? 1 : 0.6,
            }}
          >
            Paste
          </button>
        </div>
      </div>
      <span style={{
        color: 'var(--text-muted)',
        fontSize: 11,
        fontFamily: 'monospace',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}

function JointChip({ joint, isSelected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: isSelected ? 'var(--purple-surface-panel)' : 'var(--panel-bg)',
        border: `1px solid ${isSelected ? 'var(--purple-border-strong)' : 'var(--border-strong)'}`,
        borderRadius: 999,
        color: isSelected ? 'var(--text-main)' : 'var(--text-muted)',
        fontSize: 11,
        padding: '4px 8px',
        cursor: 'pointer',
      }}
    >
      {joint}
    </button>
  );
}

function ModeChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--purple-surface-panel)' : 'var(--panel-bg)',
        border: `1px solid ${active ? 'var(--purple-border-strong)' : 'var(--border-strong)'}`,
        borderRadius: 999,
        color: active ? 'var(--text-main)' : 'var(--text-dim)',
        fontSize: 11,
        padding: '4px 9px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function NodeStatusControl({ node, onChange }) {
  const status = node?.offline ? 'offline' : node?.failing ? 'failing' : 'normal';
  const setStatus = (nextStatus) => onChange({
    failing: nextStatus === 'failing',
    offline: nextStatus === 'offline',
  });
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <ModeChip label="Normal" active={status === 'normal'} onClick={() => setStatus('normal')} />
      <ModeChip label="Always fail" active={status === 'failing'} onClick={() => setStatus('failing')} />
      <ModeChip label="Offline" active={status === 'offline'} onClick={() => setStatus('offline')} />
    </div>
  );
}

function NodeFailureControls({ node, onChange }) {
  const keyframes = normalizeNodeFailureKeyframes(node?.failureKeyframes);
  const setKeyframes = nextKeyframes => onChange({
    failing: false,
    offline: false,
    failureKeyframes: normalizeNodeFailureKeyframes(nextKeyframes),
  });
  const addFailure = () => {
    const startTime = Math.round(Math.max(0, getTimelineCursor()) * 100) / 100;
    setKeyframes([
      ...keyframes,
      { id: uuid(), startTime, duration: DEFAULT_NODE_FAILURE_DURATION },
    ]);
  };
  const updateFailure = (id, updates) => setKeyframes(
    keyframes.map(keyframe => keyframe.id === id ? { ...keyframe, ...updates } : keyframe)
  );

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <ActionButton label="Add failure at playhead" onClick={addFailure} />
      {keyframes.map((keyframe, index) => (
        <div key={keyframe.id} style={{
          display: 'flex', alignItems: 'center', gap: 5, marginTop: 7,
          padding: '6px 7px', borderRadius: 6,
          background: 'var(--danger-surface-soft)', border: '1px solid var(--danger-border-soft)',
        }}>
          <span style={{ color: 'var(--danger-bright)', fontSize: 10, fontWeight: 700 }}>{index + 1}</span>
          <NumberInput
            value={keyframe.startTime}
            min={0}
            step={0.05}
            onChange={value => updateFailure(keyframe.id, { startTime: Math.round(Math.max(0, value) * 100) / 100 })}
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>for</span>
          <NumberInput
            value={keyframe.duration}
            min={0.1}
            step={0.05}
            onChange={value => updateFailure(keyframe.id, { duration: Math.round(Math.max(0.1, value) * 100) / 100 })}
          />
          <button
            onClick={() => setKeyframes(keyframes.filter(item => item.id !== keyframe.id))}
            title="Remove failure keyframe"
            style={{ background: 'none', border: 'none', color: 'var(--danger-bright)', cursor: 'pointer', fontSize: 15, padding: 2 }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function PresetChip({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'var(--panel-bg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 999,
        color: 'var(--text-muted)',
        fontSize: 11,
        padding: '4px 8px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function SliderControl({ label, value, min = 0, max = 120, step = 1, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
        <span style={{ color: 'var(--text-main)', fontSize: 11, fontFamily: 'monospace' }}>{Math.round(value)} px</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{
          width: '100%',
          accentColor: 'var(--purple-bright)',
          cursor: 'pointer',
        }}
      />
    </div>
  );
}

function ToggleInput({ checked, onChange, label = 'Enabled' }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-main)', fontSize: 12, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--purple-bright)', cursor: 'pointer' }}
      />
      <span>{label}</span>
    </label>
  );
}

function ActionButton({ label, active = false, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--purple-surface-panel)' : 'var(--panel-bg)',
        border: `1px solid ${active ? 'var(--purple-border-strong)' : 'var(--border-strong)'}`,
        borderRadius: 6,
        color: active ? 'var(--text-main)' : 'var(--text-muted)',
        fontSize: 11,
        padding: '5px 8px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

const NODE_SHAPE_OPTIONS = [
  { key: 'rectangle', label: 'Rectangle' },
  { key: 'rounded', label: 'Rounded' },
  { key: 'pill', label: 'Pill' },
  { key: 'database', label: 'Database' },
  { key: 'cylinder', label: 'Cylinder' },
  { key: 'diamond', label: 'Diamond' },
  { key: 'hexagon', label: 'Hexagon' },
  { key: 'slanted', label: 'Slanted' },
  { key: 'circle', label: 'Circle' },
  { key: 'protocol', label: 'Protocol' },
];

const SELECT_INPUT_STYLE = {
  flex: 1,
  minWidth: 0,
  background: 'var(--panel-bg-3)',
  border: '1px solid var(--border-strong)',
  borderRadius: 5,
  color: 'var(--text-main)',
  padding: '5px 8px',
  fontSize: 12,
};

function getResolveMode(node) {
  if (!node) return 'none';
  if (node.transformMode) return node.transformMode;
  return node.transformTargetNodeId ? 'existing' : 'none';
}

function buildResolveTargetFromNode(sourceNode, fallbackNode) {
  const source = sourceNode ?? fallbackNode ?? {};
  const fallback = fallbackNode ?? {};
  return {
    label: source.label ?? '',
    width: source.width ?? fallback.width ?? 150,
    height: source.height ?? fallback.height ?? 52,
    shape: source.shape ?? fallback.shape ?? 'rounded',
    cornerRadius: source.cornerRadius ?? fallback.cornerRadius ?? 8,
    fill: source.fill ?? fallback.fill ?? '#000000',
    stroke: source.stroke ?? fallback.stroke ?? '#000000',
    textColor: source.textColor ?? fallback.textColor ?? '#ffffff',
    strokeWidth: source.strokeWidth ?? fallback.strokeWidth ?? 2,
    showSubBadge: source.type === 'subdiagram'
      ? (source.showSubBadge ?? true)
      : (source.showSubBadge ?? false),
  };
}

function getDefaultResolveStart(node) {
  return Math.round((((node?.animStartTime ?? 0) + (node?.animDuration ?? 0.5)) * 100)) / 100;
}

function LinkBasics({ linkLike, onUpdate }) {
  const failureMode = linkLike.failOnTokenEnd
    ? 'token-end'
    : linkLike.failAtEnds
      ? 'draw-end'
      : linkLike.failing
        ? 'failing'
        : 'normal';
  const setFailureMode = (mode) => onUpdate({
    failing: mode === 'failing',
    failAtEnds: mode === 'draw-end',
    failOnTokenEnd: mode === 'token-end',
  });
  return (
    <>
      <Row label="Color">
        <ColorInput value={linkLike.stroke} onChange={v => onUpdate({ stroke: v })} />
      </Row>
      <Row label="Width">
        <NumberInput value={linkLike.strokeWidth} min={1} max={10} onChange={v => onUpdate({ strokeWidth: v })} />
      </Row>
      <Row label="Arrow tip">
        <ToggleInput checked={!!linkLike.showArrowTip} onChange={value => onUpdate({ showArrowTip: value })} />
      </Row>
      {linkLike.showArrowTip && (
        <Row label="Tip style">
          <div style={{ display: 'flex', gap: 6 }}>
            <ModeChip
              label="Moves"
              active={!linkLike.arrowTipMode || linkLike.arrowTipMode === 'flow'}
              onClick={() => onUpdate({ arrowTipMode: 'flow' })}
            />
            <ModeChip
              label="At end"
              active={linkLike.arrowTipMode === 'end'}
              onClick={() => onUpdate({ arrowTipMode: 'end' })}
            />
          </div>
        </Row>
      )}
      <Row label="Failure">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <ModeChip label="Normal" active={failureMode === 'normal'} onClick={() => setFailureMode('normal')} />
          <ModeChip label="Failing" active={failureMode === 'failing'} onClick={() => setFailureMode('failing')} />
          <ModeChip label="At draw end" active={failureMode === 'draw-end'} onClick={() => setFailureMode('draw-end')} />
          <ModeChip label="At token end" active={failureMode === 'token-end'} onClick={() => setFailureMode('token-end')} />
        </div>
      </Row>
      <Row label="Instant">
        <ToggleInput
          checked={!!linkLike.disableAnimation}
          onChange={value => onUpdate({ disableAnimation: value })}
          label="Appear instantly (no draw-in)"
        />
      </Row>
      <Row label="Timing">
        <ToggleInput
          checked={!!linkLike.bindToTokenHop}
          onChange={value => onUpdate({ bindToTokenHop: value })}
          label="Follow token timing"
        />
      </Row>
      {linkLike.bindToTokenHop && (
        <>
          <Row label="Auto-trigger">
            <ToggleInput
              checked={!!linkLike.autoTriggerTarget}
              onChange={v => onUpdate({ autoTriggerTarget: v })}
              label="Trigger target on hop end"
            />
          </Row>
          <Row label="Hop offset">
            <NumberInput value={Number.isFinite(linkLike.bindHopOffset) ? linkLike.bindHopOffset : 0} min={-10} max={10} step={0.05} onChange={v => onUpdate({ bindHopOffset: v })} />
          </Row>
          <Row label="Speed ×">
            <NumberInput value={Number.isFinite(linkLike.bindHopScale) ? linkLike.bindHopScale : 1} min={0.1} max={5} step={0.05} onChange={v => onUpdate({ bindHopScale: v })} />
          </Row>
        </>
      )}

      <Section title="Manual Token" docAnchor="manual-token" />
      <Row label="Enabled">
        <ToggleInput
          checked={!!linkLike.manualTokenEnabled}
          onChange={value => onUpdate({ manualTokenEnabled: value })}
          label="Add per-link token"
        />
      </Row>
      {linkLike.manualTokenEnabled && (
        <>
          <Row label="Start">
            <select
              value={linkLike.manualTokenAnchor ?? 'start'}
              onChange={e => onUpdate({ manualTokenAnchor: e.target.value })}
              style={SELECT_INPUT_STYLE}
            >
              <option value="start">When the link starts</option>
              <option value="end">When the link completes</option>
            </select>
          </Row>
          <Row label="Delay">
            <NumberInput
              value={Number.isFinite(linkLike.manualTokenDelay) ? linkLike.manualTokenDelay : 0}
              min={-10}
              max={10}
              step={0.05}
              onChange={v => onUpdate({ manualTokenDelay: v })}
            />
          </Row>
          <Row label="Travel time">
            <NumberInput
              value={Number.isFinite(linkLike.manualTokenDuration)
                ? linkLike.manualTokenDuration
                : (Number.isFinite(linkLike.animDuration) ? linkLike.animDuration : 0.65)}
              min={0.05}
              max={60}
              step={0.05}
              onChange={v => onUpdate({ manualTokenDuration: Math.max(0.05, v) })}
            />
          </Row>
          <Row label="Direction">
            <ToggleInput
              checked={!!linkLike.manualTokenInvert}
              onChange={value => onUpdate({ manualTokenInvert: value })}
              label="Travel from target to source"
            />
          </Row>
          <Row label="Name">
            <TextInput
              value={linkLike.manualTokenVariableName ?? ''}
              onChange={value => onUpdate({ manualTokenVariableName: value })}
            />
          </Row>
          <Row label="Value">
            <TextInput
              value={linkLike.manualTokenVariableValue ?? ''}
              onChange={value => onUpdate({ manualTokenVariableValue: value })}
            />
          </Row>
          <Row label="Message">
            <ToggleInput
              checked={linkLike.manualTokenMessageOverlap !== false}
              onChange={value => onUpdate({ manualTokenMessageOverlap: value })}
              label="Overlay on token"
            />
          </Row>
          <Row label="Token color">
            <ColorInput
              value={linkLike.manualTokenColor ?? '#ffffff'}
              onChange={value => onUpdate({ manualTokenColor: value })}
            />
          </Row>
          <Row label="Token size">
            <NumberInput
              value={Number.isFinite(linkLike.manualTokenSize) ? linkLike.manualTokenSize : 7}
              min={2}
              max={24}
              step={1}
              onChange={value => onUpdate({ manualTokenSize: Math.max(2, Math.min(24, value)) })}
            />
          </Row>
          <Row label="Text color">
            <ColorInput
              value={linkLike.manualTokenTextColor ?? '#60a5fa'}
              onChange={value => onUpdate({ manualTokenTextColor: value })}
            />
          </Row>
          <Row label="Text size">
            <NumberInput
              value={Number.isFinite(linkLike.manualTokenTextSize) ? linkLike.manualTokenTextSize : 10}
              min={8}
              max={24}
              step={1}
              onChange={value => onUpdate({ manualTokenTextSize: Math.max(8, Math.min(24, value)) })}
            />
          </Row>
        </>
      )}
    </>
  );
}

function getAnchorLimit(node, side) {
  if (!node || !side || side === 'center') return 0;
  return side === 'top' || side === 'bottom'
    ? Math.max(0, node.width / 2 - 12)
    : Math.max(0, node.height / 2 - 12);
}

function PanelContent() {
  const {
    nodes,
    links,
    nextLinkDefaults,
    selectedId,
    selectedJointId,
    setSelectedJoint,
    updateNode,
    updateLink,
    updateLinkJoint,
    updateNextLinkDefaults,
    captureMirrorSelection,
    updateMirrorNodeOverride,
    updateMirrorLinkOverride,
    removeNode,
    removeLink,
    removeLinkJoint,
  } = useStore();
  // Simulation hooks
  const simOpt = useStore(state => state.simulateOptions);
  const setSimulateOptions = useStore(state => state.setSimulateOptions);
  const addMonitorWatch = useStore(state => state.addMonitorWatch);
  const updateMonitorWatch = useStore(state => state.updateMonitorWatch);
  const removeMonitorWatch = useStore(state => state.removeMonitorWatch);
  const setMonitorVariable = useStore(state => state.setMonitorVariable);

  const selectedNode = nodes.find(node => node.id === selectedId);
  const selectedLink = links.find(link => link.id === selectedId);
  const selectedFromNode = selectedLink ? nodes.find(node => node.id === selectedLink.fromId) : null;
  const selectedToNode = selectedLink ? nodes.find(node => node.id === selectedLink.toId) : null;
  const selectedJoint = selectedLink?.joints?.find(joint => joint.id === selectedJointId) ?? null;
  const [curveMode, setCurveMode] = useState('linked');
  const jointCurve = useMemo(() => {
    if (!selectedJoint) return 0;
    return Math.round(((selectedJoint.prevCurve ?? 0) + (selectedJoint.nextCurve ?? 0)) / 2);
  }, [selectedJoint]);

  const wrap = {
    flex: 1,
    minWidth: 0,
    background: 'linear-gradient(180deg, var(--panel-bg), var(--panel-bg-2))',
    borderLeft: '1px solid var(--border-strong)',
    padding: 16,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  };

  useEffect(() => {
    if (!selectedJoint) return;
    const balanced = Math.abs((selectedJoint.prevCurve ?? 0) - (selectedJoint.nextCurve ?? 0)) < 1;
    setCurveMode(balanced ? 'linked' : 'split');
  }, [selectedJoint]);

  if (!selectedNode && !selectedLink) {
    return (
      <div style={wrap}>
        <Section title="Next Link" hint="These settings apply to the next link you draw" docAnchor="next-link" />
        <LinkBasics linkLike={nextLinkDefaults} onUpdate={updateNextLinkDefaults} />

        <Section title="Token Appearance" hint="Default look for the tokens that flow along every Variable node's web" docAnchor="token-appearance" />
        <Row label="Shape">
          <select
            value={simOpt.tokenShape}
            onChange={e => setSimulateOptions({ tokenShape: e.target.value })}
            style={SELECT_INPUT_STYLE}
          >
            <option value="circle">Circle</option>
            <option value="square">Square</option>
            <option value="diamond">Diamond</option>
          </select>
        </Row>
        <Row label="Size">
          <NumberInput value={simOpt.tokenSize} min={2} max={24} onChange={v => setSimulateOptions({ tokenSize: v })} />
        </Row>
        <Row label="Fill">
          <ColorInput value={simOpt.tokenFill} onChange={v => setSimulateOptions({ tokenFill: v })} />
        </Row>
        <Row label="Border">
          <ColorInput value={simOpt.tokenStroke} onChange={v => setSimulateOptions({ tokenStroke: v })} />
        </Row>
        <Row label="Label">
          <TextInput value={simOpt.tokenText} onChange={v => setSimulateOptions({ tokenText: v })} />
        </Row>
        <Row label="Label color">
          <ColorInput value={simOpt.tokenTextColor} onChange={v => setSimulateOptions({ tokenTextColor: v })} />
        </Row>
        <Row label="Label size">
          <NumberInput value={simOpt.tokenTextSize} min={8} max={24} onChange={v => setSimulateOptions({ tokenTextSize: v })} />
        </Row>
      </div>
    );
  }

  if (selectedNode && isSubdiagramNode(selectedNode)) {
    const up = (key, value) => updateNode(selectedNode.id, { [key]: value });
    const projects = listProjects();
    const transformTargets = (selectedNode.snapshotNodes ?? []).filter(node => (
      node.type !== 'area' &&
      node.type !== 'mirror' &&
      node.type !== 'text'
    ));
    const resolveMode = getResolveMode(selectedNode);
    const activeTransformTarget = transformTargets.find(node => node.id === selectedNode.transformTargetNodeId) ?? null;
    const updateResolveTarget = (updates) => updateNode(selectedNode.id, {
      transformTarget: {
        ...buildResolveTargetFromNode(activeTransformTarget, selectedNode),
        ...(selectedNode.transformTarget ?? {}),
        ...updates,
      },
    });
    const setResolveMode = (mode) => {
      if (mode === 'custom') {
        updateNode(selectedNode.id, {
          transformMode: 'custom',
          transformTarget: {
            ...buildResolveTargetFromNode(activeTransformTarget, selectedNode),
            ...(selectedNode.transformTarget ?? {}),
          },
        });
        return;
      }
      updateNode(selectedNode.id, { transformMode: mode });
    };

    return (
      <div style={wrap}>
        <Section title="Sub-diagram" docAnchor="subdiagram" />

        <Row label="Label">
          <TextInput value={selectedNode.label ?? ''} onChange={v => up('label', v)} />
        </Row>

        <Row label="Title">
          <TextInput value={selectedNode.popupTitle ?? ''} onChange={v => up('popupTitle', v)} />
        </Row>

        <Row label="Shape">
          <select
            value={selectedNode.shape ?? 'rounded'}
            onChange={(e) => updateNode(selectedNode.id, {
              ...NODE_SHAPE_PRESETS[e.target.value],
              type: selectedNode.type,
            })}
            style={SELECT_INPUT_STYLE}
          >
            {NODE_SHAPE_OPTIONS.map((shape) => (
              <option key={shape.key} value={shape.key}>{shape.label}</option>
            ))}
          </select>
        </Row>

        <Row label="Source">
          <select
            value={selectedNode.sourceProjectId ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                updateNode(selectedNode.id, {
                  sourceProjectId: null,
                  snapshotNodes: [],
                  snapshotLinks: [],
                });
                return;
              }
              const project = readProject(id);
              if (project) {
                updateNode(selectedNode.id, {
                  sourceProjectId: id,
                  snapshotNodes: project.nodes ?? [],
                  snapshotLinks: project.links ?? [],
                });
              }
            }}
            style={SELECT_INPUT_STYLE}
          >
            <option value="">Choose project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </Row>

        {(selectedNode.snapshotNodes?.length ?? 0) > 0 && (
          <EmptyHint>
            {(selectedNode.snapshotNodes?.length ?? 0)} nodes · {(selectedNode.snapshotLinks?.length ?? 0)} links loaded
          </EmptyHint>
        )}

        <Row label="Appear">
          <ToggleInput
            checked={!!selectedNode.disableAnimation}
            onChange={v => up('disableAnimation', v)}
            label="Instantly (no entry animation)"
          />
        </Row>

        <Section title="Resolve" hint="Morph this element into another node's look when its animation completes — drag the amber timeline block to set the moment" docAnchor="resolve" />

        <Row label="Mode">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <ModeChip label="Off" active={resolveMode === 'none'} onClick={() => setResolveMode('none')} />
            <ModeChip label="Existing" active={resolveMode === 'existing'} onClick={() => setResolveMode('existing')} />
            <ModeChip label="Custom" active={resolveMode === 'custom'} onClick={() => setResolveMode('custom')} />
          </div>
        </Row>

        {resolveMode === 'existing' && (
          <Row label="Into">
            <select
              value={selectedNode.transformTargetNodeId ?? ''}
              onChange={(e) => updateNode(selectedNode.id, {
                transformMode: 'existing',
                transformTargetNodeId: e.target.value || null,
              })}
              disabled={!transformTargets.length}
              style={{
                ...SELECT_INPUT_STYLE,
                color: transformTargets.length ? 'var(--text-main)' : 'var(--text-dim)',
              }}
            >
              <option value="">Choose snapshot node…</option>
              {transformTargets.map((targetNode) => (
                <option key={targetNode.id} value={targetNode.id}>{targetNode.label ?? 'Untitled node'}</option>
              ))}
            </select>
          </Row>
        )}

        {resolveMode === 'custom' && (
          <>
            <Row label="Label">
              <TextInput
                value={selectedNode.transformTarget?.label ?? ''}
                onChange={value => updateResolveTarget({ label: value })}
              />
            </Row>
            <Row label="Shape">
              <select
                value={selectedNode.transformTarget?.shape ?? selectedNode.shape ?? 'rounded'}
                onChange={e => updateResolveTarget({
                  width: NODE_SHAPE_PRESETS[e.target.value]?.width ?? selectedNode.width ?? 150,
                  height: NODE_SHAPE_PRESETS[e.target.value]?.height ?? selectedNode.height ?? 52,
                  shape: e.target.value,
                  cornerRadius: NODE_SHAPE_PRESETS[e.target.value]?.cornerRadius ?? (e.target.value === 'pill' ? 999 : e.target.value === 'rectangle' ? 0 : 8),
                })}
                style={SELECT_INPUT_STYLE}
              >
                {NODE_SHAPE_OPTIONS.map((shape) => (
                  <option key={shape.key} value={shape.key}>{shape.label}</option>
                ))}
              </select>
            </Row>
            <Row label="Fill">
              <ColorInput
                value={selectedNode.transformTarget?.fill ?? selectedNode.fill}
                onChange={value => updateResolveTarget({ fill: value })}
              />
            </Row>
            <Row label="Border">
              <ColorInput
                value={selectedNode.transformTarget?.stroke ?? selectedNode.stroke}
                onChange={value => updateResolveTarget({ stroke: value })}
              />
            </Row>
            <Row label="Text">
              <ColorInput
                value={selectedNode.transformTarget?.textColor ?? selectedNode.textColor}
                onChange={value => updateResolveTarget({ textColor: value })}
              />
            </Row>
            <Row label="Border width">
              <NumberInput
                value={selectedNode.transformTarget?.strokeWidth ?? selectedNode.strokeWidth ?? 2}
                min={0}
                max={10}
                step={0.5}
                onChange={value => updateResolveTarget({ strokeWidth: value })}
              />
            </Row>
            <Row label="Badge">
              <ToggleInput
                checked={selectedNode.transformTarget?.showSubBadge ?? selectedNode.showSubBadge ?? true}
                onChange={value => updateResolveTarget({ showSubBadge: value })}
                label="Show sub badge"
              />
            </Row>
          </>
        )}

        {resolveMode !== 'none' && (
          <Row label="Timing">
            <div style={{ display: 'flex', gap: 6 }}>
              <ModeChip
                label="After spawn"
                active={selectedNode.transformStartTime == null}
                onClick={() => up('transformStartTime', null)}
              />
              <ModeChip
                label="Manual"
                active={selectedNode.transformStartTime != null}
                onClick={() => up('transformStartTime', getDefaultResolveStart(selectedNode))}
              />
            </div>
          </Row>
        )}

        {resolveMode !== 'none' && selectedNode.transformStartTime != null && (
          <Row label="Start">
            <NumberInput
              value={selectedNode.transformStartTime ?? getDefaultResolveStart(selectedNode)}
              min={0}
              max={120}
              step={0.05}
              onChange={value => up('transformStartTime', Math.max(0, Math.round(value * 100) / 100))}
            />
          </Row>
        )}

        {resolveMode !== 'none' && (
          <Row label="Duration">
            <NumberInput
              value={selectedNode.transformDuration ?? 0.4}
              min={0.1}
              max={5}
              step={0.05}
              onChange={value => up('transformDuration', value)}
            />
          </Row>
        )}

        <Section title="Playback" docAnchor="playback" />

        <Row label="Badge">
          <ToggleInput
            checked={selectedNode.showSubBadge ?? true}
            onChange={value => up('showSubBadge', value)}
            label="Show sub badge"
          />
        </Row>

        <Row label="Popup">
          <ToggleInput
            checked={selectedNode.showPopupInPlayback ?? false}
            onChange={value => up('showPopupInPlayback', value)}
            label="Open nested view"
          />
        </Row>

        {selectedNode.showPopupInPlayback && (
          <>
            <Row label="Delay">
              <NumberInput
                value={selectedNode.popupDelay ?? 0.4}
                min={0}
                max={10}
                step={0.1}
                onChange={value => up('popupDelay', value)}
              />
            </Row>

            <Row label="Speed">
              <NumberInput
                value={selectedNode.popupPlaybackSpeed ?? 1}
                min={0.25}
                max={4}
                step={0.25}
                onChange={value => up('popupPlaybackSpeed', value)}
              />
            </Row>

            <Row label="Hold">
              <NumberInput
                value={selectedNode.popupHold ?? 0.9}
                min={0}
                max={10}
                step={0.1}
                onChange={value => up('popupHold', value)}
              />
            </Row>
          </>
        )}

        <div style={{ flex: 1 }} />
        <button
          onClick={() => removeNode(selectedNode.id)}
          style={{
            marginTop: 20,
            background: 'var(--danger-surface-soft)',
            border: '1px solid var(--danger-border-soft)',
            borderRadius: 6,
            color: 'var(--danger-bright)',
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Delete sub-diagram
        </button>
      </div>
    );
  }

  if (selectedNode && selectedNode.type === 'monitor') {
    const up = (key, value) => updateNode(selectedNode.id, { [key]: value });

    // Manual tokens use a stable link-derived track id so monitors can follow
    // them without changing the existing Variable-node data model.
    const variableNodes = nodes.filter(n => n.type === 'variable' && (n.variableLabel ?? '').trim());
    const manualTokenLinks = links.filter(link => link.manualTokenEnabled);

    // The web of the chosen variable = nodes reachable downstream via outgoing links.
    const trackedVariable = variableNodes.find(n => n.id === selectedNode.variableNodeId) ?? null;
    const trackedManualToken = manualTokenLinks.find(
      link => getManualTokenTrackId(link.id) === selectedNode.variableNodeId
    ) ?? null;
    const trackedSource = trackedVariable ?? trackedManualToken;
    const trackedManualFromNode = trackedManualToken
      ? nodes.find(node => node.id === (trackedManualToken.manualTokenInvert ? trackedManualToken.toId : trackedManualToken.fromId))
      : null;
    const trackedManualToNode = trackedManualToken
      ? nodes.find(node => node.id === (trackedManualToken.manualTokenInvert ? trackedManualToken.fromId : trackedManualToken.toId))
      : null;
    const trackedManualKeys = trackedManualToken
      ? normalizeManualTokenTextKeyframes(trackedManualToken.manualTokenTextKeyframes)
      : [];
    const webNodeIds = new Set();
    if (trackedVariable) {
      const outgoing = new Map();
      for (const l of links) {
        if (!outgoing.has(l.fromId)) outgoing.set(l.fromId, []);
        outgoing.get(l.fromId).push(l);
      }
      const queue = [trackedVariable.id];
      const seen = new Set([trackedVariable.id]);
      while (queue.length) {
        const nid = queue.shift();
        for (const l of (outgoing.get(nid) ?? [])) {
          if (!seen.has(l.toId)) {
            seen.add(l.toId);
            webNodeIds.add(l.toId);
            queue.push(l.toId);
          }
        }
      }
    }
    if (trackedManualToken) {
      if (trackedManualToken.fromId) webNodeIds.add(trackedManualToken.fromId);
      if (trackedManualToken.toId) webNodeIds.add(trackedManualToken.toId);
    }

    // Watch candidates = nodes in the web that aren't already watched and aren't the variable itself.
    const watchedIds = new Set((selectedNode.monitorWatches ?? []).map(w => w.nodeId));
    const candidates = nodes.filter(n =>
      webNodeIds.has(n.id) &&
      !watchedIds.has(n.id) &&
      n.type !== 'monitor' &&
      n.type !== 'area' &&
      n.type !== 'mirror' &&
      n.type !== 'text'
    );

    const monitorMorphs = getNodeTextMorphs(selectedNode, {
      start: selectedNode.animStartTime ?? 0,
      duration: selectedNode.animDuration ?? 0.5,
    });
    const updateMonitorMorphs = (nextMorphs) => updateNode(selectedNode.id, {
      textMorphs: normalizeTextMorphList(nextMorphs),
      morphText: '',
      morphMode: 'fade',
      morphStartDelay: null,
      morphStartTime: null,
      morphDuration: null,
    });

    return (
      <div style={wrap}>
        <Section title="Monitor" docAnchor="monitor" />
        <Row label="Title">
          <TextInput value={selectedNode.monitorTitle ?? ''} onChange={v => up('monitorTitle', v)} />
        </Row>
        <Row label="Initial">
          <TextInput value={selectedNode.initialValue ?? ''} onChange={v => up('initialValue', v)} />
        </Row>
        <Row label="Status">
          <NodeStatusControl node={selectedNode} onChange={updates => updateNode(selectedNode.id, updates)} />
        </Row>
        <Row label="Failures">
          <NodeFailureControls node={selectedNode} onChange={updates => updateNode(selectedNode.id, updates)} />
        </Row>
        <Row label="Width">
          <NumberInput value={selectedNode.width} min={120} max={600} onChange={v => up('width', v)} />
        </Row>
        <Row label="Height">
          <NumberInput value={selectedNode.height} min={48} max={400} onChange={v => up('height', v)} />
        </Row>
        <Row label="Fill">
          <ColorInput value={selectedNode.fill} onChange={v => up('fill', v)} />
        </Row>
        <Row label="Border">
          <ColorInput value={selectedNode.stroke} onChange={v => up('stroke', v)} />
        </Row>
        <Row label="Text color">
          <ColorInput value={selectedNode.textColor} onChange={v => up('textColor', v)} />
        </Row>
        <Row label="Font size">
          <NumberInput value={selectedNode.fontSize ?? 14} min={9} max={36} onChange={v => up('fontSize', v)} />
        </Row>
        <Row label="Value box">
          <ToggleInput
            checked={selectedNode.showMonitorTag !== false}
            onChange={v => up('showMonitorTag', v)}
            label="Draw a box around the value"
          />
        </Row>
        <Row label="Appear">
          <ToggleInput
            checked={!!selectedNode.disableAnimation}
            onChange={v => up('disableAnimation', v)}
            label="Instantly (no entry animation)"
          />
        </Row>

        <Section title="Variable / Token" docAnchor="variable" />
        <Row label="Track">
          <select
            value={selectedNode.variableNodeId ?? ''}
            onChange={(e) => setMonitorVariable(selectedNode.id, e.target.value || null)}
            style={SELECT_INPUT_STYLE}
          >
            <option value="">Choose source…</option>
            {variableNodes.length > 0 && (
              <optgroup label="Variable nodes">
                {variableNodes.map(v => {
                  const name = (v.variableLabel || '').trim() || v.label || 'Variable';
                  const value = (v.variableValue ?? '').trim();
                  return (
                    <option key={v.id} value={v.id}>
                      {value ? `${name} = ${value}` : name}
                    </option>
                  );
                })}
              </optgroup>
            )}
            {manualTokenLinks.length > 0 && (
              <optgroup label="Manual token links">
                {manualTokenLinks.map(link => {
                  const flowFrom = nodes.find(node => node.id === (link.manualTokenInvert ? link.toId : link.fromId));
                  const flowTo = nodes.find(node => node.id === (link.manualTokenInvert ? link.fromId : link.toId));
                  const name = (link.manualTokenVariableName ?? '').trim() || 'Unnamed token';
                  const baseText = getManualTokenBaseText(link, '');
                  const keys = normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes);
                  const currentText = getManualTokenTextAtTime(link, Number.POSITIVE_INFINITY, baseText);
                  const textPart = currentText ? ` · “${currentText}”` : '';
                  const keyPart = keys.length ? ` · ${keys.length} key${keys.length === 1 ? '' : 's'}` : '';
                  return (
                    <option key={link.id} value={getManualTokenTrackId(link.id)}>
                      {name} · {flowFrom?.label || 'Source'} → {flowTo?.label || 'Target'}{textPart}{keyPart}
                    </option>
                  );
                })}
              </optgroup>
            )}
          </select>
        </Row>
        {trackedManualToken && (
          <div style={{
            marginBottom: 12,
            padding: 10,
            borderRadius: 8,
            background: 'var(--panel-bg)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-muted)',
            fontSize: 11,
            lineHeight: 1.55,
          }}>
            <div style={{ color: 'var(--text-main)', fontWeight: 700, marginBottom: 3 }}>
              {(trackedManualToken.manualTokenVariableName ?? '').trim() || 'Unnamed manual token'}
            </div>
            <div>Route: {trackedManualFromNode?.label || 'Source'} → {trackedManualToNode?.label || 'Target'}</div>
            <div>Initial text: {getManualTokenBaseText(trackedManualToken, '') || '(blank)'}</div>
            <div>Text keyframes: {trackedManualKeys.length}</div>
          </div>
        )}

        {trackedVariable && (
          <>
            <Section title="Watched Nodes" hint="The monitor updates as the token passes each watched node — templates accept {value} and {name}" docAnchor="watched-nodes" />
            {webNodeIds.size === 0 && (
              <EmptyHint>No web yet — add an outgoing link to the variable.</EmptyHint>
            )}
          </>
        )}
        {trackedManualToken && (
          <Section title="Monitor Output" hint="Updates at each diamond text keyframe in the timeline — templates accept {value} and {name}" docAnchor="monitor-output" />
        )}
        {trackedSource && (selectedNode.monitorWatches ?? []).map(watch => {
          const watchedNode = nodes.find(n => n.id === watch.nodeId);
          return (
            <div
              key={watch.id}
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 8,
                background: 'var(--panel-bg)',
                border: '1px solid var(--border-strong)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {trackedManualToken ? 'Manual token text' : (watchedNode?.label ?? '(deleted)')}
                  {trackedManualToken && watch.nodeId === trackedManualToNode?.id && (
                    <span style={{
                      color: 'var(--blue-bright)',
                      fontSize: 8,
                      letterSpacing: '0.08em',
                      padding: '2px 5px',
                      borderRadius: 999,
                      border: '1px solid var(--border-strong)',
                    }}>
                      KEYFRAMED
                    </span>
                  )}
                </span>
                <button
                  onClick={() => removeMonitorWatch(selectedNode.id, watch.id)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 4,
                    color: 'var(--text-muted)',
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: '2px 8px',
                  }}
                >
                  Remove
                </button>
              </div>
              <Row label="Template">
                <TextInput
                  value={watch.template ?? '{value}'}
                  onChange={v => updateMonitorWatch(selectedNode.id, watch.id, { template: v })}
                />
              </Row>
            </div>
          );
        })}
        {trackedVariable && candidates.length > 0 && (
          <Row label="Add">
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) addMonitorWatch(selectedNode.id, e.target.value);
              }}
              style={SELECT_INPUT_STYLE}
            >
              <option value="">Choose node…</option>
              {candidates.map(n => (
                <option key={n.id} value={n.id}>{n.label || '(unnamed)'}</option>
              ))}
            </select>
          </Row>
        )}
        <Section title="Morphs" hint="Scripted value and color changes that override the tracked value — each morph gets a draggable block on this monitor's timeline row" docAnchor="morphs" />
        <div style={{ marginBottom: 10 }}>
          <ActionButton
            label="Add morph"
            onClick={() => updateMonitorMorphs([
              ...monitorMorphs,
              {
                id: uuid(),
                text: '',
                mode: 'fade',
                startTime: Math.round(getNextTextMorphStart(selectedNode, {
                  start: selectedNode.animStartTime ?? 0,
                  duration: selectedNode.animDuration ?? 0.5,
                }) * 100) / 100,
                duration: Math.max(0.4, selectedNode.animDuration ?? 0.5),
              },
            ])}
          />
        </div>
        {monitorMorphs.map((morph, index) => (
          <div
            key={morph.id}
            style={{
              marginBottom: 10,
              padding: 10,
              borderRadius: 8,
              background: 'var(--panel-bg)',
              border: '1px solid var(--border-strong)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600 }}>
                Morph {index + 1}
              </span>
              <button
                onClick={() => updateMonitorMorphs(monitorMorphs.filter(item => item.id !== morph.id))}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--danger-bright)',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: 0,
                }}
              >
                Remove
              </button>
            </div>
            <Row label="To">
              <TextInput
                value={morph.text}
                onChange={value => updateMonitorMorphs(monitorMorphs.map(item => (
                  item.id === morph.id ? { ...item, text: value } : item
                )))}
              />
            </Row>
            <Row label="Mode">
              <div style={{ display: 'flex', gap: 6 }}>
                <ModeChip
                  label="Fade"
                  active={morph.mode === 'fade'}
                  onClick={() => updateMonitorMorphs(monitorMorphs.map(item => (
                    item.id === morph.id ? { ...item, mode: 'fade' } : item
                  )))}
                />
                <ModeChip
                  label="Write"
                  active={morph.mode === 'write'}
                  onClick={() => updateMonitorMorphs(monitorMorphs.map(item => (
                    item.id === morph.id ? { ...item, mode: 'write' } : item
                  )))}
                />
              </div>
            </Row>
            <Row label="Text color">
              <ColorInput
                value={morph.textColor ?? selectedNode.textColor}
                onChange={value => updateMonitorMorphs(monitorMorphs.map(item => (
                  item.id === morph.id ? { ...item, textColor: value } : item
                )))}
              />
            </Row>
            <Row label="Start">
              <NumberInput
                value={morph.startTime}
                min={0}
                step={0.05}
                onChange={value => updateMonitorMorphs(monitorMorphs.map(item => (
                  item.id === morph.id ? { ...item, startTime: Math.round(Math.max(0, value) * 100) / 100 } : item
                )))}
              />
            </Row>
            <Row label="Duration">
              <NumberInput
                value={morph.duration}
                min={0.1}
                step={0.05}
                onChange={value => updateMonitorMorphs(monitorMorphs.map(item => (
                  item.id === morph.id ? { ...item, duration: Math.round(Math.max(0.1, value) * 100) / 100 } : item
                )))}
              />
            </Row>
          </div>
        ))}

        <div style={{ flex: 1 }} />
        <button
          onClick={() => removeNode(selectedNode.id)}
          style={{
            marginTop: 20,
            background: 'var(--danger-surface-soft)',
            border: '1px solid var(--danger-border-soft)',
            borderRadius: 6,
            color: 'var(--danger-bright)',
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Delete monitor
        </button>
      </div>
    );
  }

  if (selectedNode) {
    const up = (key, value) => updateNode(selectedNode.id, { [key]: value });
    const isMirror = isMirrorNode(selectedNode);
    const isTextNode = selectedNode.type === 'text';
    // Equation display works for any node that renders a label (graph nodes
    // use a separate formula field, so they're excluded here).
    const supportsEquation = !isMirror && selectedNode.type !== 'graph';
    const transformTargets = nodes.filter(node => (
      node.id !== selectedNode.id &&
      node.type !== 'area' &&
      node.type !== 'mirror' &&
      node.type !== 'text'
    ));
    const resolveMode = getResolveMode(selectedNode);
    const activeTransformTarget = transformTargets.find(node => node.id === selectedNode.transformTargetNodeId) ?? null;
    const updateResolveTarget = (updates) => updateNode(selectedNode.id, {
      transformTarget: {
        ...buildResolveTargetFromNode(activeTransformTarget, selectedNode),
        ...(selectedNode.transformTarget ?? {}),
        ...updates,
      },
    });
    const setResolveMode = (mode) => {
      if (mode === 'custom') {
        updateNode(selectedNode.id, {
          transformMode: 'custom',
          transformTarget: {
            ...buildResolveTargetFromNode(activeTransformTarget, selectedNode),
            ...(selectedNode.transformTarget ?? {}),
          },
        });
        return;
      }
      updateNode(selectedNode.id, { transformMode: mode });
    };
    const mirrorSources = isMirror ? getMirrorSourceItems(selectedNode, nodes, links) : { sourceNodes: [], sourceLinks: [] };
    // Morphs are available for every node type (text, box, graph, variable…),
    // so the inspector can quickly add/edit them without opening the timeline.
    const textMorphs = getNodeTextMorphs(selectedNode, {
      start: selectedNode.animStartTime ?? 0,
      duration: selectedNode.animDuration ?? 0.5,
    });
    const updateTextMorphs = (nextMorphs) => updateNode(selectedNode.id, {
      textMorphs: normalizeTextMorphList(nextMorphs),
      morphText: '',
      morphMode: 'fade',
      morphStartDelay: null,
      morphStartTime: null,
      morphDuration: null,
    });
    const captureMirrorSources = () => {
      const state = useStore.getState();
      const selectionIds = [...new Set([...(state.selectedIds ?? []), state.selectedId].filter(Boolean))];
      const selectionPayload = getMirrorSelectionPayload(selectionIds, nodes, links, selectedNode.id);
      const hasSelectionSources = selectionPayload.sourceNodeIds.length > 0 || selectionPayload.sourceLinkIds.length > 0;
      const payload = hasSelectionSources
        ? selectionPayload
        : getMirrorOverlapPayload(selectedNode, nodes, links);
      captureMirrorSelection(selectedNode.id, [...payload.sourceNodeIds, ...payload.sourceLinkIds]);
    };

    return (
      <div style={wrap}>
        <Section title={isMirror ? 'Mirror' : isTextNode ? 'Text' : 'Node'} docAnchor={isMirror ? 'mirror' : isTextNode ? 'text-node' : 'node'} />

        {isMirror ? (
          <>
            <Row label="Mode">
              <div style={{ display: 'flex', gap: 6 }}>
                <ModeChip
                  label="Mirror"
                  active={(selectedNode.mirrorMode ?? 'mirror') === 'mirror'}
                  onClick={() => up('mirrorMode', 'mirror')}
                />
                <ModeChip
                  label="Exact"
                  active={selectedNode.mirrorMode === 'exact'}
                  onClick={() => up('mirrorMode', 'exact')}
                />
              </div>
            </Row>
            <Row label="Width">
              <NumberInput value={selectedNode.width} min={180} max={900} onChange={v => up('width', v)} />
            </Row>
            <Row label="Height">
              <NumberInput value={selectedNode.height} min={120} max={700} onChange={v => up('height', v)} />
            </Row>
            <Row label="Frame">
              <ColorInput value={selectedNode.stroke} onChange={v => up('stroke', v)} />
            </Row>
            <Row label="Selection">
              <button
                onClick={captureMirrorSources}
                style={{
                  background: 'var(--panel-bg)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 6,
                  color: 'var(--text-main)',
                  padding: '6px 10px',
                  fontSize: 11,
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                Use current selection
              </button>
            </Row>
            <Section title="Source" hint="Geometry and timing follow the captured source objects; text and color below can diverge inside this mirror" docAnchor="mirror-source" />
            <EmptyHint>
              {mirrorSources.sourceNodes.length} node{mirrorSources.sourceNodes.length !== 1 ? 's' : ''} · {mirrorSources.sourceLinks.length} link{mirrorSources.sourceLinks.length !== 1 ? 's' : ''}
            </EmptyHint>
            {mirrorSources.sourceNodes.map((sourceNode) => {
              const override = selectedNode.mirrorNodeOverrides?.[sourceNode.id] ?? {};
              return (
                <div
                  key={sourceNode.id}
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    borderRadius: 8,
                    background: 'var(--panel-bg)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <div style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
                    {sourceNode.label}
                  </div>
                  <Row label="Text">
                    <TextInput
                      value={override.label ?? sourceNode.label}
                      onChange={value => updateMirrorNodeOverride(selectedNode.id, sourceNode.id, { label: value })}
                    />
                  </Row>
                  <Row label="Text color">
                    <ColorInput
                      value={override.textColor ?? sourceNode.textColor}
                      onChange={value => updateMirrorNodeOverride(selectedNode.id, sourceNode.id, { textColor: value })}
                    />
                  </Row>
                  {sourceNode.type !== 'text' && (
                    <>
                      <Row label="Fill">
                        <ColorInput
                          value={override.fill ?? sourceNode.fill}
                          onChange={value => updateMirrorNodeOverride(selectedNode.id, sourceNode.id, { fill: value })}
                        />
                      </Row>
                      <Row label="Border">
                        <ColorInput
                          value={override.stroke ?? sourceNode.stroke}
                          onChange={value => updateMirrorNodeOverride(selectedNode.id, sourceNode.id, { stroke: value })}
                        />
                      </Row>
                    </>
                  )}
                </div>
              );
            })}
            {mirrorSources.sourceLinks.length > 0 && <Section title="Link Colors" />}
            {mirrorSources.sourceLinks.map((sourceLink, index) => {
              const override = selectedNode.mirrorLinkOverrides?.[sourceLink.id] ?? {};
              const fromNode = nodes.find(node => node.id === sourceLink.fromId);
              const toNode = nodes.find(node => node.id === sourceLink.toId);
              return (
                <div
                  key={sourceLink.id}
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    borderRadius: 8,
                    background: 'var(--panel-bg)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <div style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
                    {fromNode?.label ?? `Link ${index + 1}`} → {toNode?.label ?? ''}
                  </div>
                  <Row label="Color">
                    <ColorInput
                      value={override.stroke ?? sourceLink.stroke}
                      onChange={value => updateMirrorLinkOverride(selectedNode.id, sourceLink.id, { stroke: value })}
                    />
                  </Row>
                </div>
              );
            })}

            <div style={{ flex: 1 }} />
            <button
              onClick={() => removeNode(selectedNode.id)}
              style={{
                marginTop: 20,
                background: 'var(--danger-surface-soft)',
                border: '1px solid var(--danger-border-soft)',
                borderRadius: 6,
                color: 'var(--danger-bright)',
                padding: '6px 12px',
                fontSize: 12,
                cursor: 'pointer',
                width: '100%',
              }}
            >
              Delete mirror
            </button>
          </>
        ) : (
          <>

        <Row label="Label">
          <TextInput value={selectedNode.label} onChange={v => up('label', v)} />
        </Row>
        <Row label="Bold">
          <ToggleInput
            checked={!!selectedNode.bold}
            onChange={v => up('bold', v)}
            label="Bold label text"
          />
        </Row>
        {selectedNode.type !== 'area' && (
          <>
            <Row label="Status">
              <NodeStatusControl node={selectedNode} onChange={updates => updateNode(selectedNode.id, updates)} />
            </Row>
            <Row label="Failures">
              <NodeFailureControls node={selectedNode} onChange={updates => updateNode(selectedNode.id, updates)} />
            </Row>
          </>
        )}
        {supportsEquation && (
          <>
            <Row label="Display">
              <div style={{ display: 'flex', gap: 6 }}>
                <ModeChip
                  label="Plain"
                  active={!selectedNode.equationMode}
                  onClick={() => up('equationMode', false)}
                />
                <ModeChip
                  label="Equation"
                  active={!!selectedNode.equationMode}
                  onClick={() => up('equationMode', true)}
                />
              </div>
            </Row>
            {selectedNode.equationMode && (
              <div
                title={'Syntax: x^2 · a_i · \\frac{a}{b} · \\sqrt{x} · \\alpha · \\sum_{i=1}^{n}'}
                style={{
                  margin: '-2px 0 12px 80px',
                  padding: '10px 12px',
                  borderRadius: 7,
                  background: 'var(--panel-bg)',
                  border: '1px solid var(--border-strong)',
                  cursor: 'help',
                }}
              >
                <div style={{
                  minHeight: 26,
                  color: 'var(--text-main)',
                  fontFamily: EQUATION_FONT_FAMILY,
                  fontSize: 18,
                  lineHeight: 1.35,
                  overflowWrap: 'anywhere',
                }}>
                  {formatEquationText(selectedNode.label) || 'x² + y² = r²'}
                </div>
              </div>
            )}
          </>
        )}
        {selectedNode.type === 'graph' && (
          <>
            <Row label="Formula" title={'Accepts "y = …" or "y^2 = …" — for elliptic curves use "y^2 = x^3 + a*x + b"'}>
              <TextInput
                value={selectedNode.formula ?? ''}
                title={'Accepts "y = …" or "y^2 = …" — for elliptic curves use "y^2 = x^3 + a*x + b"'}
                onChange={v => up('formula', v)}
              />
            </Row>
            <Row label="Params">
              <TextInput value={selectedNode.graphParams ?? ''} onChange={v => up('graphParams', v)} />
            </Row>
            <Row label="X min">
              <NumberInput value={Number.isFinite(selectedNode.xMin) ? selectedNode.xMin : -10} min={-1000} max={1000} step={0.5} onChange={v => up('xMin', v)} />
            </Row>
            <Row label="X max">
              <NumberInput value={Number.isFinite(selectedNode.xMax) ? selectedNode.xMax : 10} min={-1000} max={1000} step={0.5} onChange={v => up('xMax', v)} />
            </Row>
            <Row label="Center X">
              <input
                type="text"
                value={Number.isFinite(selectedNode.centerX) ? String(selectedNode.centerX) : ''}
                placeholder="auto (0)"
                onChange={e => {
                  const s = e.target.value.trim();
                  if (s === '') up('centerX', null);
                  else {
                    const n = Number(s);
                    if (Number.isFinite(n)) up('centerX', n);
                  }
                }}
                style={SELECT_INPUT_STYLE}
              />
            </Row>
            <Row label="Y min">
              <input
                type="text"
                value={Number.isFinite(selectedNode.yMin) ? String(selectedNode.yMin) : ''}
                placeholder="auto"
                onChange={e => {
                  const s = e.target.value.trim();
                  if (s === '') up('yMin', null);
                  else {
                    const n = Number(s);
                    if (Number.isFinite(n)) up('yMin', n);
                  }
                }}
                style={SELECT_INPUT_STYLE}
              />
            </Row>
            <Row label="Y max">
              <input
                type="text"
                value={Number.isFinite(selectedNode.yMax) ? String(selectedNode.yMax) : ''}
                placeholder="auto"
                onChange={e => {
                  const s = e.target.value.trim();
                  if (s === '') up('yMax', null);
                  else {
                    const n = Number(s);
                    if (Number.isFinite(n)) up('yMax', n);
                  }
                }}
                style={SELECT_INPUT_STYLE}
              />
            </Row>
            <Row label="Center Y">
              <input
                type="text"
                value={Number.isFinite(selectedNode.centerY) ? String(selectedNode.centerY) : ''}
                placeholder="auto (0)"
                onChange={e => {
                  const s = e.target.value.trim();
                  if (s === '') up('centerY', null);
                  else {
                    const n = Number(s);
                    if (Number.isFinite(n)) up('centerY', n);
                  }
                }}
                style={SELECT_INPUT_STYLE}
              />
            </Row>
            <Row label="Samples">
              <NumberInput value={Number.isFinite(selectedNode.samples) ? selectedNode.samples : 400} min={50} max={2000} step={10} onChange={v => up('samples', v)} />
            </Row>
            <Row label="Axes">
              <ToggleInput checked={selectedNode.showAxes ?? true} onChange={v => up('showAxes', v)} label="Show axes" />
            </Row>
            <Row label="Coords">
              <ToggleInput checked={!!selectedNode.showCoords} onChange={v => up('showCoords', v)} label="Show coordinates (hover)" />
            </Row>
            {/* Points now appear at runtime based on vector playback when Sequential is enabled */}

            <Section title="Domain Separation (HKDF)" hint="Each circle is an independent HKDF output domain — when two overlap, the one higher in this list wins (use ↑/↓ to set priority)" docAnchor="hkdf" />
            <Row label="Domains">
              <ToggleInput checked={!!selectedNode.showDomains} onChange={v => up('showDomains', v)} label="Show domain circles" />
            </Row>
            {selectedNode.showDomains && (
              <>
                <button
                  onClick={() => {
                    const palette = ['#A66BFF', '#4FC3F7', '#FF7AB6', '#7CE0A3', '#FFD166', '#FF8A5B'];
                    const existing = selectedNode.graphDomains ?? [];
                    const color = palette[existing.length % palette.length];
                    const cx = Number.isFinite(selectedNode.centerX) ? selectedNode.centerX : 0;
                    const cy = Number.isFinite(selectedNode.centerY) ? selectedNode.centerY : 0;
                    up('graphDomains', [
                      ...existing,
                      { id: uuid(), label: `info_${existing.length + 1}`, cx, cy, r: 2, color, startTime: 0, duration: 0.4 },
                    ]);
                  }}
                  style={{
                    width: '100%',
                    marginBottom: 8,
                    background: 'var(--purple-surface-soft)',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 6,
                    color: 'var(--text-main)',
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '6px 0',
                    cursor: 'pointer',
                  }}
                >
                  + Add domain
                </button>
                {(selectedNode.graphDomains ?? []).map((d, idx) => {
                  const patch = (changes) => up(
                    'graphDomains',
                    (selectedNode.graphDomains ?? []).map(x => x.id === d.id ? { ...x, ...changes } : x)
                  );
                  return (
                    <div key={d.id} style={{
                      marginBottom: 8,
                      padding: 8,
                      borderRadius: 8,
                      background: 'var(--panel-bg)',
                      border: '1px solid var(--border-strong)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600 }}>
                          Domain {idx + 1}{idx === 0 ? ' · top' : ''}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button
                            title="Move up (higher priority — wins overlaps)"
                            disabled={idx === 0}
                            onClick={() => {
                              const list = [...(selectedNode.graphDomains ?? [])];
                              [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
                              up('graphDomains', list);
                            }}
                            style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: idx === 0 ? 'var(--text-dim)' : 'var(--text-main)', fontSize: 10, padding: '2px 6px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.4 : 1 }}
                          >
                            ↑
                          </button>
                          <button
                            title="Move down (lower priority)"
                            disabled={idx === (selectedNode.graphDomains ?? []).length - 1}
                            onClick={() => {
                              const list = [...(selectedNode.graphDomains ?? [])];
                              [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
                              up('graphDomains', list);
                            }}
                            style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: idx === (selectedNode.graphDomains ?? []).length - 1 ? 'var(--text-dim)' : 'var(--text-main)', fontSize: 10, padding: '2px 6px', cursor: idx === (selectedNode.graphDomains ?? []).length - 1 ? 'default' : 'pointer', opacity: idx === (selectedNode.graphDomains ?? []).length - 1 ? 0.4 : 1 }}
                          >
                            ↓
                          </button>
                          <button
                            onClick={() => up('graphDomains', (selectedNode.graphDomains ?? []).filter(x => x.id !== d.id))}
                            style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--danger-bright)', fontSize: 10, padding: '2px 8px', cursor: 'pointer' }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      <Row label="Label">
                        <TextInput value={d.label ?? ''} onChange={v => patch({ label: v })} />
                      </Row>
                      <Row label="Label color">
                        <ColorInput value={d.labelColor ?? d.color ?? '#FFFFFF'} onChange={v => patch({ labelColor: v })} />
                      </Row>
                      <Row label="Label size">
                        <NumberInput value={Number.isFinite(d.labelSize) ? d.labelSize : 11} min={6} max={48} step={1} onChange={v => patch({ labelSize: Math.max(6, Math.round(v)) })} />
                      </Row>
                      <Row label="Color">
                        <ColorInput value={d.color ?? '#A66BFF'} onChange={v => patch({ color: v })} />
                      </Row>
                      <Row label="Center X">
                        <NumberInput value={Number.isFinite(d.cx) ? d.cx : 0} min={-1e6} max={1e6} step={0.25} onChange={v => patch({ cx: v })} />
                      </Row>
                      <Row label="Center Y">
                        <NumberInput value={Number.isFinite(d.cy) ? d.cy : 0} min={-1e6} max={1e6} step={0.25} onChange={v => patch({ cy: v })} />
                      </Row>
                      <Row label="Radius">
                        <NumberInput value={Number.isFinite(d.r) ? d.r : 1} min={0.1} max={1e6} step={0.25} onChange={v => patch({ r: Math.max(0.1, v) })} />
                      </Row>
                      <Row label="Appear at">
                        <NumberInput value={Number.isFinite(d.startTime) ? d.startTime : 0} min={0} max={1e6} step={0.1} onChange={v => patch({ startTime: Math.max(0, v) })} />
                        <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 4 }}>s</span>
                        <button
                          title="Set to current playhead"
                          onClick={() => patch({ startTime: Math.round(getTimelineCursor() * 100) / 100 })}
                          style={{ marginLeft: 6, background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-main)', fontSize: 10, padding: '2px 6px', cursor: 'pointer' }}
                        >
                          ⊙
                        </button>
                      </Row>

                      {/* "Calculate" keyframe — scatter derived dots inside the domain */}
                      {!d.calc ? (
                        <button
                          onClick={() => patch({ calc: {
                            time: Math.round(getTimelineCursor() * 100) / 100,
                            duration: 1,
                            count: 16,
                            dotColor: d.color ?? '#A66BFF',
                            dotSize: 2.5,
                            seed: 1,
                          } })}
                          style={{ width: '100%', marginTop: 6, background: 'var(--panel-bg-3)', border: '1px dashed var(--border-strong)', borderRadius: 6, color: 'var(--text-main)', fontSize: 11, fontWeight: 600, padding: '5px 0', cursor: 'pointer' }}
                        >
                          + Add calculate keyframe
                        </button>
                      ) : (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border-strong)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <span style={{ color: 'var(--purple-bright)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Calculate</span>
                            <button
                              onClick={() => patch({ calc: null })}
                              style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--danger-bright)', fontSize: 10, padding: '2px 8px', cursor: 'pointer' }}
                            >
                              Remove
                            </button>
                          </div>
                          <Row label="Calc at">
                            <NumberInput value={Number.isFinite(d.calc.time) ? d.calc.time : 0} min={0} max={1e6} step={0.1} onChange={v => patch({ calc: { ...d.calc, time: Math.max(0, v) } })} />
                            <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 4 }}>s</span>
                            <button
                              title="Set to current playhead"
                              onClick={() => patch({ calc: { ...d.calc, time: Math.round(getTimelineCursor() * 100) / 100 } })}
                              style={{ marginLeft: 6, background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-main)', fontSize: 10, padding: '2px 6px', cursor: 'pointer' }}
                            >
                              ⊙
                            </button>
                          </Row>
                          <Row label="Duration">
                            <NumberInput value={Number.isFinite(d.calc.duration) ? d.calc.duration : 1} min={0.1} max={1e6} step={0.1} onChange={v => patch({ calc: { ...d.calc, duration: Math.max(0.1, v) } })} />
                            <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 4 }}>s</span>
                          </Row>
                          <Row label="Dots">
                            <NumberInput value={Number.isFinite(d.calc.count) ? d.calc.count : 16} min={1} max={400} step={1} onChange={v => patch({ calc: { ...d.calc, count: Math.max(1, Math.round(v)) } })} />
                          </Row>
                          <Row label="Dot size">
                            <NumberInput value={Number.isFinite(d.calc.dotSize) ? d.calc.dotSize : 2.5} min={0.5} max={20} step={0.5} onChange={v => patch({ calc: { ...d.calc, dotSize: Math.max(0.5, v) } })} />
                          </Row>
                          <Row label="Dot color">
                            <ColorInput value={d.calc.dotColor ?? d.color ?? '#A66BFF'} onChange={v => patch({ calc: { ...d.calc, dotColor: v } })} />
                          </Row>
                          <button
                            title="Shuffle the scatter layout"
                            onClick={() => patch({ calc: { ...d.calc, seed: (Number.isFinite(d.calc.seed) ? d.calc.seed : 1) + 1 } })}
                            style={{ width: '100%', marginTop: 4, background: 'var(--panel-bg-3)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-main)', fontSize: 11, padding: '4px 0', cursor: 'pointer' }}
                          >
                            ⟳ Re-scatter
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            <Section title="Vectors" docAnchor="vectors" />
            <Row label="Color">
              <ColorInput value={selectedNode.vectorColorDefault ?? '#FFFFFF'} onChange={v => up('vectorColorDefault', v)} />
            </Row>
            <Row label="Width">
              <NumberInput value={Number.isFinite(selectedNode.vectorWidthDefault) ? selectedNode.vectorWidthDefault : 1.5} min={0.5} max={10} step={0.1} onChange={v => up('vectorWidthDefault', Math.max(0.5, v))} />
            </Row>
            <Row label="Head length">
              <NumberInput value={Number.isFinite(selectedNode.vectorHeadLengthDefault) ? selectedNode.vectorHeadLengthDefault : 8} min={1} max={40} step={1} onChange={v => up('vectorHeadLengthDefault', Math.max(1, v))} />
            </Row>
            <Row label="Head width">
              <NumberInput value={Number.isFinite(selectedNode.vectorHeadWidthDefault) ? selectedNode.vectorHeadWidthDefault : 8} min={1} max={40} step={1} onChange={v => up('vectorHeadWidthDefault', Math.max(1, v))} />
            </Row>
            <Row label="Speed">
              <NumberInput
                value={Number.isFinite(selectedNode.vectorSpeed) ? selectedNode.vectorSpeed : 0.2}
                min={0.01}
                max={10}
                step={0.01}
                onChange={v => up('vectorSpeed', Math.max(0.01, v))}
              />
              <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 4 }}>s</span>
            </Row>
            <Row label="Chain">
              <ToggleInput checked={!!selectedNode.graphChainPlayback} onChange={v => up('graphChainPlayback', v)} label="Chain points & vectors (join all points)" />
            </Row>

            <Section title="Point Defaults" docAnchor="point-defaults" />
            <Row label="Size">
              <NumberInput value={Number.isFinite(selectedNode.graphPointSizeDefault) ? selectedNode.graphPointSizeDefault : 4} min={1} max={24} step={1} onChange={v => up('graphPointSizeDefault', Math.max(1, v))} />
            </Row>
            <Row label="Fill">
              <ColorInput value={selectedNode.graphPointFillDefault ?? '#A66BFF'} onChange={v => up('graphPointFillDefault', v)} />
            </Row>
            <Row label="Stroke">
              <ColorInput value={selectedNode.graphPointStrokeDefault ?? '#FFFFFF'} onChange={v => up('graphPointStrokeDefault', v)} />
            </Row>

            <Section title="Points" hint="Shift+click the graph to add a point; Alt+click a point to remove it" docAnchor="equation-points" />
            {(selectedNode.graphPoints ?? []).length === 0 && (
              <EmptyHint>Shift+click the graph to add a point.</EmptyHint>
            )}
            {(selectedNode.graphPoints ?? []).map((pt, idx) => (
              <div key={pt.id} style={{
                marginBottom: 8,
                padding: 8,
                borderRadius: 8,
                background: 'var(--panel-bg)',
                border: '1px solid var(--border-strong)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600 }}>Point {idx + 1}</span>
                  <button
                    onClick={() => updateNode(selectedNode.id, { graphPoints: (selectedNode.graphPoints ?? []).filter(p => p.id !== pt.id) })}
                    style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--danger-bright)', fontSize: 10, padding: '2px 8px', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </div>
                <Row label="X">
                  <NumberInput value={pt.x} min={-1e6} max={1e6} step={0.05} onChange={v => {
                    const next = (selectedNode.graphPoints ?? []).map(p => p.id === pt.id ? { ...p, x: v } : p);
                    updateNode(selectedNode.id, { graphPoints: next });
                  }} />
                </Row>
                <Row label="Y">
                  <NumberInput value={pt.y} min={-1e6} max={1e6} step={0.05} onChange={v => {
                    const next = (selectedNode.graphPoints ?? []).map(p => p.id === pt.id ? { ...p, y: v } : p);
                    updateNode(selectedNode.id, { graphPoints: next });
                  }} />
                </Row>
                {/* In chain mode, point timing is derived from vectorSpeed; otherwise, per-point keyframes apply. */}
                <Row label="Size">
                  <NumberInput value={Number.isFinite(pt.size) ? pt.size : (selectedNode.graphPointSizeDefault ?? 4)} min={1} max={24} step={1} onChange={v => {
                    const next = (selectedNode.graphPoints ?? []).map(p => p.id === pt.id ? { ...p, size: Math.max(1, v) } : p);
                    updateNode(selectedNode.id, { graphPoints: next });
                  }} />
                </Row>
                <Row label="Fill">
                  <ColorInput value={pt.fill ?? (selectedNode.graphPointFillDefault ?? '#A66BFF')} onChange={v => {
                    const next = (selectedNode.graphPoints ?? []).map(p => p.id === pt.id ? { ...p, fill: v } : p);
                    updateNode(selectedNode.id, { graphPoints: next });
                  }} />
                </Row>
                <Row label="Stroke">
                  <ColorInput value={pt.stroke ?? (selectedNode.graphPointStrokeDefault ?? '#FFFFFF')} onChange={v => {
                    const next = (selectedNode.graphPoints ?? []).map(p => p.id === pt.id ? { ...p, stroke: v } : p);
                    updateNode(selectedNode.id, { graphPoints: next });
                  }} />
                </Row>

                {/* Per-point vectors */}
                {(() => {
                  const pts = selectedNode.graphPoints ?? [];
                  const others = pts.filter(p => p.id !== pt.id);
                  const outgoing = (selectedNode.graphVectors ?? []).filter(v => v.fromId === pt.id);
                  return (
                    <div style={{ marginTop: 6 }}>
                      <Row label="Vector to">
                        <select
                          value={''}
                          disabled={others.length === 0}
                          onChange={(e) => {
                            const toId = e.target.value || null;
                            if (!toId) return;
                            const cur = selectedNode.graphVectors ?? [];
                            if (cur.some(v => v.fromId === pt.id && v.toId === toId)) return; // avoid duplicates
                            const next = [ ...cur, { id: uuid(), fromId: pt.id, toId } ];
                            updateNode(selectedNode.id, { graphVectors: next });
                          }}
                          style={SELECT_INPUT_STYLE}
                        >
                          <option value="">{others.length ? 'Add vector…' : 'No other points'}</option>
                          {others.map((p, i) => (
                            <option key={p.id} value={p.id}>Point {pts.findIndex(x => x.id === p.id) + 1} ({(p.x ?? 0).toFixed(2)}, {(p.y ?? 0).toFixed(2)})</option>
                          ))}
                        </select>
                      </Row>
                      {outgoing.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {outgoing.map(v => {
                            const toIdx = pts.findIndex(p => p.id === v.toId);
                            return (
                              <div key={v.id} style={{ display: 'grid', gridTemplateColumns: '1fr 72px 86px 86px 86px auto', alignItems: 'center', gap: 6, marginLeft: 72 }}>
                                <span style={{ color: 'var(--text-main)', fontSize: 11 }}>
                                  → Point {toIdx >= 0 ? toIdx + 1 : '?'}
                                </span>
                                <input
                                  type="color"
                                  value={toColorInputValue(v.color ?? selectedNode.vectorColorDefault, '#ffffff')}
                                  onChange={e => {
                                    const next = (selectedNode.graphVectors ?? []).map(x => x.id === v.id ? { ...x, color: e.target.value } : x);
                                    updateNode(selectedNode.id, { graphVectors: next });
                                  }}
                                  style={{ width: 28, height: 20, padding: 0, border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}
                                />
                                <input
                                  type="number"
                                  value={Number.isFinite(v.width) ? v.width : (selectedNode.vectorWidthDefault ?? 1.5)}
                                  min={0.5}
                                  max={10}
                                  step={0.1}
                                  onChange={e => {
                                    const n = Number(e.target.value);
                                    const next = (selectedNode.graphVectors ?? []).map(x => x.id === v.id ? { ...x, width: Math.max(0.5, n) } : x);
                                    updateNode(selectedNode.id, { graphVectors: next });
                                  }}
                                  style={{ width: 86, background: 'var(--panel-bg)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-main)', padding: '3px 7px', fontSize: 12 }}
                                />
                                <input
                                  type="number"
                                  value={Number.isFinite(v.headLength) ? v.headLength : (selectedNode.vectorHeadLengthDefault ?? 8)}
                                  min={1}
                                  max={40}
                                  step={1}
                                  onChange={e => {
                                    const n = Number(e.target.value);
                                    const next = (selectedNode.graphVectors ?? []).map(x => x.id === v.id ? { ...x, headLength: Math.max(1, n) } : x);
                                    updateNode(selectedNode.id, { graphVectors: next });
                                  }}
                                  style={{ width: 86, background: 'var(--panel-bg)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-main)', padding: '3px 7px', fontSize: 12 }}
                                />
                                <input
                                  type="number"
                                  value={Number.isFinite(v.headWidth) ? v.headWidth : (selectedNode.vectorHeadWidthDefault ?? 8)}
                                  min={1}
                                  max={40}
                                  step={1}
                                  onChange={e => {
                                    const n = Number(e.target.value);
                                    const next = (selectedNode.graphVectors ?? []).map(x => x.id === v.id ? { ...x, headWidth: Math.max(1, n) } : x);
                                    updateNode(selectedNode.id, { graphVectors: next });
                                  }}
                                  style={{ width: 86, background: 'var(--panel-bg)', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-main)', padding: '3px 7px', fontSize: 12 }}
                                />
                                <button
                                  onClick={() => updateNode(selectedNode.id, { graphVectors: (selectedNode.graphVectors ?? []).filter(x => x.id !== v.id) })}
                                  style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--danger-bright)', fontSize: 10, padding: '2px 8px', cursor: 'pointer', justifySelf: 'end' }}
                                >
                                  Remove
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}
          </>
        )}
        {!isTextNode && (
          <Row label="Shape">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {NODE_SHAPE_OPTIONS.map((shape) => (
                <ModeChip
                  key={shape.key}
                  label={shape.label}
                  active={(selectedNode.shape ?? 'rounded') === shape.key}
                  onClick={() => updateNode(selectedNode.id, NODE_SHAPE_PRESETS[shape.key])}
                />
              ))}
            </div>
          </Row>
        )}
        <Row label="Text">
          <ColorInput value={selectedNode.textColor} onChange={v => up('textColor', v)} />
        </Row>
        <Row label="Aura">
          <ToggleInput checked={!!selectedNode.textAura} onChange={v => up('textAura', v)} label="Enable aura around text" />
        </Row>
        {selectedNode.textAura && (
          <>
            <Row label="Aura mode">
              <div style={{ display: 'flex', gap: 6 }}>
                <ModeChip
                  label="Cutout"
                  active={(selectedNode.textAuraMode ?? 'cutout') === 'cutout'}
                  onClick={() => up('textAuraMode', 'cutout')}
                />
                <ModeChip
                  label="Solid color"
                  active={selectedNode.textAuraMode === 'solid'}
                  onClick={() => up('textAuraMode', 'solid')}
                />
              </div>
            </Row>
            {selectedNode.textAuraMode === 'solid' && (
              <Row label="Aura color">
                <ColorInput value={selectedNode.textAuraColor} onChange={v => up('textAuraColor', v)} />
              </Row>
            )}
            <Row label="Aura strength">
              <NumberInput value={Number.isFinite(selectedNode.textAuraOpacity) ? selectedNode.textAuraOpacity : 0.7} min={0} max={1} step={0.05} onChange={v => up('textAuraOpacity', Math.max(0, Math.min(1, v)))} />
            </Row>
            <Row label="Aura size">
              <NumberInput value={Number.isFinite(selectedNode.textAuraSize) ? selectedNode.textAuraSize : 16} min={0} max={80} step={1} onChange={v => up('textAuraSize', Math.max(0, v))} />
            </Row>
          </>
        )}
        {isTextNode && (
          <Row label="Animate">
            <div style={{ display: 'flex', gap: 6 }}>
              <ModeChip
                label="Fade in"
                active={(selectedNode.textAnimMode ?? 'fade') === 'fade'}
                onClick={() => up('textAnimMode', 'fade')}
              />
              <ModeChip
                label="Write out"
                active={selectedNode.textAnimMode === 'write'}
                onClick={() => up('textAnimMode', 'write')}
              />
            </div>
          </Row>
        )}
        <Row label="Font size">
          <NumberInput value={selectedNode.fontSize} min={8} max={36} onChange={v => up('fontSize', v)} />
        </Row>
        <Row label="Appear">
          <ToggleInput
            checked={!!selectedNode.disableAnimation}
            onChange={v => up('disableAnimation', v)}
            label="Instantly (no entry animation)"
          />
        </Row>
        {isTextNode ? (
          <>
            <Row label="Padding X" title="Invisible zone around the text where links can attach">
              <NumberInput value={selectedNode.textPadX ?? 14} min={6} max={80} onChange={v => up('textPadX', v)} />
            </Row>
            <Row label="Padding Y" title="Invisible zone around the text where links can attach">
              <NumberInput value={selectedNode.textPadY ?? 8} min={4} max={60} onChange={v => up('textPadY', v)} />
            </Row>
            <Section title="Morphs" hint="Scripted text changes — each morph gets a draggable block on this text's timeline row" docAnchor="morphs" />
            <div style={{ marginBottom: 10 }}>
              <ActionButton
                label="Add morph"
                onClick={() => updateTextMorphs([
                  ...textMorphs,
                  {
                    id: uuid(),
                    text: '',
                    mode: 'fade',
                    startTime: Math.round(getNextTextMorphStart(selectedNode, {
                      start: selectedNode.animStartTime ?? 0,
                      duration: selectedNode.animDuration ?? 0.5,
                    }) * 100) / 100,
                    duration: Math.max(0.4, selectedNode.animDuration ?? 0.5),
                  },
                ])}
              />
            </div>
            {textMorphs.map((morph, index) => (
              <div
                key={morph.id}
                style={{
                  marginBottom: 10,
                  padding: 10,
                  borderRadius: 8,
                  background: 'var(--panel-bg)',
                  border: '1px solid var(--border-strong)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600 }}>
                    Morph {index + 1}
                  </span>
                  <button
                    onClick={() => updateTextMorphs(textMorphs.filter(item => item.id !== morph.id))}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--danger-bright)',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    Remove
                  </button>
                </div>
                <Row label="To">
                  <TextInput
                    value={morph.text}
                    onChange={value => updateTextMorphs(textMorphs.map(item => (
                      item.id === morph.id ? { ...item, text: value } : item
                    )))}
                  />
                </Row>
                <Row label="Mode">
                  <div style={{ display: 'flex', gap: 6 }}>
                    <ModeChip
                      label="Fade"
                      active={morph.mode === 'fade'}
                      onClick={() => updateTextMorphs(textMorphs.map(item => (
                        item.id === morph.id ? { ...item, mode: 'fade' } : item
                      )))}
                    />
                    <ModeChip
                      label="Write"
                      active={morph.mode === 'write'}
                      onClick={() => updateTextMorphs(textMorphs.map(item => (
                        item.id === morph.id ? { ...item, mode: 'write' } : item
                      )))}
                    />
                  </div>
                </Row>
                <div style={{ color: 'var(--text-dim)', fontSize: 10, lineHeight: 1.4 }}>
                  Timeline: {morph.startTime.toFixed(2)}s for {morph.duration.toFixed(2)}s
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <Row label="Fill">
              <ColorInput value={selectedNode.fill} onChange={v => up('fill', v)} />
            </Row>
            <Row label="Border">
              <ColorInput value={selectedNode.stroke} onChange={v => up('stroke', v)} />
            </Row>
            {selectedNode.type === 'area' && (
              <Row label="Invisible">
                <ToggleInput
                  checked={!!selectedNode.areaInvisible}
                  onChange={v => up('areaInvisible', v)}
                  label="Hide area fill, border, and label"
                />
              </Row>
            )}
            <Row label="Width">
              <NumberInput value={selectedNode.width} min={60} max={500} onChange={v => up('width', v)} />
            </Row>
            <Row label="Height">
              <NumberInput value={selectedNode.height} min={28} max={300} onChange={v => up('height', v)} />
            </Row>
            <Row label="Radius">
              <NumberInput value={selectedNode.cornerRadius} min={0} max={60} onChange={v => up('cornerRadius', v)} />
            </Row>
            <Row label="Border width">
              <NumberInput value={selectedNode.strokeWidth} min={0} max={10} onChange={v => up('strokeWidth', v)} />
            </Row>

            {/* Scrolling grid — turns the area into a looping viewport over the nodes inside it */}
            {selectedNode.type === 'area' && (
              <>
                <Section title="Scroll" hint="Loops the objects centered inside this area, clipped at its edges — Glide scrolls continuously (Speed px/s, Gap adds space before the repeat); Step holds then shifts one tile per run" docAnchor="scroll" />
                <Row label="Scroll">
                  <ToggleInput
                    checked={!!selectedNode.scrollEnabled}
                    onChange={v => up('scrollEnabled', v)}
                    label="Loop nodes inside during playback"
                  />
                </Row>
                {selectedNode.scrollEnabled && (
                  <>
                    <Row label="Direction">
                      <select
                        value={selectedNode.scrollAxis ?? 'up'}
                        onChange={e => up('scrollAxis', e.target.value)}
                        style={SELECT_INPUT_STYLE}
                      >
                        <option value="up">Up</option>
                        <option value="down">Down</option>
                        <option value="left">Left</option>
                        <option value="right">Right</option>
                      </select>
                    </Row>
                    <Row label="Mode">
                      <div style={{ display: 'flex', gap: 6 }}>
                        <ModeChip
                          label="Glide"
                          active={(selectedNode.scrollMode ?? 'continuous') !== 'stepped'}
                          onClick={() => up('scrollMode', 'continuous')}
                        />
                        <ModeChip
                          label="Step"
                          active={selectedNode.scrollMode === 'stepped'}
                          onClick={() => up('scrollMode', 'stepped')}
                        />
                      </div>
                    </Row>
                    {selectedNode.scrollMode === 'stepped' ? (
                      <>
                        {(() => {
                          const steps = normalizeScrollSteps(selectedNode.scrollSteps);
                          const setSteps = next => up('scrollSteps', normalizeScrollSteps(next));
                          return (
                            <div style={{ marginBottom: 10 }}>
                              <ActionButton
                                label="Add step at playhead"
                                onClick={() => setSteps([
                                  ...steps,
                                  {
                                    id: uuid(),
                                    time: Math.round(Math.max(0, getTimelineCursor()) * 100) / 100,
                                    duration: DEFAULT_SCROLL_STEP_DURATION,
                                  },
                                ])}
                              />
                              {steps.map((step, index) => (
                                <div key={step.id} style={{
                                  display: 'flex', alignItems: 'center', gap: 5, marginTop: 7,
                                  padding: '6px 7px', borderRadius: 6,
                                  background: 'var(--purple-surface-panel)', border: '1px solid var(--purple-border-strong)',
                                }}>
                                  <span style={{ color: 'var(--purple-bright)', fontSize: 10, fontWeight: 700 }}>{index + 1}</span>
                                  <NumberInput
                                    value={step.time}
                                    min={0}
                                    step={0.05}
                                    onChange={value => setSteps(steps.map(s => s.id === step.id ? { ...s, time: Math.round(Math.max(0, value) * 100) / 100 } : s))}
                                  />
                                  <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>for</span>
                                  <NumberInput
                                    value={step.duration}
                                    min={0.05}
                                    step={0.05}
                                    onChange={value => setSteps(steps.map(s => s.id === step.id ? { ...s, duration: Math.round(Math.max(0.05, value) * 100) / 100 } : s))}
                                  />
                                  <button
                                    onClick={() => setSteps(steps.filter(s => s.id !== step.id))}
                                    title="Remove step"
                                    style={{ background: 'none', border: 'none', color: 'var(--danger-bright)', cursor: 'pointer', fontSize: 15, padding: 2 }}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                        {normalizeScrollSteps(selectedNode.scrollSteps).length === 0 && (
                          <>
                            <Row label="Step every">
                              <NumberInput
                                value={Number.isFinite(selectedNode.scrollStepInterval) ? selectedNode.scrollStepInterval : 1}
                                min={0.1}
                                max={60}
                                step={0.1}
                                onChange={v => up('scrollStepInterval', Math.max(0.1, v))}
                              />
                            </Row>
                            <Row label="Shift time">
                              <NumberInput
                                value={Number.isFinite(selectedNode.scrollStepDuration) ? selectedNode.scrollStepDuration : 0.4}
                                min={0.05}
                                max={10}
                                step={0.05}
                                onChange={v => up('scrollStepDuration', Math.max(0.05, v))}
                              />
                            </Row>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <Row label="Speed">
                          <NumberInput
                            value={Number.isFinite(selectedNode.scrollSpeed) ? selectedNode.scrollSpeed : 40}
                            min={1}
                            max={400}
                            step={1}
                            onChange={v => up('scrollSpeed', Math.max(1, v))}
                          />
                        </Row>
                        <Row label="Gap">
                          <NumberInput
                            value={Number.isFinite(selectedNode.scrollGap) ? selectedNode.scrollGap : 0}
                            min={0}
                            max={400}
                            step={2}
                            onChange={v => up('scrollGap', Math.max(0, v))}
                          />
                        </Row>
                      </>
                    )}
                    <Row label="Min tiles">
                      <NumberInput
                        value={Number.isFinite(selectedNode.scrollTiles) ? selectedNode.scrollTiles : 0}
                        min={0}
                        max={200}
                        step={1}
                        onChange={v => up('scrollTiles', Math.max(0, Math.round(v)))}
                      />
                    </Row>
                    <Row label="Tile size">
                      <NumberInput
                        value={Number.isFinite(selectedNode.scrollTileSize) ? selectedNode.scrollTileSize : 0}
                        min={0}
                        max={2000}
                        step={1}
                        onChange={v => up('scrollTileSize', Math.max(0, Math.round(v)))}
                      />
                    </Row>
                    <Row label="Start at">
                      <NumberInput
                        value={Number.isFinite(selectedNode.scrollStartTime) ? selectedNode.scrollStartTime : 0}
                        min={0}
                        max={600}
                        step={0.1}
                        onChange={v => up('scrollStartTime', Math.max(0, v))}
                      />
                    </Row>
                    <Row label="Loop">
                      <ToggleInput
                        checked={selectedNode.scrollSeamless !== false}
                        onChange={v => up('scrollSeamless', v)}
                        label="Seamless loop (snap to whole cycles)"
                      />
                    </Row>
                  </>
                )}
              </>
            )}

            {/* Quick morph editor — add/edit per-node morphs without leaving the inspector */}
            {selectedNode.type !== 'area' && (
            <>
            <Section title="Morphs" hint="Scripted text and style changes — each morph gets a draggable block on this node's timeline row" docAnchor="morphs" />
            <div style={{ marginBottom: 10 }}>
              <ActionButton
                label="Add morph"
                onClick={() => updateTextMorphs([
                  ...textMorphs,
                  {
                    id: uuid(),
                    text: selectedNode.label ?? '',
                    mode: 'fade',
                    startTime: Math.round(getNextTextMorphStart(selectedNode, {
                      start: selectedNode.animStartTime ?? 0,
                      duration: selectedNode.animDuration ?? 0.5,
                    }) * 100) / 100,
                    duration: Math.max(0.4, selectedNode.animDuration ?? 0.5),
                  },
                ])}
              />
            </div>
            {textMorphs.map((morph, index) => {
              const patchMorph = (updates) => updateTextMorphs(textMorphs.map(item => (
                item.id === morph.id ? { ...item, ...updates } : item
              )));
              return (
                <div
                  key={morph.id}
                  style={{
                    marginBottom: 10,
                    padding: 10,
                    borderRadius: 8,
                    background: 'var(--panel-bg)',
                    border: '1px solid var(--border-strong)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600 }}>
                      Morph {index + 1}
                    </span>
                    <button
                      onClick={() => updateTextMorphs(textMorphs.filter(item => item.id !== morph.id))}
                      style={{ background: 'none', border: 'none', color: 'var(--danger-bright)', cursor: 'pointer', fontSize: 11, padding: 0 }}
                    >
                      Remove
                    </button>
                  </div>
                  <Row label="To">
                    <TextInput value={morph.text} onChange={value => patchMorph({ text: value })} />
                  </Row>
                  <Row label="Mode">
                    <div style={{ display: 'flex', gap: 6 }}>
                      <ModeChip label="Fade" active={morph.mode === 'fade'} onClick={() => patchMorph({ mode: 'fade' })} />
                      <ModeChip label="Write" active={morph.mode === 'write'} onClick={() => patchMorph({ mode: 'write' })} />
                    </div>
                  </Row>
                  <Row label="Fill">
                    <ColorInput value={morph.fill ?? selectedNode.fill} onChange={value => patchMorph({ fill: value })} />
                  </Row>
                  <Row label="Border">
                    <ColorInput value={morph.stroke ?? selectedNode.stroke} onChange={value => patchMorph({ stroke: value })} />
                  </Row>
                  <Row label="Text color">
                    <ColorInput value={morph.textColor ?? selectedNode.textColor} onChange={value => patchMorph({ textColor: value })} />
                  </Row>
                  <Row label="Start">
                    <NumberInput
                      value={morph.startTime}
                      min={0}
                      step={0.05}
                      onChange={value => patchMorph({ startTime: Math.round(Math.max(0, value) * 100) / 100 })}
                    />
                  </Row>
                  <Row label="Duration">
                    <NumberInput
                      value={morph.duration}
                      min={0.1}
                      step={0.05}
                      onChange={value => patchMorph({ duration: Math.round(Math.max(0.1, value) * 100) / 100 })}
                    />
                  </Row>
                </div>
              );
            })}
            </>
            )}

            {/* Tokens passing through this node — quick access to per-variable token appearance and flow control */}
            {(() => {
              const webs = computeVariableWebs(nodes, links);
              const passing = webs.filter(w => w.arrivalAtNode && w.arrivalAtNode[selectedNode.id] != null);
              if (passing.length === 0) return null;
              return (
                <>
                  <Section title="Passing Tokens" hint="Appearance of each variable token that travels through this node — Stop ends the token here so it doesn't continue downstream" docAnchor="passing-tokens" />
                  {passing
                    .sort((a, b) => (a.variableLabel || a.displayText || '').localeCompare(b.variableLabel || b.displayText || ''))
                    .map(web => {
                      const v = nodes.find(n => n.id === web.sourceNodeId);
                      if (!v) return null;
                      const eff = (key) => v[key] != null ? v[key] : simOpt[key];
                      const hasAny = ['tokenShape','tokenSize','tokenFill','tokenStroke','tokenTextColor','tokenTextSize'].some(k => v[k] != null);
                      const killMap = selectedNode.tokenKillFor ?? {};
                      const isKilledHere = !!killMap[v.id];
                      return (
                        <div
                          key={`token-overrides-${web.sourceNodeId}`}
                          style={{
                            marginBottom: 10,
                            padding: 10,
                            borderRadius: 8,
                            background: 'var(--panel-bg)',
                            border: '1px solid var(--border-strong)',
                          }}
                        >
                          <div style={{ color: 'var(--text-main)', fontSize: 11, fontWeight: 600, marginBottom: 8 }}>
                            {(v.variableLabel || v.label || '').trim() || 'Variable'} token
                          </div>
                          <Row label="Flow">
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <button
                                onClick={() => {
                                  const cur = { ...(selectedNode.tokenKillFor ?? {}) };
                                  if (isKilledHere) delete cur[v.id]; else cur[v.id] = true;
                                  updateNode(selectedNode.id, { tokenKillFor: cur });
                                }}
                                style={{
                                  background: isKilledHere ? 'var(--danger-surface-soft)' : 'var(--panel-bg)',
                                  border: `1px solid ${isKilledHere ? 'var(--danger-border-soft)' : 'var(--border-strong)'}`,
                                  borderRadius: 6,
                                  color: isKilledHere ? 'var(--danger-bright)' : 'var(--text-muted)',
                                  fontSize: 11,
                                  padding: '5px 8px',
                                  cursor: 'pointer',
                                }}
                              >
                                {isKilledHere ? 'Allow through' : 'Stop token here'}
                              </button>
                            </div>
                          </Row>
                          <Row label="Label text">
                            <TextInput value={v.tokenText ?? ''} onChange={val => updateNode(v.id, { tokenText: val })} />
                          </Row>
                          <Row label="Shape">
                            <select
                              value={eff('tokenShape')}
                              onChange={e => updateNode(v.id, { tokenShape: e.target.value })}
                              style={SELECT_INPUT_STYLE}
                            >
                              <option value="circle">Circle</option>
                              <option value="square">Square</option>
                              <option value="diamond">Diamond</option>
                            </select>
                          </Row>
                          <Row label="Size">
                            <NumberInput value={eff('tokenSize')} min={2} max={24} onChange={val => updateNode(v.id, { tokenSize: val })} />
                          </Row>
                          <Row label="Fill">
                            <ColorInput value={eff('tokenFill')} onChange={val => updateNode(v.id, { tokenFill: val })} />
                          </Row>
                          <Row label="Border">
                            <ColorInput value={eff('tokenStroke')} onChange={val => updateNode(v.id, { tokenStroke: val })} />
                          </Row>
                          <Row label="Label color">
                            <ColorInput value={eff('tokenTextColor')} onChange={val => updateNode(v.id, { tokenTextColor: val })} />
                          </Row>
                          <Row label="Label size">
                            <NumberInput value={eff('tokenTextSize')} min={8} max={24} onChange={val => updateNode(v.id, { tokenTextSize: val })} />
                          </Row>
                          {hasAny && (
                            <button
                              onClick={() => updateNode(v.id, {
                                tokenText: null, tokenShape: null, tokenSize: null, tokenFill: null,
                                tokenStroke: null, tokenTextColor: null, tokenTextSize: null,
                              })}
                              style={{
                                background: 'var(--panel-bg)', border: '1px solid var(--border-strong)',
                                borderRadius: 6, color: 'var(--text-muted)', padding: '5px 8px',
                                fontSize: 11, cursor: 'pointer', width: '100%', marginTop: 6,
                              }}
                            >
                              Reset to global default
                            </button>
                          )}
                        </div>
                      );
                    })}
                </>
              );
            })()}
            {!isTextNode && (
              <>
                <Section title="Popup" docAnchor="popup" />
                <Row label="Popup">
                  <ToggleInput
                    checked={selectedNode.showSimplePopupInPlayback ?? false}
                    onChange={value => up('showSimplePopupInPlayback', value)}
                    label="Show simple popup"
                  />
                </Row>
                <Row label="Value">
                  <TextInput
                    value={selectedNode.popupValue ?? ''}
                    onChange={v => up('popupValue', v)}
                  />
                </Row>
                <Row label="Tab color">
                  <ColorInput
                    value={selectedNode.popupFill ?? selectedNode.fill}
                    onChange={v => up('popupFill', v)}
                  />
                </Row>
                <Row label="Width">
                  <NumberInput
                    value={Number.isFinite(selectedNode.popupWidth) ? selectedNode.popupWidth : selectedNode.width}
                    min={24}
                    max={800}
                    step={1}
                    onChange={value => up('popupWidth', Math.max(24, value))}
                  />
                </Row>
                <Row label="Height">
                  <NumberInput
                    value={Number.isFinite(selectedNode.popupHeight) ? selectedNode.popupHeight : 48}
                    min={18}
                    max={400}
                    step={1}
                    onChange={value => up('popupHeight', Math.max(18, value))}
                  />
                </Row>
                {selectedNode.showSimplePopupInPlayback && (
                  <>
                    <Row label="Delay">
                      <NumberInput
                        value={selectedNode.simplePopupDelay ?? 0.2}
                        min={0}
                        max={10}
                        step={0.05}
                        onChange={value => up('simplePopupDelay', value)}
                      />
                    </Row>
                    <Row label="Length">
                      <NumberInput
                        value={selectedNode.simplePopupDuration ?? 0.7}
                        min={0.1}
                        max={10}
                        step={0.05}
                        onChange={value => up('simplePopupDuration', value)}
                      />
                    </Row>
                    <Row label="Stay open">
                      <ToggleInput
                        checked={selectedNode.popupStayOpen ?? false}
                        onChange={value => up('popupStayOpen', value)}
                        label="Keep open after it appears"
                      />
                    </Row>
                  </>
                )}
              </>
            )}
          </>
        )}

        {selectedNode.type === 'variable' && (
          <>
            <Section title="Variable" docAnchor="variable" />
            <Row label="Name">
              <TextInput value={selectedNode.variableLabel ?? ''} onChange={v => up('variableLabel', v)} />
            </Row>
            <Row label="Value">
              <TextInput value={selectedNode.variableValue ?? ''} onChange={v => up('variableValue', v)} />
            </Row>
            <Row label="Input" title="Visual draws a token along the web of outgoing links; Silent updates monitors without a visible token">
              <div style={{ display: 'flex', gap: 6 }}>
                <ModeChip
                  label="Visual"
                  active={(selectedNode.inputMode ?? 'visual') === 'visual'}
                  onClick={() => up('inputMode', 'visual')}
                />
                <ModeChip
                  label="Silent"
                  active={selectedNode.inputMode === 'silent'}
                  onClick={() => up('inputMode', 'silent')}
                />
              </div>
            </Row>

            <Section title="Token Appearance" hint="Overrides for this variable's token only — cleared fields fall back to the global default (empty-selection panel)" docAnchor="token-appearance" />
            {(() => {
              const eff = (key) => selectedNode[key] != null ? selectedNode[key] : simOpt[key];
              const has = (key) => selectedNode[key] != null;
              return (
                <>
                  <Row label="Label text">
                    <TextInput value={selectedNode.tokenText ?? ''} onChange={v => up('tokenText', v)} />
                  </Row>
                  <Row label="Shape">
                    <select
                      value={eff('tokenShape')}
                      onChange={e => up('tokenShape', e.target.value)}
                      style={SELECT_INPUT_STYLE}
                    >
                      <option value="circle">Circle</option>
                      <option value="square">Square</option>
                      <option value="diamond">Diamond</option>
                    </select>
                  </Row>
                  <Row label="Size">
                    <NumberInput value={eff('tokenSize')} min={2} max={24} onChange={v => up('tokenSize', v)} />
                  </Row>
                  <Row label="Fill">
                    <ColorInput value={eff('tokenFill')} onChange={v => up('tokenFill', v)} />
                  </Row>
                  <Row label="Border">
                    <ColorInput value={eff('tokenStroke')} onChange={v => up('tokenStroke', v)} />
                  </Row>
                  <Row label="Label color">
                    <ColorInput value={eff('tokenTextColor')} onChange={v => up('tokenTextColor', v)} />
                  </Row>
                  <Row label="Label size">
                    <NumberInput value={eff('tokenTextSize')} min={8} max={24} onChange={v => up('tokenTextSize', v)} />
                  </Row>
                  {(has('tokenText') || has('tokenShape') || has('tokenSize') || has('tokenFill') || has('tokenStroke') || has('tokenTextColor') || has('tokenTextSize')) && (
                    <button
                      onClick={() => updateNode(selectedNode.id, {
                        tokenText: null, tokenShape: null, tokenSize: null, tokenFill: null,
                        tokenStroke: null, tokenTextColor: null, tokenTextSize: null,
                      })}
                      style={{
                        background: 'var(--panel-bg)', border: '1px solid var(--border-strong)',
                        borderRadius: 6, color: 'var(--text-muted)', padding: '5px 8px',
                        fontSize: 11, cursor: 'pointer', width: '100%', marginBottom: 8,
                      }}
                    >
                      Reset to global default
                    </button>
                  )}
                </>
              );
            })()}
          </>
        )}

        {!isMirror && !isTextNode && (
          <>
            <Section title="Resolve" hint="Morph this element into another node's look when its animation completes — drag the amber timeline block to set the moment" docAnchor="resolve" />
            <Row label="Mode">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <ModeChip label="Off" active={resolveMode === 'none'} onClick={() => setResolveMode('none')} />
                <ModeChip label="Existing" active={resolveMode === 'existing'} onClick={() => setResolveMode('existing')} />
                <ModeChip label="Custom" active={resolveMode === 'custom'} onClick={() => setResolveMode('custom')} />
              </div>
            </Row>

            {resolveMode === 'existing' && (
              <Row label="Into">
                <select
                  value={selectedNode.transformTargetNodeId ?? ''}
                  onChange={(e) => updateNode(selectedNode.id, {
                    transformMode: 'existing',
                    transformTargetNodeId: e.target.value || null,
                  })}
                  disabled={!transformTargets.length}
                  style={{
                    ...SELECT_INPUT_STYLE,
                    color: transformTargets.length ? 'var(--text-main)' : 'var(--text-dim)',
                  }}
                >
                  <option value="">Choose target node…</option>
                  {transformTargets.map((targetNode) => (
                    <option key={targetNode.id} value={targetNode.id}>{targetNode.label ?? 'Untitled node'}</option>
                  ))}
                </select>
              </Row>
            )}

            {resolveMode === 'custom' && (
              <>
                <Row label="Label">
                  <TextInput
                    value={selectedNode.transformTarget?.label ?? ''}
                    onChange={value => updateResolveTarget({ label: value })}
                  />
                </Row>
                <Row label="Shape">
                  <select
                    value={selectedNode.transformTarget?.shape ?? selectedNode.shape ?? 'rounded'}
                    onChange={e => updateResolveTarget({
                      width: NODE_SHAPE_PRESETS[e.target.value]?.width ?? selectedNode.width ?? 150,
                      height: NODE_SHAPE_PRESETS[e.target.value]?.height ?? selectedNode.height ?? 52,
                      shape: e.target.value,
                      cornerRadius: NODE_SHAPE_PRESETS[e.target.value]?.cornerRadius ?? (e.target.value === 'pill' ? 999 : e.target.value === 'rectangle' ? 0 : 8),
                    })}
                    style={SELECT_INPUT_STYLE}
                  >
                    {NODE_SHAPE_OPTIONS.map(s => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </Row>
                <Row label="Fill">
                  <ColorInput
                    value={selectedNode.transformTarget?.fill ?? selectedNode.fill}
                    onChange={value => updateResolveTarget({ fill: value })}
                  />
                </Row>
                <Row label="Border">
                  <ColorInput
                    value={selectedNode.transformTarget?.stroke ?? selectedNode.stroke}
                    onChange={value => updateResolveTarget({ stroke: value })}
                  />
                </Row>
                <Row label="Text">
                  <ColorInput
                    value={selectedNode.transformTarget?.textColor ?? selectedNode.textColor}
                    onChange={value => updateResolveTarget({ textColor: value })}
                  />
                </Row>
                <Row label="Border width">
                  <NumberInput
                    value={selectedNode.transformTarget?.strokeWidth ?? selectedNode.strokeWidth ?? 2}
                    min={0}
                    max={10}
                    step={0.5}
                    onChange={value => updateResolveTarget({ strokeWidth: value })}
                  />
                </Row>
              </>
            )}

            {resolveMode !== 'none' && (
              <Row label="Timing">
                <div style={{ display: 'flex', gap: 6 }}>
                  <ModeChip
                    label="After spawn"
                    active={selectedNode.transformStartTime == null}
                    onClick={() => up('transformStartTime', null)}
                  />
                  <ModeChip
                    label="Manual"
                    active={selectedNode.transformStartTime != null}
                    onClick={() => up('transformStartTime', getDefaultResolveStart(selectedNode))}
                  />
                </div>
              </Row>
            )}

            {resolveMode !== 'none' && selectedNode.transformStartTime != null && (
              <Row label="Start">
                <NumberInput
                  value={selectedNode.transformStartTime ?? getDefaultResolveStart(selectedNode)}
                  min={0}
                  max={120}
                  step={0.05}
                  onChange={value => up('transformStartTime', Math.max(0, Math.round(value * 100) / 100))}
                />
              </Row>
            )}

            {resolveMode !== 'none' && (
              <Row label="Duration">
                <NumberInput
                  value={selectedNode.transformDuration ?? 0.4}
                  min={0.1}
                  max={5}
                  step={0.05}
                  onChange={value => up('transformDuration', value)}
                />
              </Row>
            )}

          </>
        )}

        {selectedNode.triggerAfterLinkId && (
          <>
            <Section title="Spawn Timing" hint="While drawing: fades in during the final portion of the link draw — At completion: starts exactly when the link finishes" docAnchor="spawn-timing" />
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <ModeChip
                label="While drawing"
                active={!selectedNode.triggerMode || selectedNode.triggerMode === 'overlap'}
                onClick={() => up('triggerMode', 'overlap')}
              />
              <ModeChip
                label="At completion"
                active={selectedNode.triggerMode === 'on-end'}
                onClick={() => up('triggerMode', 'on-end')}
              />
            </div>
            <Row label="Delay">
              <NumberInput
                value={selectedNode.triggerDelay ?? 0}
                step={0.05}
                min={-2}
                max={5}
                onChange={v => up('triggerDelay', Math.round(v * 100) / 100)}
              />
              <span style={{ color: 'var(--text-dim)', fontSize: 11, marginLeft: 4 }}>s</span>
            </Row>
          </>
        )}

        <div style={{ flex: 1 }} />
        <button
          onClick={() => removeNode(selectedNode.id)}
          style={{
            marginTop: 20,
            background: 'var(--danger-surface-soft)',
            border: '1px solid var(--danger-border-soft)',
            borderRadius: 6,
            color: 'var(--danger-bright)',
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Delete {isTextNode ? 'text' : 'node'}
        </button>
          </>
        )}
      </div>
    );
  }

  const updateSelectedJoint = (key, value) => {
    if (!selectedLink || !selectedJoint) return;
    updateLinkJoint(selectedLink.id, selectedJoint.id, { [key]: value });
  };

  const applyCurvePreset = (value) => {
    if (!selectedJoint || !selectedLink) return;
    updateLinkJoint(selectedLink.id, selectedJoint.id, {
      prevCurve: value,
      nextCurve: value,
    });
  };

  const handleJunctionSyncBranches = (value) => {
    if (!selectedJoint || !selectedLink) return;
    const syncGroupKey = `${selectedLink.id}::${selectedJoint.id}`;
    updateLinkJoint(selectedLink.id, selectedJoint.id, { syncBranches: value });
    const branchLinks = links.filter(link =>
      link.fromJunctionLinkId === selectedLink.id &&
      link.fromJunctionJointId === selectedJoint.id
    );
    if (!branchLinks.length) return;

    if (!value) {
      for (const branchLink of branchLinks) {
        updateLink(branchLink.id, { syncGroupKey: null });
      }
      return;
    }
    for (const branchLink of branchLinks) {
      updateLink(branchLink.id, { syncGroupKey, animStartTime: null });
    }
  };

  return (
    <div style={wrap}>
      <Section title="Link" docAnchor="link" />

      <LinkBasics
        linkLike={selectedLink}
        onUpdate={updates => {
          updateLink(selectedLink.id, updates);
          if (updates && Object.prototype.hasOwnProperty.call(updates, 'bindToTokenHop')) {
            if (updates.bindToTokenHop && (updates.autoTriggerTarget ?? selectedLink.autoTriggerTarget)) {
              // Auto-trigger target node on hop end if not already triggered
              const toNode = nodes.find(n => n.id === selectedLink.toId);
              if (toNode && !toNode.triggerAfterLinkId) {
                updateNode(toNode.id, { triggerAfterLinkId: selectedLink.id, triggerMode: 'on-end', animStartTime: null });
              }
            }
          }
          if (updates && Object.prototype.hasOwnProperty.call(updates, 'autoTriggerTarget')) {
            if (!updates.autoTriggerTarget) {
              const toNode = nodes.find(n => n.id === selectedLink.toId);
              if (toNode && toNode.triggerAfterLinkId === selectedLink.id) {
                updateNode(toNode.id, { triggerAfterLinkId: null });
              }
            } else {
              const toNode = nodes.find(n => n.id === selectedLink.toId);
              if (toNode && !toNode.triggerAfterLinkId) {
                updateNode(toNode.id, { triggerAfterLinkId: selectedLink.id, triggerMode: 'on-end', animStartTime: null });
              }
            }
          }
        }}
      />

      <Row label="Message">
        <TextInput value={selectedLink.messageLabel ?? ''} onChange={v => updateLink(selectedLink.id, { messageLabel: v })} />
      </Row>

      {(selectedLink.fromAnchorSide || selectedLink.toAnchorSide) && (
        <>
          <Section title="Anchors" hint="Drag the link endpoints on canvas, or use these sliders to place each anchor precisely along its side" docAnchor="anchors" />
          {selectedLink.fromAnchorSide && selectedLink.fromAnchorSide !== 'center' && (
            <>
              <SliderControl
                label={`Start ${selectedLink.fromAnchorSide}`}
                value={selectedLink.fromAlongPos ?? 0}
                min={-getAnchorLimit(selectedFromNode, selectedLink.fromAnchorSide)}
                max={getAnchorLimit(selectedFromNode, selectedLink.fromAnchorSide)}
                onChange={(value) => updateLink(selectedLink.id, {
                  fromAlongPos: value,
                  fromAnchorLockedCenter: Math.abs(value) < 0.5,
                })}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4, marginBottom: 12 }}>
                <ActionButton
                  label="Center Start"
                  active={!!selectedLink.fromAnchorLockedCenter}
                  onClick={() => updateLink(selectedLink.id, {
                    fromAlongPos: 0,
                    fromAnchorLockedCenter: true,
                  })}
                />
              </div>
            </>
          )}
          {selectedLink.toAnchorSide && selectedLink.toAnchorSide !== 'center' && (
            <>
              <SliderControl
                label={`End ${selectedLink.toAnchorSide}`}
                value={selectedLink.toAlongPos ?? 0}
                min={-getAnchorLimit(selectedToNode, selectedLink.toAnchorSide)}
                max={getAnchorLimit(selectedToNode, selectedLink.toAnchorSide)}
                onChange={(value) => updateLink(selectedLink.id, {
                  toAlongPos: value,
                  toAnchorLockedCenter: Math.abs(value) < 0.5,
                })}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4, marginBottom: 12 }}>
                <ActionButton
                  label="Center End"
                  active={!!selectedLink.toAnchorLockedCenter}
                  onClick={() => updateLink(selectedLink.id, {
                    toAlongPos: 0,
                    toAnchorLockedCenter: true,
                  })}
                />
              </div>
            </>
          )}
        </>
      )}

      <Section title="Joints" hint="Joints reroute the link without creating new timeline items — right-click the link on canvas to add one" docAnchor="joints" />
      {selectedLink.joints?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {selectedLink.joints.map((joint, index) => (
            <JointChip
              key={joint.id}
              joint={joint.isJunction ? `Junction ${index + 1}` : `Joint ${index + 1}`}
              isSelected={selectedJointId === joint.id}
              onClick={() => setSelectedJoint(joint.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyHint>Right-click the link to add a joint.</EmptyHint>
      )}

      {selectedJoint && (
        <>
          <Row label="Size">
            <NumberInput value={selectedJoint.size ?? 0} min={0} max={18} step={1} onChange={v => updateSelectedJoint('size', Math.max(0, v))} />
          </Row>
          {selectedJoint.isJunction && (
            <Row label="Branches" title="Junctions branch new links — drag the + handle next to the junction on canvas. Start together makes all auto-timed branches emerge at the same moment">
              <ToggleInput
                checked={!!selectedJoint.syncBranches}
                label="Start together"
                onChange={handleJunctionSyncBranches}
              />
            </Row>
          )}
          <Section title="Curvature" hint="Linked keeps both sides of the joint matched; Split lets the curve lean into one side" docAnchor="curvature" />
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <ModeChip label="Linked" active={curveMode === 'linked'} onClick={() => setCurveMode('linked')} />
            <ModeChip label="Split" active={curveMode === 'split'} onClick={() => setCurveMode('split')} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <PresetChip label="Pipe" onClick={() => applyCurvePreset(0)} />
            <PresetChip label="Soft" onClick={() => applyCurvePreset(18)} />
            <PresetChip label="Round" onClick={() => applyCurvePreset(36)} />
          </div>

          {curveMode === 'linked' ? (
            <SliderControl
              label="Curve"
              value={jointCurve}
              onChange={(value) => {
                if (!selectedLink || !selectedJoint) return;
                updateLinkJoint(selectedLink.id, selectedJoint.id, {
                  prevCurve: value,
                  nextCurve: value,
                });
              }}
            />
          ) : (
            <>
              <SliderControl
                label="Into joint"
                value={selectedJoint.prevCurve ?? 0}
                onChange={value => updateSelectedJoint('prevCurve', value)}
              />
              <SliderControl
                label="Out of joint"
                value={selectedJoint.nextCurve ?? 0}
                onChange={value => updateSelectedJoint('nextCurve', value)}
              />
            </>
          )}
          <button
            onClick={() => removeLinkJoint(selectedLink.id, selectedJoint.id)}
            style={{
              marginTop: 8,
              background: 'var(--warning-surface-soft)',
              border: '1px solid var(--warning-border-soft)',
              borderRadius: 6,
              color: 'var(--warning-bright)',
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            Remove joint
          </button>
        </>
      )}

      <div style={{ flex: 1 }} />
      <button
        onClick={() => removeLink(selectedLink.id)}
        style={{
          marginTop: 20,
          background: 'var(--danger-surface-soft)',
          border: '1px solid var(--danger-border-soft)',
          borderRadius: 6,
          color: 'var(--danger-bright)',
          padding: '6px 12px',
          fontSize: 12,
          cursor: 'pointer',
          width: '100%',
        }}
      >
        Delete link
      </button>
    </div>
  );
}

// ── Resizable / collapsible shell ────────────────────────────────────────────
// The panel docks to the right edge: drag its left edge to resize, or click the
// arrow tab to tuck it away. Width and collapsed state persist across sessions.
const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 520;
const PANEL_DEFAULT_WIDTH = 488;
const PANEL_WIDTH_KEY = 'echovis_props_panel_width';
const PANEL_COLLAPSED_KEY = 'echovis_props_panel_collapsed';
// ease-out-expo: fast launch, long smooth settle — the "satisfying" part.
const PANEL_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const PANEL_ANIM_MS = 340;

function PropertiesPanel() {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(stored)
      ? Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, stored))
      : PANEL_DEFAULT_WIDTH;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === '1');
  const [dragging, setDragging] = useState(false);
  const [handleHover, setHandleHover] = useState(false);
  const [tabHover, setTabHover] = useState(false);
  const dragRef = useRef(null);

  useEffect(() => { localStorage.setItem(PANEL_WIDTH_KEY, String(width)); }, [width]);
  useEffect(() => { localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0'); }, [collapsed]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      setWidth(Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, drag.startWidth + (drag.startX - e.clientX))));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging]);

  const startResize = (e) => {
    if (collapsed) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
  };

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const animate = dragging || reduceMotion ? 'none' : `width ${PANEL_ANIM_MS}ms ${PANEL_EASE}`;

  return (
    <div style={{ position: 'relative', flexShrink: 0, zIndex: 60 }}>
      <button
        onClick={() => setCollapsed(c => !c)}
        onMouseEnter={() => setTabHover(true)}
        onMouseLeave={() => setTabHover(false)}
        title={collapsed ? 'Show properties' : 'Hide properties'}
        style={{
          position: 'absolute',
          left: -18,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 18,
          height: 64,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: tabHover ? 'var(--purple-surface-panel)' : 'var(--panel-bg-3)',
          border: `1px solid ${tabHover ? 'var(--purple-border-strong)' : 'var(--purple-border-soft)'}`,
          borderRight: 'none',
          borderRadius: '9px 0 0 9px',
          color: tabHover ? 'var(--text-main)' : 'var(--text-muted)',
          cursor: 'pointer',
          zIndex: 3,
          boxShadow: tabHover
            ? '-2px 0 10px var(--purple-glow)'
            : '-4px 0 12px rgba(0, 0, 0, 0.35)',
          transition: reduceMotion ? 'none' : 'background 140ms, border-color 140ms, color 140ms, box-shadow 140ms',
        }}
      >
        <span style={{
          fontSize: 11,
          lineHeight: 1,
          display: 'inline-block',
          transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
          transition: reduceMotion ? 'none' : `transform ${PANEL_ANIM_MS}ms ${PANEL_EASE}`,
        }}>
          ❮
        </span>
      </button>

      <div style={{ width: collapsed ? 0 : width, height: '100%', overflow: 'hidden', transition: animate }}>
        {/* Fixed-width inner frame so the content doesn't reflow while sliding. */}
        <div style={{ width, height: '100%', position: 'relative', display: 'flex' }}>
          <div
            onPointerDown={startResize}
            onDoubleClick={() => setWidth(PANEL_DEFAULT_WIDTH)}
            onMouseEnter={() => setHandleHover(true)}
            onMouseLeave={() => setHandleHover(false)}
            title="Drag to resize · double-click to reset"
            style={{
              position: 'absolute',
              left: -2,
              top: 0,
              bottom: 0,
              width: 7,
              cursor: 'col-resize',
              zIndex: 2,
              background: (dragging || handleHover)
                ? 'linear-gradient(90deg, transparent 2px, var(--purple-border-strong) 2px, var(--purple-border-strong) 4px, transparent 4px)'
                : 'transparent',
            }}
          />
          <PanelContent />
        </div>
      </div>
    </div>
  );
}

export default PropertiesPanel;
