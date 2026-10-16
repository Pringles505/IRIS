import { getNodeFailureOpacity } from './nodeFailureTiming';
import { buildLinkRenderData, getAnimatedArrowHead, getPointAtProgress } from '../links/linkGeometry';
import { pageColors } from '../colorThemes';
import { getManualTokenTextAtTime, getManualTokenTextFadeAtTime } from './manualTokenTiming';
import { getNodeTextMorphs, getTextMorphRenderState } from '../text/textMorphs';
import { formatEquationText } from '../text/equationText';

function getRenderedLabelText(label, value) {
  const text = String(value ?? '');
  return label?.getAttr('equationMode') ? formatEquationText(text) : text;
}

export function computeLinkRenders(nodes, links) {
  const nodeMap = Object.fromEntries(nodes.map(node => [node.id, node]));
  const renders = {};

  for (const link of links) {
    const fromNode = nodeMap[link.fromId];
    const toNode = nodeMap[link.toId];
    if (!fromNode || !toNode) continue;
    renders[link.id] = buildLinkRenderData(link, fromNode, toNode, links, nodes);
  }

  return renders;
}

const easeOut3 = t => 1 - Math.pow(1 - t, 3);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(color) {
  if (!color || typeof color !== 'string' || !color.startsWith('#')) return null;
  const normalized = color.slice(1);
  const full = normalized.length === 3
    ? normalized.split('').map(char => char + char).join('')
    : normalized;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return null;
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function mixColor(from, to, progress) {
  if (!to) return from;
  if (!from) return to;
  const fromRgb = hexToRgb(from);
  const toRgb = hexToRgb(to);
  if (!fromRgb || !toRgb) return progress >= 1 ? to : from;
  const p = clamp(progress, 0, 1);
  const r = Math.round(fromRgb.r + (toRgb.r - fromRgb.r) * p);
  const g = Math.round(fromRgb.g + (toRgb.g - fromRgb.g) * p);
  const b = Math.round(fromRgb.b + (toRgb.b - fromRgb.b) * p);
  return `rgb(${r}, ${g}, ${b})`;
}

// Resolve a monitor value's text color across its morphs. Each morph owns the
// color from its keyframe onward: the color shown after a morph is that morph's
// own color (its picker value, which falls back to the node's default when the
// morph leaves it unset). This matches the per-morph color picker exactly, so a
// later morph never "inherits" an earlier morph's color — when a morph ends, you
// see the color that morph specifies, held until the next morph takes over.
function resolveMonitorTextColor(node, morphs, time) {
  const fallback = node.textColor;
  let committed = fallback;
  for (const morph of morphs) {
    if (time < morph.startTime) break;        // future morph: stop here
    const effective = morph.textColor ?? fallback;
    const end = morph.startTime + morph.duration;
    if (time >= end) {
      committed = effective;                  // morph finished: its color is in effect
      continue;
    }
    // Active morph: blend from the previous color to this morph's color.
    const progress = clamp((time - morph.startTime) / morph.duration, 0, 1);
    return mixColor(committed, effective, progress);
  }
  return committed;
}

// Clip a Konva group to a layer-space rect (the scrolling area). Clip coordinates
// live in the group's local space, so use Konva's full transform rather than
// reconstructing translation/offset/scale by hand. This also handles centered node
// offsets and keeps the clip fixed while the group moves during a scroll step.
function applyScrollClip(group, clip) {
  if (!clip) return;
  const transform = group.getTransform().copy().invert();
  const corners = [
    transform.point({ x: clip.x, y: clip.y }),
    transform.point({ x: clip.x + clip.w, y: clip.y }),
    transform.point({ x: clip.x, y: clip.y + clip.h }),
    transform.point({ x: clip.x + clip.w, y: clip.y + clip.h }),
  ];
  const xs = corners.map(point => point.x);
  const ys = corners.map(point => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  group.clipX(minX);
  group.clipY(minY);
  group.clipWidth(Math.max(0, maxX - minX));
  group.clipHeight(Math.max(0, maxY - minY));
}

function clearScrollClip(group) {
  if (group.clipWidth() != null || group.clipHeight() != null) {
    group.clipX(undefined);
    group.clipY(undefined);
    group.clipWidth(undefined);
    group.clipHeight(undefined);
  }
}

function ensureBaseAttr(node, attr, fallback) {
  const current = node.getAttr(attr);
  if (current != null) return current;
  node.setAttr(attr, fallback);
  return fallback;
}

const nodeCache = new WeakMap();

// Shapes mount and unmount as the diagram is edited (e.g. a node's failure mark only
// exists once it has a failure), so callers clear the lookup cache on every edit.
export function clearAnimNodeCache(layer) {
  if (layer) nodeCache.delete(layer);
}

function getCachedNode(layer, selector) {
  let layerCache = nodeCache.get(layer);
  if (!layerCache) {
    layerCache = new Map();
    nodeCache.set(layer, layerCache);
  }
  if (layerCache.has(selector)) {
    const cached = layerCache.get(selector);
    // A destroyed/detached shape means the tree changed under us; look it up again.
    if (!cached || cached.getLayer()) return cached;
  }
  const node = layer.findOne(selector);
  layerCache.set(selector, node);
  return node;
}

function applyNodeStateToId(layer, id, state, currentTime = 0) {
  const group = getCachedNode(layer, `#node-${id}`);
  const label = getCachedNode(layer, `#node-label-${id}`);
  const morphLabel = getCachedNode(layer, `#node-label-morph-${id}`);
  const body = getCachedNode(layer, `#node-body-${id}`);
  const badgeBg = getCachedNode(layer, `#node-sub-badge-bg-${id}`);
  const badgeText = getCachedNode(layer, `#node-sub-badge-text-${id}`);
  const popupGroup = getCachedNode(layer, `#node-popup-${id}`);
  const popupBg = getCachedNode(layer, `#node-popup-bg-${id}`);
  if (!group) return;

  // ── Area node handling ──────────────────────────────────────────────────────
  const areaRect = getCachedNode(layer, `#area-rect-${id}`);
  if (areaRect) {
    const baseW = areaRect.getAttr('baseWidth') ?? areaRect.width();
    const baseH = areaRect.getAttr('baseHeight') ?? areaRect.height();
    const animMode = areaRect.getAttr('areaAnimMode') ?? 'fade';

    if (animMode === 'draw') {
      // Grow from 0×0 at top-left, like a rubber-band selection being drawn
      const p = state.textProgress; // raw linear 0→1
      const eased = easeOut3(p);
      areaRect.width(Math.max(0, baseW * eased));
      areaRect.height(Math.max(0, baseH * eased));
      group.opacity(p > 0 ? 1 : 0);
      group.scaleX(1);
      group.scaleY(1);
      // Label fades in during the second half
      const areaLabel = getCachedNode(layer, `#area-label-${id}`);
      if (areaLabel) areaLabel.opacity(p < 0.5 ? 0 : Math.min(1, (p - 0.5) * 2));
      return;
    }

    // 'fade' mode — keep the rect at its real dimensions and fade in via opacity
    // only. The area group has no center offset (its origin is the top-left), so
    // applying the generic entry scale (0.82→1) would make the area grow out of
    // its corner and visibly drift. Force scale to 1 and return so it stays solid.
    areaRect.width(baseW);
    areaRect.height(baseH);
    const areaLabel = getCachedNode(layer, `#area-label-${id}`);
    if (areaLabel) areaLabel.opacity(1);
    group.opacity(state.opacity);
    group.scaleX(1);
    group.scaleY(1);
    return;
  }
  // ── end area handling ───────────────────────────────────────────────────────

  group.opacity(state.opacity);
  // Keep node scale stable during popup to avoid size jump
  const scale = state.scale;
  group.scaleX(scale);
  group.scaleY(scale);

  // Scrolling-area offset: translate the node from its rest position. We cache the
  // rest position once so we can both apply the live offset and restore it on stop.
  if (state.scrollDX != null || state.scrollDY != null) {
    let baseX = group.getAttr('scrollBaseX');
    let baseY = group.getAttr('scrollBaseY');
    if (baseX == null) { baseX = group.x(); group.setAttr('scrollBaseX', baseX); }
    if (baseY == null) { baseY = group.y(); group.setAttr('scrollBaseY', baseY); }
    const nextX = baseX + (state.scrollDX ?? 0);
    const nextY = baseY + (state.scrollDY ?? 0);
    const previousTime = group.getAttr('scrollPreviousTime');
    const timeMovedForward = previousTime == null || currentTime >= previousTime;
    // Re-entry fade fires off the engine's deterministic per-band cycle index, which
    // ticks once per wrap — reliable for every band, unlike a position-jump threshold.
    const cycleIndex = state.scrollCycleIndex;
    const previousCycleIndex = group.getAttr('scrollCycleIndex');
    const wrapped = timeMovedForward && cycleIndex != null && previousCycleIndex != null
      && cycleIndex !== previousCycleIndex;

    // Seamless loops keep the wrap off-screen, so the re-entry fade only adds a blink
    // at the loop seam (esp. in exported GIFs) — skip it.
    if (wrapped && !state.scrollSeamless) group.setAttr('scrollFadeStartTime', currentTime);
    if (!timeMovedForward || state.scrollSeamless) group.setAttr('scrollFadeStartTime', undefined);
    group.setAttr('scrollCycleIndex', cycleIndex);

    const fadeStartTime = group.getAttr('scrollFadeStartTime');
    if (fadeStartTime != null) {
      const fadeProgress = clamp((currentTime - fadeStartTime) / 0.18, 0, 1);
      const fadeOpacity = 0.18 + 0.82 * easeOut3(fadeProgress);
      group.opacity(state.opacity * fadeOpacity);
      if (fadeProgress >= 1) group.setAttr('scrollFadeStartTime', undefined);
    }

    group.x(nextX);
    group.y(nextY);
    group.setAttr('scrollPreviousX', nextX);
    group.setAttr('scrollPreviousY', nextY);
    group.setAttr('scrollPreviousTime', currentTime);
    applyScrollClip(group, state.scrollClip);
  } else {
    const baseX = group.getAttr('scrollBaseX');
    const baseY = group.getAttr('scrollBaseY');
    if (baseX != null) group.x(baseX);
    if (baseY != null) group.y(baseY);
    group.setAttr('scrollPreviousX', undefined);
    group.setAttr('scrollPreviousY', undefined);
    group.setAttr('scrollPreviousTime', undefined);
    group.setAttr('scrollFadeStartTime', undefined);
    group.setAttr('scrollCycleIndex', undefined);
    clearScrollClip(group);
  }

  // Graph node draw animation (when present)
  // Support single or split graph lines
  const prefixes = [
    `#graph-line-main-s`,
    `#graph-line-top-s`,
    `#graph-line-bot-s`,
  ];
  // Delay curve drawing so graph appears first, then stroke draws
  const entry = state.textProgress ?? 0;
  const DRAW_DELAY = 0.45; // first 45% = appear, then draw
  const pDraw = clamp((entry - DRAW_DELAY) / Math.max(0.0001, 1 - DRAW_DELAY), 0, 1);
  for (const pref of prefixes) {
    for (let i = 0; i < 256; i += 1) {
      const sel = `${pref}${i}-${id}`;
      const gl = getCachedNode(layer, sel);
      if (!gl) break;
      const pts = Array.isArray(gl.points?.()) ? gl.points() : [];
      let totalLen = gl.getAttr('baseLength');
      if (!(Number.isFinite(totalLen) && totalLen > 0)) {
        totalLen = 0;
        for (let j = 0; j + 3 < pts.length; j += 2) {
          const dx = pts[j + 2] - pts[j];
          const dy = pts[j + 3] - pts[j + 1];
          totalLen += Math.hypot(dx, dy);
        }
        gl.setAttr('baseLength', totalLen);
      }
      if (totalLen > 0) {
        gl.dashEnabled(true);
        gl.dash([totalLen, totalLen]);
        gl.dashOffset((1 - pDraw) * totalLen);
        gl.opacity(pDraw > 0.001 ? 1 : 0);
      } else {
        gl.dashEnabled(false);
        gl.opacity(state.opacity);
      }
    }
  }

  // (Vector animation moved to applyAnimState where options is available)

  // If popup is active, ensure the node is on top of siblings (only once)
  if (state.popupProgress > 0) {
    if (!group.getAttr('isPopupActive')) {
      group.moveToTop();
      group.setAttr('isPopupActive', true);
    }
  } else if (group.getAttr('isPopupActive')) {
    group.setAttr('isPopupActive', false);
  }

  // Fail X: fades in during the last 30% of the node's entry animation
  const failMark = getCachedNode(layer, `#node-fail-${id}`);
  if (failMark) {
    const xOpacity = state.failureOpacity ?? (state.opacity < 0.55 ? 0 : Math.min(1, (state.opacity - 0.55) / 0.45));
    failMark.opacity(xOpacity);
    const xScale = 0.82 + xOpacity * 0.18;
    failMark.scale({ x: xScale, y: xScale });
  }

  // Failure tint veil matches Fail X visibility
  const failTint = getCachedNode(layer, `#node-fail-tint-${id}`);
  if (failTint) {
    const xOpacity = state.failureOpacity ?? (state.opacity < 0.55 ? 0 : Math.min(1, (state.opacity - 0.55) / 0.45));
    failTint.opacity(xOpacity * (failTint.getAttr('failTintStrength') ?? 1));
  }

  if (label) {
    const baseText = label.getAttr('baseText') ?? label.text();
    const baseFill = ensureBaseAttr(label, 'baseFill', label.fill());
    if (label.getAttr('independentText')) {
      if (state.textMode === 'write') {
        const charCount = Math.max(0, Math.ceil(baseText.length * (state.textProgress ?? 1)));
        label.text(getRenderedLabelText(label, baseText.slice(0, charCount)));
      } else {
        label.text(getRenderedLabelText(label, baseText));
      }
      label.opacity(1);
    } else {
      label.text(getRenderedLabelText(label, state.labelText ?? baseText));
      label.opacity(state.labelOpacity ?? 1);
    }
    label.fill(mixColor(state.morphFromTextColor ?? baseFill, state.targetTextColor, state.transformProgress ?? 0));
  }

  if (morphLabel) {
    const morphBaseFill = ensureBaseAttr(morphLabel, 'baseFill', morphLabel.fill());
    if (morphLabel.getAttr('independentText')) {
      morphLabel.text('');
      morphLabel.opacity(0);
    } else {
      morphLabel.text(getRenderedLabelText(morphLabel, state.morphLabelText ?? ''));
      morphLabel.opacity(state.morphLabelOpacity ?? 0);
    }
    morphLabel.fill(mixColor(state.morphFromTextColor ?? morphBaseFill, state.targetTextColor, state.transformProgress ?? 0));
  }

  const transformBody = getCachedNode(layer, `#node-body-transform-${id}`);
  const highlight = getCachedNode(layer, `#node-highlight-${id}`);
  const transformHighlight = getCachedNode(layer, `#node-highlight-transform-${id}`);

  if (body) {
    const isPopupActive = state.popupProgress > 0;
    const progress = state.transformProgress ?? 0;

    if (transformBody) {
      // Cross-fade: original body fades out, transform body (with target shape + colors) fades in.
      body.opacity(1 - progress);
      transformBody.opacity(progress);
      if (highlight) highlight.opacity(1 - progress);
      if (transformHighlight) transformHighlight.opacity(progress);

      // Keep original stroke during popup; no special highlight
      const baseStroke = body.getAttr('baseStroke') ?? body.stroke();
      const baseStrokeWidth = body.getAttr('baseStrokeWidth') ?? body.strokeWidth();
      body.stroke(baseStroke);
      body.strokeWidth(baseStrokeWidth);
    } else {
      // Legacy color-mix path
      const baseFill = ensureBaseAttr(body, 'baseFill', body.fill());
      const baseStroke = ensureBaseAttr(body, 'baseStroke', body.stroke());
      const baseStrokeWidth = ensureBaseAttr(body, 'baseStrokeWidth', body.strokeWidth());
      const baseCornerRadius = typeof body.cornerRadius === 'function'
        ? ensureBaseAttr(body, 'baseCornerRadius', body.cornerRadius())
        : null;

      // For chained morphs, blend from the previously committed morph value
      // (state.morphFrom*) instead of the node's original base, so a later morph
      // transitions out of the prior morph's color rather than the base color.
      const fromFill = state.morphFromFill ?? baseFill;
      const fromStroke = state.morphFromStroke ?? baseStroke;
      const fromStrokeWidth = state.morphFromStrokeWidth ?? baseStrokeWidth;
      const fromCornerRadius = state.morphFromCornerRadius ?? baseCornerRadius;
      body.fill(mixColor(fromFill, state.targetFill, progress));
      body.stroke(mixColor(fromStroke, state.targetStroke, progress));
      if (state.targetStrokeWidth != null) {
        body.strokeWidth(lerp(fromStrokeWidth, state.targetStrokeWidth, progress));
      }
      if (baseCornerRadius != null && state.targetCornerRadius != null && typeof body.cornerRadius === 'function') {
        body.cornerRadius(lerp(fromCornerRadius, state.targetCornerRadius, progress));
      }
    }
  }

  if (badgeBg) {
    const baseOpacity = ensureBaseAttr(badgeBg, 'baseOpacity', badgeBg.opacity());
    const targetOpacity = state.targetShowSubBadge == null || state.targetShowSubBadge ? 1 : 0;
    badgeBg.opacity(lerp(baseOpacity, targetOpacity, state.transformProgress ?? 0));
  }
  if (badgeText) {
    const baseOpacity = ensureBaseAttr(badgeText, 'baseOpacity', badgeText.opacity());
    const targetOpacity = state.targetShowSubBadge == null || state.targetShowSubBadge ? 1 : 0;
    badgeText.opacity(lerp(baseOpacity, targetOpacity, state.transformProgress ?? 0));
  }

  // Simple popup control (if present in this layer)
  if (popupGroup) {
    const h = typeof popupBg?.height === 'function' ? popupBg.height() : 24;
    const p = Math.max(0, Math.min(1, state.popupProgress ?? 0));
    const eased = easeOut3(p);
    const inside = Math.min(Math.floor(h * 0.35), 18);
    const keepInside = Math.max(6, Math.min(inside, 12));
    const targetY = inside + keepInside - h;
    popupGroup.y(lerp(0, targetY, eased));
    popupGroup.opacity(p > 0 ? Math.min(1, p * 1.25) : 0);
    popupGroup.setAttr('animDriven', p > 0);
  }
}

// Tokens fade in over the first moments of their run instead of popping in; they stay
// fully visible for the rest of the trip so the arrival is never cut short.
const TOKEN_FADE_IN = 0.15;
function getTokenFadeIn(elapsed, duration) {
  const fade = Math.min(TOKEN_FADE_IN, Math.max(0.0001, duration) * 0.3);
  const t = Math.max(0, Math.min(1, elapsed / fade));
  return t * t * (3 - 2 * t);
}

function applyLinkStateToId(layer, id, state, linkRenders, opts = {}, sourceId = id) {
  const shaft = getCachedNode(layer, `#link-shaft-${id}`);
  const head = getCachedNode(layer, `#link-head-${id}`);
  const token = getCachedNode(layer, `#link-token-${id}`);
  const tokenLabel = getCachedNode(layer, `#link-token-label-${id}`);
  if (!shaft) return;

  // Carry the whole link with its scrolling endpoints: translate the wrapping group
  // and fade it with the nodes. Cached base lets us restore the rest position on stop.
  const wrap = getCachedNode(layer, `#link-wrap-${id}`);
  if (wrap) {
    if (state.scrollDX != null || state.scrollDY != null) {
      let baseX = wrap.getAttr('scrollBaseX');
      let baseY = wrap.getAttr('scrollBaseY');
      if (baseX == null) { baseX = wrap.x(); wrap.setAttr('scrollBaseX', baseX); }
      if (baseY == null) { baseY = wrap.y(); wrap.setAttr('scrollBaseY', baseY); }
      const nextX = baseX + (state.scrollDX ?? 0);
      const nextY = baseY + (state.scrollDY ?? 0);
      const previousTime = wrap.getAttr('scrollPreviousTime');
      const currentTime = opts.currentTime ?? 0;
      const timeMovedForward = previousTime == null || currentTime >= previousTime;

      // Wrap detection is driven by the engine's deterministic per-band cycle index,
      // which ticks by exactly one each time the band wraps around the area edge — i.e.
      // each time its tile re-enters as the freshest message. Only the band that just
      // wrapped restarts its token, so the tokens stagger into a stream (one per ratchet
      // click across the columns) rather than all firing on the same frame. This fires
      // reliably regardless of where in the viewport the band sits — unlike a
      // frame-to-frame position-jump threshold, which the "wrap mismatch" frame
      // (scrollDX forced to 0) and seeks made misfire. On wrap we restart the manual
      // token from its own start so it replays exactly once, then stays hidden until the
      // next time this tile wraps.
      const cycleIndex = state.scrollCycleIndex;
      const previousCycleIndex = wrap.getAttr('scrollCycleIndex');
      if (timeMovedForward && cycleIndex != null && previousCycleIndex != null
          && cycleIndex !== previousCycleIndex) {
        // Record the time between consecutive wraps so the token's pass can be scaled
        // to finish inside one cycle (see getManualDuration). Without this a token
        // whose configured duration is longer than the gap between wraps only reaches
        // the middle of the link before the next wrap resets it. Prefer the engine's
        // deterministic seconds-per-wrap (known from the first wrap, jitter-free); fall
        // back to the measured frame-to-frame interval only when it is unavailable.
        const lastRestart = wrap.getAttr('manualTokenRestartTime');
        if (!(state.scrollCyclePeriod > 0.0001)
            && lastRestart != null && currentTime > lastRestart) {
          wrap.setAttr('manualTokenCycleDuration', currentTime - lastRestart);
        }
        wrap.setAttr('manualTokenRestartTime', currentTime);
        // Re-entry fade: a wrapped link should reappear fresh like the nodes do
        // (which use the same fade), instead of teleporting in fully solid. This is
        // a gentle opacity fade — NOT a draw-in replay, which broke the smooth glide.
        // Seamless loops keep the wrap off-screen, so this fade only adds a blink at
        // the loop seam — skip it there.
        if (!state.scrollSeamless) wrap.setAttr('scrollFadeStartTime', currentTime);
        // Also briefly re-draw the link shaft on wrap so the link "plays" at each
        // re-entry in the loop area. This only affects fully-drawn links; bound/drawing
        // links continue their normal progress.
        wrap.setAttr('wrapDrawStartTime', currentTime);
      }
      if (!timeMovedForward) {
        wrap.setAttr('manualTokenRestartTime', undefined);
        if (!(state.scrollCyclePeriod > 0.0001)) {
          wrap.setAttr('manualTokenCycleDuration', undefined);
        }
        wrap.setAttr('scrollFadeStartTime', undefined);
      }
      if (state.scrollSeamless) wrap.setAttr('scrollFadeStartTime', undefined);
      // Deterministic seconds-per-wrap from the engine: publish it every carried frame
      // so the token's pass is sized to one cycle from the very first wrap (no need to
      // wait for two wraps to measure the gap). Falls back to the measured value above.
      if (state.scrollCyclePeriod > 0.0001) {
        wrap.setAttr('manualTokenCycleDuration', state.scrollCyclePeriod);
      }
      wrap.setAttr('scrollCycleIndex', cycleIndex);

      wrap.x(nextX);
      wrap.y(nextY);
      wrap.setAttr('scrollPreviousX', nextX);
      wrap.setAttr('scrollPreviousY', nextY);
      wrap.setAttr('scrollPreviousTime', currentTime);
      let wrapOpacity = state.scrollOpacity ?? 1;
      const fadeStartTime = wrap.getAttr('scrollFadeStartTime');
      if (fadeStartTime != null) {
        const fadeProgress = clamp((currentTime - fadeStartTime) / 0.18, 0, 1);
        wrapOpacity *= 0.18 + 0.82 * easeOut3(fadeProgress);
        if (fadeProgress >= 1) wrap.setAttr('scrollFadeStartTime', undefined);
      }
      wrap.opacity(wrapOpacity);
      // Clip to the area edge when carried; a hidden (wrap-mismatch) link needs no clip.
      if ((state.scrollOpacity ?? 1) > 0) applyScrollClip(wrap, state.scrollClip);
      else clearScrollClip(wrap);
    } else if (wrap.getAttr('scrollBaseX') != null) {
      wrap.x(wrap.getAttr('scrollBaseX'));
      wrap.y(wrap.getAttr('scrollBaseY'));
      wrap.opacity(1);
      wrap.setAttr('scrollPreviousX', undefined);
      wrap.setAttr('scrollPreviousY', undefined);
      wrap.setAttr('scrollPreviousTime', undefined);
      wrap.setAttr('manualTokenRestartTime', undefined);
      wrap.setAttr('manualTokenCycleDuration', undefined);
      wrap.setAttr('scrollCycleIndex', undefined);
      wrap.setAttr('scrollFadeStartTime', undefined);
      clearScrollClip(wrap);
    }
  }

  // Manual tokens normally use absolute timeline time. Once a carried link wraps,
  // restart from that token's own start point so it immediately reappears at the
  // beginning of the link and replays its duration, direction, and text keyframes.
  const absoluteTime = opts.currentTime ?? 0;
  const manualRestartTime = wrap?.getAttr('manualTokenRestartTime');
  const manualElapsedAfterWrap = manualRestartTime != null
    ? Math.max(0, absoluteTime - manualRestartTime)
    : null;
  const getManualTime = manual => (
    manualElapsedAfterWrap != null && manual
      ? (manual.start ?? 0) + manualElapsedAfterWrap // single pass after reset, then hide
      : absoluteTime
  );
  // Effective token duration. When the link is carried by a scrolling area we clamp
  // the configured duration to a little under the measured wrap interval, so the
  // token always completes one full pass and briefly disappears before the next
  // object spawns — instead of being cut off mid-link when cycles are short.
  const manualCycleDuration = wrap?.getAttr('manualTokenCycleDuration');
  const clampToCycle = seconds => {
    const s = Math.max(0.0001, seconds);
    return manualCycleDuration != null && manualCycleDuration > 0.0001
      ? Math.min(s, manualCycleDuration * 0.9)
      : s;
  };
  const getManualDuration = manual => clampToCycle(manual?.duration ?? 0.6);

  const renderData = linkRenders[id];
  const drawLength = renderData?.visibleLength ?? renderData?.length ?? 200;
  const totalLength = renderData?.length ?? drawLength;

  // If bound to token hop, override draw progress to match hop timing
  const tNowLink = opts.currentTime ?? 0;
  const isBoundDraw = !!opts.bindToTokenHopById?.[id];
  let drawProgress = state.progress;
  if (isBoundDraw) {
    const boundMeta = opts.bindMetaById?.[id] ?? { offset: 0, scale: 1 };
    let web = opts.webByLinkId?.[id] ?? null;
    let timing = web?.tokenTiming?.[id] ?? null;
    if (!timing) {
      for (const w of opts.webs ?? []) {
        const tt = w?.tokenTiming?.[id];
        if (tt) { web = w; timing = tt; break; }
      }
    }
    if (timing && !timing.skipped && web?.inputMode !== 'silent') {
      const manualStart = opts.linkStartOverrideById?.[id];
      const start = (manualStart ?? ((timing.start ?? 0) + (Number.isFinite(boundMeta.offset) ? boundMeta.offset : 0)));
      const manualDur = opts.linkDurationOverrideById?.[id];
      const dur = Math.max(0.0001, manualDur ?? ((timing.duration ?? 0.0001) * (Number.isFinite(boundMeta.scale) && boundMeta.scale > 0 ? boundMeta.scale : 1)));
      const raw = (tNowLink - start) / dur;
      drawProgress = easeOut3(Math.max(0, Math.min(1, raw)));
    }
  }

  // If the link just wrapped and it's otherwise fully drawn, briefly replay a draw-in
  // so the link visibly "plays" per wrap. Use a short ease to avoid a harsh blink.
  let effectiveDrawProgress = drawProgress;
  if (wrap) {
    const wds = wrap.getAttr('wrapDrawStartTime');
    const now = opts.currentTime ?? 0;
    if (wds != null) {
      const dt = now - wds;
      const RDUR = 0.5;
      if (dt >= 0 && dt <= RDUR) {
        const p = easeOut3(Math.max(0, Math.min(1, dt / RDUR)));
        if (drawProgress >= 1) effectiveDrawProgress = p;
      } else {
        wrap.setAttr('wrapDrawStartTime', undefined);
      }
    }
  }
  shaft.opacity(effectiveDrawProgress > 0.001 ? 1 : 0);

  // Fail-at-ends overlay: briefly tint entire shaft red at the END while playing.
  const failEndsActive = !!opts.failAtEndsById?.[sourceId];
  const isPlayingNow = opts.isPlaying !== false; // default true unless explicitly false

  // Determine 'end' progress to use for failure timing: prefer token timing (bound/variable/manual) else draw progress
  const tNow = opts.currentTime ?? 0;
  let endProgress = drawProgress; // fallback
  let manualTiming = null;
  if (!isBoundDraw) {
    // Try variable web token timing first
    let foundWeb = null;
    let foundTiming = null;
    const webs = opts.webs ?? [];
    for (const w of webs) {
      const tt = w?.tokenTiming?.[id];
      if (tt && !tt.skipped && w.inputMode !== 'silent' && tNow >= tt.start && tNow <= tt.start + tt.duration) {
        foundWeb = w; foundTiming = tt; break;
      }
    }
    if (foundTiming) {
      endProgress = Math.max(0, Math.min(1, (tNow - foundTiming.start) / Math.max(0.0001, foundTiming.duration)));
    } else {
      // Fall back to manual timing if present and active
      const manual = opts.manualTokenTimingById?.[sourceId] ?? opts.manualTokenTimingById?.[id] ?? null;
      manualTiming = manual;
      if (manual) {
        const mStart = manual.start ?? -Infinity;
        const mDur = getManualDuration(manual);
        const manualTime = getManualTime(manual);
        let mp = (manualTime - mStart) / mDur;
        if (manual.invert === true) mp = 1 - mp;
        if (mp >= 0 && mp <= 1) endProgress = mp;
      }
    }
  }

  const failOverlay = getCachedNode(layer, `#link-shaft-fail-overlay-${id}`);
  const tokenEndMode = !!opts.failOnTokenEndById?.[sourceId];
  // Timed failure keyframe (same behaviour as a node's): animates in over its block, then stays.
  const timedFailure = opts.linkFailureById?.[sourceId] ?? null;
  const timedFailureOpacity = timedFailure ? getNodeFailureOpacity(timedFailure, opts.currentTime ?? 0) : 0;
  // Manual token end COMPLETE detection (independent of invert): after start+duration
  const manualHasTiming = !!manualTiming;
  const manualTimingTime = getManualTime(manualTiming);
  const manualTimingDuration = manualHasTiming ? getManualDuration(manualTiming) : 0.6;
  const manualEndReached = manualHasTiming
    ? ((manualTimingTime - (manualTiming.start ?? -Infinity)) >= manualTimingDuration)
    : false;
  // Decide which progress metric to use for non-manual end-fade display
  const progressForFail = endProgress; // already prefers token where available

  if (failOverlay) {
    if (tokenEndMode && manualHasTiming && renderData) {
      // Smooth transition from normal to failure after manual token finishes
      const TRANS = 0.25; // seconds
      const endT = (manualTiming.start ?? -Infinity) + manualTimingDuration;
      const mix = manualEndReached ? Math.max(0, Math.min(1, (manualTimingTime - endT) / TRANS)) : 0;
      failOverlay.opacity(mix);
    } else if (timedFailure) {
      // The overlay covers the whole path, so only recolor once the link is fully drawn.
      const drawn = effectiveDrawProgress >= 1 ? 1 : 0;
      failOverlay.opacity(timedFailureOpacity * drawn * (failOverlay.getAttr('failTintStrength') ?? 1));
    } else if (failEndsActive && isPlayingNow && renderData && progressForFail > 0 && progressForFail < 1) {
      const WIN = 0.08;
      const nearEnd = progressForFail >= (1 - WIN);
      if (nearEnd) {
        const alpha = Math.max(0, Math.min(1, (progressForFail - (1 - WIN)) / WIN));
        failOverlay.opacity(alpha);
      } else {
        failOverlay.opacity(0);
      }
    } else {
      failOverlay.opacity(0);
    }
  }

  if (effectiveDrawProgress >= 1) {
    shaft.dashEnabled(false);
  } else {
    shaft.dashEnabled(true);
    shaft.dash([drawLength, totalLength + drawLength]);
    shaft.dashOffset(drawLength * (1 - effectiveDrawProgress));
  }

  if (head && renderData) {
    const isBoundForHead = !!opts.bindToTokenHopById?.[id];
    if (isBoundForHead) {
      // Hide arrow head entirely when following token timing
      head.opacity(0);
    } else {
      const animatedHead = getAnimatedArrowHead(renderData, effectiveDrawProgress);
      head.points(animatedHead.points);
      head.opacity(head.getAttr('showTip') ? animatedHead.opacity : 0);
    }
  }

  // Token rendering:
  // - Normally driven by variable web hop timing (independent of draw progress)
  // - If a link is bound to a token hop, keep the token at the drawing tip using draw progress
  if (token && renderData) {
    const tNow = opts.currentTime ?? 0;
    const primaryWeb = opts.webByLinkId?.[id];
    const primaryTiming = primaryWeb?.tokenTiming?.[id];
    let web = primaryWeb;
    let timing = primaryTiming;
    const isBound = !!opts.bindToTokenHopById?.[id];

    const isActive = (w, tt) => (
      !!w && !!tt && !tt.skipped && w.inputMode !== 'silent' && tNow >= tt.start && tNow <= tt.start + tt.duration
    );

    if (!isActive(web, timing)) {
      // Fallback: find any active web for this link at the current time
      const webs = opts.webs ?? [];
      let found = null;
      for (const w of webs) {
        const tt = w?.tokenTiming?.[id];
        if (isActive(w, tt)) { found = [w, tt]; break; }
      }
      if (found) { web = found[0]; timing = found[1]; }
    }

    if (isBound) {
      // Bound: token rides the drawing tip based on draw progress only.
      if (drawProgress <= 0 || drawProgress > 1) {
        token.opacity(0);
      } else {
        const { point } = getPointAtProgress(renderData, drawProgress, true);
        token.x(point.x);
        token.y(point.y);
        token.opacity(1);
        if (tokenLabel) { tokenLabel.text((web?.displayText ?? '') || ''); tokenLabel.opacity(1); }
      }
    } else {
      // Manual per-link token timing (independent of variables)
      const manual = opts.manualTokenTimingById?.[sourceId] ?? opts.manualTokenTimingById?.[id] ?? null;
      if (isActive(web, timing)) {
        const tokenProgress = (tNow - timing.start) / timing.duration;
        const { point } = getPointAtProgress(renderData, tokenProgress, true);
        token.x(point.x);
        token.y(point.y);
        token.opacity(getTokenFadeIn(tNow - timing.start, timing.duration));
        if (tokenLabel) { tokenLabel.text(web.displayText ?? ''); tokenLabel.opacity(1); }
      } else if (manual) {
        // When the link participates in a scrolling area, suppress manual tokens until
        // the first wrap after a reset. This prevents every manual token from firing
        // immediately at timeline start; instead, each token replays once when its tile
        // re-enters (on wrap), then stays hidden until the next wrap.
        const isInScrollContext = (
          state.scrollCycleIndex != null ||
          state.scrollClip != null
        );
        const hasWrapRestart = manualElapsedAfterWrap != null;
        const cycleElapsed = state.scrollCycleElapsed;
        // A deterministic per-wrap period (engine-computed seconds between this band's
        // wraps) is the export-safe signal. When it's known we drive the token from the
        // engine's per-tile "seconds since this band's wrap" for BOTH seamless and
        // non-seamless loops — the only difference between them is the re-entry fade
        // (handled in the carried-wrap block above), not the token timing.
        const hasCyclePeriod = manualCycleDuration != null && manualCycleDuration > 0.0001;
        if (isInScrollContext && cycleElapsed != null && (state.scrollSeamless || hasCyclePeriod)) {
          // Drive the token from the engine's deterministic per-band "seconds since this
          // band's wrap" (`cycleElapsed`) instead of the frame-to-frame wrap event. The
          // event never fires reliably in exported GIFs/PPTX (state is reset and only a
          // single cycle is captured), which left looped tokens hidden or wrong on export.
          // Because it's per-band, only the band that just wrapped launches its token.
          const mStart = manual.start ?? 0;
          // Replay the token as a SHORT pass ("dart") of its configured duration right
          // after this band wraps, then hide it until the band wraps again — for both
          // seamless and non-seamless loops. The window must stay near the per-tile
          // spawn cadence: a full-cycle glide (≈0.9 × cyclePeriod) keeps almost every
          // band's token on screen at once, so all but the about-to-wrap band appear lit
          // ("all fire except the wrapping one"). The configured duration (which clamps
          // to the cycle) keeps only the freshly-wrapped band visible at a time.
          const mDur = getManualDuration(manual);
          const manualTime = mStart + cycleElapsed;
          let mp = cycleElapsed / mDur;
          if (manual.invert === true) mp = 1 - mp;
          if (absoluteTime >= mStart && mp >= 0 && mp <= 1) {
            const { point } = getPointAtProgress(renderData, mp, true);
            token.x(point.x);
            token.y(point.y);
            // Fade the token in as it appears on each wrap (over the first slice of the
            // pass) instead of popping in solid. Driven by `cycleElapsed` (seconds since
            // this band wrapped), so the fade is deterministic and identical in viewport
            // and export.
            const fadeDur = Math.min(0.18, mDur * 0.5);
            token.opacity(clamp(cycleElapsed / Math.max(0.0001, fadeDur), 0, 1));
            if (tokenLabel) {
              const { text, opacity } = getManualTokenTextFadeAtTime(manual, manualTime);
              tokenLabel.text(text.slice(0, manual.textMaxLength ?? 6));
              tokenLabel.opacity(opacity);
            }
          } else {
            token.opacity(0);
            if (tokenLabel) tokenLabel.text('');
          }
        } else if (isInScrollContext && !hasWrapRestart) {
          token.opacity(0);
          // Also keep label hidden pre-wrap for consistency
          if (tokenLabel) tokenLabel.text('');
        } else {
          const mStart = manual.start ?? -Infinity;
          const mDur = getManualDuration(manual);
          const manualTime = getManualTime(manual);
          let mp = (manualTime - mStart) / mDur;
          // Invert manual token flow if requested
          if (manual.invert === true) mp = 1 - mp;
          if (mp >= 0 && mp <= 1) {
            const { point } = getPointAtProgress(renderData, mp, true);
            token.x(point.x);
            token.y(point.y);
            token.opacity(getTokenFadeIn(manualTime - mStart, mDur));
            if (tokenLabel) {
              const { text, opacity } = getManualTokenTextFadeAtTime(manual, manualTime);
              tokenLabel.text(text.slice(0, manual.textMaxLength ?? 6));
              tokenLabel.opacity(opacity);
            }
          } else {
            token.opacity(0);
          }
        }
      } else {
        token.opacity(0);
      }
    }
  }

  // Fail X: a "broken link" marker drawn at the link midpoint. It must read as a
  // state, not just a brief moment during playback — when a fail option is on, the
  // X should be visible while paused, scrubbing, or stopped too, otherwise enabling
  // the option looks like nothing happened. Position is always the current midpoint.
  const failMark = getCachedNode(layer, `#link-fail-${id}`);
  if (failMark) {
    const failAtEnds = !!opts.failAtEndsById?.[sourceId];
    const tokenEndMode = !!opts.failOnTokenEndById?.[sourceId];
    const isFailing = !!opts.failingById?.[sourceId];

    const mid = renderData
      ? (getPointAtProgress(renderData, 0.5, true)?.point ?? renderData.endPoint)
      : null;
    if (mid) { failMark.x(mid.x); failMark.y(mid.y); }

    const setMark = (alpha) => {
      const a = Math.max(0, Math.min(1, alpha));
      failMark.opacity(a);
      failMark.scaleX(0.9 + 0.1 * a);
      failMark.scaleY(0.9 + 0.1 * a);
    };

    if (tokenEndMode && manualHasTiming && renderData) {
      // Smooth fade/scale once the manual token finishes its run.
      const TRANS = 0.25;
      const endT = (manualTiming.start ?? -Infinity) + manualTimingDuration;
      const mix = manualEndReached ? (manualTimingTime - endT) / TRANS : 0;
      setMark(1 - Math.pow(1 - Math.max(0, Math.min(1, mix)), 3));
    } else if (tokenEndMode && renderData) {
      // Web/variable token (or no manual timing): reveal the X as the token
      // reaches the end of the link, then keep it shown afterwards.
      const TRANS_P = 0.12;
      const past = progressForFail >= 1 ? 1 : (progressForFail - (1 - TRANS_P)) / TRANS_P;
      setMark(1 - Math.pow(1 - Math.max(0, Math.min(1, past)), 3));
    } else if (failAtEnds && renderData) {
      // Reveal the X as the draw/token front reaches the end, then keep it shown.
      const WIN = 0.08;
      setMark(progressForFail >= 1 ? 1 : (progressForFail - (1 - WIN)) / WIN);
    } else if (timedFailure) {
      setMark(timedFailureOpacity);
    } else if (isFailing) {
      // Static "failing" link: show the X once the link has drawn in.
      const drawn = state.progress ?? 1;
      setMark(drawn < 0.42 ? 0 : (drawn - 0.42) / 0.2);
    } else {
      failMark.opacity(0);
    }
  }
}

function formatMonitorTemplate(template, track, time, explicitValue) {
  const value = explicitValue != null
    ? explicitValue
    : track?.textKeyframes
      ? getManualTokenTextAtTime(track, time)
      : (track?.variableValue || track?.variableName || '');
  const name = track?.variableName || '';
  if (!template) return value;
  return template.replace(/\{value\}/g, value).replace(/\{name\}/g, name);
}

function applyMonitorStates(layer, options, currentTime) {
  const monitors = options.monitors;
  if (!monitors || !monitors.length) return;
  const webs = options.webs ?? [];
  const manualTracks = Object.values(options.manualTokenTimingById ?? {});

  for (const monitor of monitors) {
    const valueNode = getCachedNode(layer, `#monitor-value-${monitor.id}`);
    const nextNode = getCachedNode(layer, `#monitor-value-next-${monitor.id}`);
    if (!valueNode) continue;

    // Morphs take precedence: when a monitor carries text morphs they script the
    // displayed value and its color directly, independent of token arrivals. The
    // body fill/stroke morphs are already applied via applyNodeStateToId.
    const morphs = getNodeTextMorphs(monitor);
    if (morphs.length) {
      const timing = { start: 0, duration: 0.5 };
      const baseValue = monitor.initialValue ?? '';
      const textState = getTextMorphRenderState({ ...monitor, label: baseValue }, timing, currentTime);
      const valueColor = resolveMonitorTextColor(monitor, morphs, currentTime);
      valueNode.text(textState.baseText);
      valueNode.opacity(textState.baseOpacity);
      valueNode.fill(valueColor);
      if (nextNode) {
        nextNode.text(textState.overlayText);
        nextNode.opacity(textState.overlayOpacity);
        nextNode.fill(valueColor);
      }
      continue;
    }

    const track = webs.find(w => w.sourceNodeId === monitor.variableNodeId)
      ?? manualTracks.find(item => item.sourceNodeId === monitor.variableNodeId);
    const configuredWatches = monitor.monitorWatches ?? [];
    const watches = configuredWatches.length > 0
      ? configuredWatches
      : track?.destinationNodeId
        ? [{ id: 'implicit-destination', nodeId: track.destinationNodeId, template: '{value}' }]
        : [];
    const initialValue = monitor.initialValue ?? '';

    // Determine the latest arrived watch (<= currentTime) and the immediate previous one
    let best = null;
    let prev = null;
    if (track && watches.length) {
      const template = watches[0]?.template ?? '{value}';
      const arrivals = Array.isArray(track.monitorEvents)
        ? track.monitorEvents
            .map(event => ({
              w: { id: event.id, template },
              at: event.at,
              value: event.value,
            }))
            .filter(item => item.at != null)
            .sort((a, b) => a.at - b.at)
        : watches
            .map(w => ({ w, at: track.arrivalAtNode?.[w.nodeId] }))
            .filter(item => item.at != null)
            .sort((a, b) => a.at - b.at);
      for (const item of arrivals) {
        if (item.at <= currentTime) {
          if (!best || item.at >= best.at) {
            prev = best;
            best = item;
          }
        } else {
          break;
        }
      }
    }

    const prevText = prev
      ? formatMonitorTemplate(prev.w.template, track, prev.at, prev.value)
      : initialValue;
    const targetText = best
      ? formatMonitorTemplate(best.w.template, track, best.at, best.value)
      : initialValue;

    const FADE_DUR = 0.25;
    if (!best) {
      // No value yet — show initial
      valueNode.text(initialValue);
      valueNode.opacity(1);
      if (nextNode) nextNode.opacity(0);
      continue;
    }

    const dt = currentTime - best.at;
    if (!nextNode) {
      // No overlay available — snap to current text
      valueNode.text(dt >= FADE_DUR ? targetText : prevText);
      valueNode.opacity(1);
      continue;
    }

    if (dt <= 0) {
      // Before change time — show previous fully
      valueNode.text(prevText);
      valueNode.opacity(1);
      nextNode.text('');
      nextNode.opacity(0);
      continue;
    }

    if (dt < FADE_DUR) {
      const p = Math.max(0, Math.min(1, dt / FADE_DUR));
      valueNode.text(prevText);
      valueNode.opacity(1 - p);
      nextNode.text(targetText);
      nextNode.opacity(p);
      continue;
    }

    // After fade — show target fully
    valueNode.text(targetText);
    valueNode.opacity(1);
    nextNode.text('');
    nextNode.opacity(0);
  }
}

const GHOST_OPACITY = 0.13;

export function applyAnimState(layer, animState, linkRenders, mirrorBindings = null, options = {}) {
  const currentTime = options.currentTime ?? 0;
  const showGhostNodes = options.showGhostNodes ?? false;
  for (const [id, state] of Object.entries(animState.nodeStates)) {
    applyNodeStateToId(layer, id, state, currentTime);
    if (showGhostNodes && state.opacity < 0.01) {
      const g = getCachedNode(layer, `#node-${id}`);
      if (g) { g.opacity(GHOST_OPACITY); g.scaleX(1); g.scaleY(1); }
    }
    for (const mirrorId of mirrorBindings?.nodeIdsBySourceId?.[id] ?? []) {
      applyNodeStateToId(layer, mirrorId, state, currentTime);
      if (showGhostNodes && state.opacity < 0.01) {
        const g = getCachedNode(layer, `#node-${mirrorId}`);
        if (g) { g.opacity(GHOST_OPACITY); g.scaleX(1); g.scaleY(1); }
      }
    }

    // Graph vectors (arrows) draw timing per node
    const vectorsGroup = getCachedNode(layer, `#graph-vectors-${id}`);
    if (vectorsGroup && typeof vectorsGroup.getChildren === 'function') {
      const tAbs = options.currentTime ?? 0;
      const tNow = tAbs;
      const children = vectorsGroup.getChildren() || [];
      for (const child of children) {
        const start = Number(child.getAttr('vStart')) || 0;
        const dur = Math.max(0.0001, Number(child.getAttr('vDur')) || 0.4);
        const raw = (tNow - start) / dur;
        const p = Math.max(0, Math.min(1, raw));
        const livePts = Array.isArray(child.points?.()) ? child.points() : [];
        const basePts = Array.isArray(child.getAttr('basePoints'))
          ? child.getAttr('basePoints')
          : livePts.slice();
        child.setAttr('basePoints', basePts);
        let len = child.getAttr('baseLength');
        if (!(Number.isFinite(len) && len > 0)) {
          len = 0;
          for (let i = 0; i + 3 < basePts.length; i += 2) {
            const dx = basePts[i + 2] - basePts[i];
            const dy = basePts[i + 3] - basePts[i + 1];
            len += Math.hypot(dx, dy);
          }
          child.setAttr('baseLength', len);
        }
        if (len > 0 && basePts.length >= 4) {
          child.dashEnabled(false);
          const x1 = basePts[0];
          const y1 = basePts[1];
          const x2 = basePts[basePts.length - 2];
          const y2 = basePts[basePts.length - 1];
          child.points([x1, y1, x1 + (x2 - x1) * p, y1 + (y2 - y1) * p]);
          child.opacity(p > 0.001 ? 1 : 0);
        } else {
          child.dashEnabled(false);
          child.opacity(p);
        }
      }
    }

    // Graph points: when vectors are sequential, make points appear when their inbound vector completes.
    // Fallback to point keyframes when not sequential or when no inbound vector exists.
    const pointsGroup = getCachedNode(layer, `#graph-points-${id}`);
    if (pointsGroup && typeof pointsGroup.getChildren === 'function') {
      const tAbs = options.currentTime ?? 0;
      const tNow = tAbs;
      const isSeq = !!vectorsGroup?.getAttr('vSeq');
      let inboundEndByToId = null;
      if (isSeq && vectorsGroup && typeof vectorsGroup.getChildren === 'function') {
        inboundEndByToId = new Map();
        for (const v of vectorsGroup.getChildren() || []) {
          const toId = v.getAttr('vTo');
          if (!toId) continue;
          const vs = Number(v.getAttr('vStart')) || 0;
          const vd = Math.max(0.0001, Number(v.getAttr('vDur')) || 0.4);
          const end = vs + vd;
          const prev = inboundEndByToId.get(toId) ?? -Infinity;
          if (end > prev) inboundEndByToId.set(toId, end);
        }
      }
      const children = pointsGroup.getChildren() || [];
      for (const child of children) {
        if (child.getAttr('editorPreview')) continue;
        const ptId = child.getAttr('pId') || null;
        const startKF = Number(child.getAttr('pStart')) || 0;
        const durKF = Math.max(0.0001, Number(child.getAttr('pDur')) || 0.35);
        const start = (isSeq && ptId && inboundEndByToId?.has(ptId)) ? inboundEndByToId.get(ptId) : startKF;
        const dur = durKF; // fade duration
        const raw = (tNow - start) / dur;
        const p = Math.max(0, Math.min(1, raw));
        child.opacity(p);
      }
    }

    // HKDF domain circles: fade each domain in from its startTime, and scatter the
    // "calculate" dots inside it (each dot fades in at its own cStart/cDur).
    const domainsGroup = getCachedNode(layer, `#graph-domains-${id}`);
    if (domainsGroup && typeof domainsGroup.getChildren === 'function') {
      const tNow = options.currentTime ?? 0;
      for (const domGroup of domainsGroup.getChildren() || []) {
        const start = Number(domGroup.getAttr('dStart')) || 0;
        const dur = Math.max(0.0001, Number(domGroup.getAttr('dDur')) || 0.4);
        domGroup.opacity(Math.max(0, Math.min(1, (tNow - start) / dur)));

        // Time-aware override clip: a higher-priority domain only carves its hole
        // out of this one once it has appeared. Until then this domain renders whole,
        // so a domain whose appear keyframe comes later doesn't erase what's beneath it.
        const overrides = domGroup.getAttr('overrideCircles');
        if (Array.isArray(overrides) && overrides.length) {
          const active = overrides.filter(o => tNow >= (Number(o.start) || 0));
          const sig = active.map(o => `${o.sx},${o.sy},${o.rad}`).join('|');
          if (sig !== domGroup.getAttr('clipSig')) {
            domGroup.setAttr('clipSig', sig);
            domGroup.clipFunc(active.length ? (ctx) => {
              const BIG = 100000;
              // Subtract each higher-priority circle by intersecting the clip with that
              // circle's complement (rect-minus-circle). Composing one clip() per circle
              // is correct for ANY number of overlaps — a single winding path leaks a
              // lower domain through wherever 2+ higher circles overlap.
              for (const o of active) {
                ctx.beginPath();
                ctx.rect(-BIG, -BIG, 2 * BIG, 2 * BIG);
                ctx.arc(o.sx, o.sy, o.rad, 0, Math.PI * 2, true);
                ctx.clip();
              }
              // Konva issues one final clip() after this; hand it a full-area path so it
              // doesn't narrow the region we just built.
              ctx.beginPath();
              ctx.rect(-BIG, -BIG, 2 * BIG, 2 * BIG);
            } : null);
          }
        } else if (domGroup.clipFunc()) {
          domGroup.clipFunc(null);
          domGroup.setAttr('clipSig', undefined);
        }

        const dotsGroup = typeof domGroup.findOne === 'function' ? domGroup.findOne('.calc-dots') : null;
        if (dotsGroup && typeof dotsGroup.getChildren === 'function') {
          for (const dot of dotsGroup.getChildren() || []) {
            const cs = Number(dot.getAttr('cStart')) || 0;
            const cd = Math.max(0.0001, Number(dot.getAttr('cDur')) || 0.2);
            dot.opacity(Math.max(0, Math.min(1, (tNow - cs) / cd)));
          }
        }
      }
    }
  }

  for (const [id, state] of Object.entries(animState.linkStates)) {
    applyLinkStateToId(layer, id, state, linkRenders, options);
    for (const mirrorId of mirrorBindings?.linkIdsBySourceId?.[id] ?? []) {
      applyLinkStateToId(layer, mirrorId, state, linkRenders, options, id);
    }
  }

  applyMonitorStates(layer, options, options.currentTime ?? 0);
}

function resetNodeById(layer, id, isFailing = false) {
  const group = getCachedNode(layer, `#node-${id}`);
  const label = getCachedNode(layer, `#node-label-${id}`);
  const morphLabel = getCachedNode(layer, `#node-label-morph-${id}`);
  const body = getCachedNode(layer, `#node-body-${id}`);
  const highlight = getCachedNode(layer, `#node-highlight-${id}`);
  const badgeBg = getCachedNode(layer, `#node-sub-badge-bg-${id}`);
  const badgeText = getCachedNode(layer, `#node-sub-badge-text-${id}`);
  const popupGroup = getCachedNode(layer, `#node-popup-${id}`);
  if (!group) return;
  group.opacity(1);
  group.scaleX(1);
  group.scaleY(1);
  group.setAttr('isPopupActive', false);
  // Undo any scrolling-area translation/clip so the node returns to its rest state.
  const scrollBaseX = group.getAttr('scrollBaseX');
  const scrollBaseY = group.getAttr('scrollBaseY');
  if (scrollBaseX != null) group.x(scrollBaseX);
  if (scrollBaseY != null) group.y(scrollBaseY);
  group.setAttr('scrollPreviousX', undefined);
  group.setAttr('scrollPreviousY', undefined);
  group.setAttr('scrollPreviousTime', undefined);
  group.setAttr('scrollFadeStartTime', undefined);
  group.setAttr('scrollCycleIndex', undefined);
  clearScrollClip(group);
  if (label) label.text(getRenderedLabelText(label, label.getAttr('baseText') ?? label.text()));
  if (label) label.opacity(1);
  if (label) label.fill(label.getAttr('baseFill') ?? label.fill());
  if (morphLabel) {
    morphLabel.text('');
    morphLabel.opacity(0);
    morphLabel.fill(morphLabel.getAttr('baseFill') ?? morphLabel.fill());
  }
  if (body) {
    body.opacity(1);
    body.fill(body.getAttr('baseFill') ?? body.fill());
    body.stroke(body.getAttr('baseStroke') ?? body.stroke());
    body.strokeWidth(body.getAttr('baseStrokeWidth') ?? body.strokeWidth());
  }
  if (highlight) highlight.opacity(1);
  const transformBodyReset = getCachedNode(layer, `#node-body-transform-${id}`);
  if (transformBodyReset) transformBodyReset.opacity(0);
  const transformHighlightReset = getCachedNode(layer, `#node-highlight-transform-${id}`);
  if (transformHighlightReset) transformHighlightReset.opacity(0);
  if (badgeBg) badgeBg.opacity(badgeBg.getAttr('baseOpacity') ?? 1);
  if (badgeText) badgeText.opacity(badgeText.getAttr('baseOpacity') ?? 1);
  if (popupGroup) {
    popupGroup.opacity(0);
    popupGroup.y(0);
    popupGroup.setAttr('animDriven', false);
  }

  // Reset graph points to hidden until their keyframe time
  const pointsGroup = getCachedNode(layer, `#graph-points-${id}`);
  if (pointsGroup && typeof pointsGroup.getChildren === 'function') {
    for (const child of pointsGroup.getChildren()) {
      if (child.getAttr('editorPreview')) continue;
      child.opacity(0);
    }
  }

  const domainsGroupReset = getCachedNode(layer, `#graph-domains-${id}`);
  if (domainsGroupReset && typeof domainsGroupReset.getChildren === 'function') {
    for (const domGroup of domainsGroupReset.getChildren()) {
      domGroup.opacity(0);
      if (typeof domGroup.clipFunc === 'function' && domGroup.clipFunc()) {
        domGroup.clipFunc(null);
        domGroup.setAttr('clipSig', undefined);
      }
      const dotsGroup = typeof domGroup.findOne === 'function' ? domGroup.findOne('.calc-dots') : null;
      if (dotsGroup && typeof dotsGroup.getChildren === 'function') {
        for (const dot of dotsGroup.getChildren()) dot.opacity(0);
      }
    }
  }

  // Graph reset
  for (const pref of [
    `#graph-line-main-s`,
    `#graph-line-top-s`,
    `#graph-line-bot-s`,
  ]) {
    for (let i = 0; i < 256; i += 1) {
      const sel = `${pref}${i}-${id}`;
      const glr = getCachedNode(layer, sel);
      if (!glr) break;
      glr.dashEnabled(false);
      glr.opacity(1);
    }
  }

  const vectorsGroupReset = getCachedNode(layer, `#graph-vectors-${id}`);
  if (vectorsGroupReset && typeof vectorsGroupReset.getChildren === 'function') {
    for (const child of vectorsGroupReset.getChildren()) {
      const basePts = child.getAttr('basePoints');
      if (Array.isArray(basePts) && typeof child.points === 'function') {
        child.points(basePts);
      }
      child.dashEnabled(false);
      child.opacity(0);
    }
  }

  const failMark = getCachedNode(layer, `#node-fail-${id}`);
  if (failMark) {
    failMark.opacity(isFailing ? 1 : 0);
    failMark.scale({ x: 1, y: 1 });
  }

  const failTint = getCachedNode(layer, `#node-fail-tint-${id}`);
  if (failTint) {
    failTint.opacity(isFailing ? (failTint.getAttr('failTintStrength') ?? 1) : 0);
  }

  // Area reset — restore rect to full dimensions and label to full opacity
  const areaRect = getCachedNode(layer, `#area-rect-${id}`);
  if (areaRect) {
    areaRect.width(areaRect.getAttr('baseWidth') ?? areaRect.width());
    areaRect.height(areaRect.getAttr('baseHeight') ?? areaRect.height());
  }
  const areaLabel = getCachedNode(layer, `#area-label-${id}`);
  if (areaLabel) areaLabel.opacity(1);
}

function resetLinkById(layer, id, isFailing = false) {
  const shaft = getCachedNode(layer, `#link-shaft-${id}`);
  const head = getCachedNode(layer, `#link-head-${id}`);
  const token = getCachedNode(layer, `#link-token-${id}`);
  if (!shaft) return;

  // Undo any scrolling-area translation/clip on the link's wrapping group.
  const wrap = getCachedNode(layer, `#link-wrap-${id}`);
  if (wrap && wrap.getAttr('scrollBaseX') != null) {
    wrap.x(wrap.getAttr('scrollBaseX'));
    wrap.y(wrap.getAttr('scrollBaseY'));
    wrap.opacity(1);
    wrap.setAttr('scrollPreviousX', undefined);
    wrap.setAttr('scrollPreviousY', undefined);
    wrap.setAttr('scrollPreviousTime', undefined);
    wrap.setAttr('manualTokenRestartTime', undefined);
    wrap.setAttr('manualTokenCycleDuration', undefined);
    wrap.setAttr('scrollCycleIndex', undefined);
    wrap.setAttr('scrollFadeStartTime', undefined);
    clearScrollClip(wrap);
  }

  shaft.dashEnabled(false);
  shaft.opacity(1);
  if (head) {
    head.points(head.getAttr('basePoints') ?? head.points());
    head.opacity(head.getAttr('showTip') ? 1 : 0);
  }

  const failMark = getCachedNode(layer, `#link-fail-${id}`);
  if (failMark) failMark.opacity(isFailing ? 1 : 0);
  const failOverlay = getCachedNode(layer, `#link-shaft-fail-overlay-${id}`);
  if (failOverlay) failOverlay.opacity(0);
  if (token) token.opacity(0);
}

export function resetAnimState(layer, nodes, links, mirrorBindings = null) {
  for (const node of nodes) {
    resetNodeById(layer, node.id, !!node.failing);
    for (const mirrorId of mirrorBindings?.nodeIdsBySourceId?.[node.id] ?? []) {
      resetNodeById(layer, mirrorId, !!node.failing);
    }
    if (node.type === 'monitor') {
      const valueNode = getCachedNode(layer, `#monitor-value-${node.id}`);
      if (valueNode) {
        valueNode.text(node.initialValue ?? '');
        valueNode.opacity(1);
        valueNode.fill(node.textColor);
      }
      const nextValueNode = getCachedNode(layer, `#monitor-value-next-${node.id}`);
      if (nextValueNode) {
        nextValueNode.text('');
        nextValueNode.opacity(0);
        nextValueNode.fill(node.textColor);
      }
    }
  }

  for (const link of links) {
    resetLinkById(layer, link.id, !!link.failing);
    for (const mirrorId of mirrorBindings?.linkIdsBySourceId?.[link.id] ?? []) {
      resetLinkById(layer, mirrorId, !!link.failing);
    }
  }

  layer.draw();
}
