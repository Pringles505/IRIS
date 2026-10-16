import { getLinkJointProgress } from '../links/linkGeometry';
import { computeVariableWebs } from '../variables/flow';
import { getNodeTextMorphs, getTextMorphRenderState, getStyleMorphRenderState } from '../text/textMorphs';
import { computeManualTokenTimingByLinkId, getLinkedTokenArrival, isOwnTokenEvent, normalizeManualTokenTextKeyframes } from './manualTokenTiming';
import { getNodeFailureOpacity, normalizeNodeFailureKeyframes } from './nodeFailureTiming';
import { computeAreaScrollState } from './scrollGrid';
import { normalizeScrollSteps } from './scrollStepTiming';
import { buildEventsFromTimeline } from '../events/eventsFromTimeline';

const ease = {
  linear: t => t,
  easeOut: t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  spring: t => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function inverseEaseOut(value) {
  const clamped = clamp(value, 0, 1);
  return 1 - Math.pow(1 - clamped, 1 / 3);
}

// Blueprint items (added in blueprint mode) sit outside the timeline: always visible,
// never taking a slot in the auto sequence. Giving one a trigger or a start time puts
// it on the timeline like any other item.
export function isBlueprintItem(item, kind = 'node') {
  if (!item?.blueprint || item.animStartTime != null || item.triggerEventId) return false;
  return kind !== 'node' || !item.triggerAfterLinkId;
}

// A link is "done" for whatever follows it once it has drawn and its token (if it
// follows the link) has arrived.
function getLinkInfo(link, start, duration) {
  const end = start + duration;
  const tokenEnd = getLinkedTokenArrival(link, start, duration);
  return { start, end, duration, releaseEnd: Math.max(end, tokenEnd ?? -Infinity), tokenEnd };
}

// Start of an item triggered by a link: the item may overlap the end of the draw by
// `lead`, but never starts before the link's token has arrived.
function startAfterLink(info, lead, delay) {
  return Math.max(
    info.start,
    info.end - lead + delay,
    info.tokenEnd != null ? info.tokenEnd + delay : -Infinity
  );
}

function getJunctionKey(link) {
  if (link.syncGroupKey) return link.syncGroupKey;
  return link.fromJunctionLinkId && link.fromJunctionJointId
    ? `${link.fromJunctionLinkId}::${link.fromJunctionJointId}`
    : null;
}

function isResolvableTargetNode(node) {
  return !!node && node.type !== 'area' && node.type !== 'mirror' && node.type !== 'text';
}

function getTransformMode(node) {
  if (!node) return 'none';
  if (node.transformMode) return node.transformMode;
  return node.transformTargetNodeId ? 'existing' : 'none';
}

// For a link bound to a token hop, pick which variable's hop drives it: the
// explicitly bound variable when present, otherwise the earliest-starting hop.
// Shared by timeline building and per-frame rendering so they can't drift.
function chooseHopCandidate(link, candidates) {
  if (!candidates?.length) return null;
  if (link.bindVariableId) {
    const match = candidates.find(c => c.web.sourceNodeId === link.bindVariableId);
    if (match) return match;
  }
  return candidates.slice().sort((a, b) => a.timing.start - b.timing.start)[0];
}

function buildExistingTransformStyle(sourceNode, fallbackNode, labelText = sourceNode?.label ?? '') {
  if (!isResolvableTargetNode(sourceNode)) return null;
  return {
    labelText,
    fill: sourceNode.fill ?? fallbackNode?.fill ?? null,
    stroke: sourceNode.stroke ?? fallbackNode?.stroke ?? null,
    textColor: sourceNode.textColor ?? fallbackNode?.textColor ?? null,
    strokeWidth: sourceNode.strokeWidth ?? fallbackNode?.strokeWidth ?? 2,
    shape: sourceNode.shape ?? fallbackNode?.shape ?? null,
    cornerRadius: sourceNode.cornerRadius ?? fallbackNode?.cornerRadius ?? 8,
    showSubBadge: sourceNode.type === 'subdiagram'
      ? (sourceNode.showSubBadge ?? true)
      : false,
  };
}

function buildCustomTransformStyle(node) {
  if (!node?.transformTarget) return null;
  return {
    labelText: node.transformTarget.label ?? '',
    fill: node.transformTarget.fill ?? node.fill ?? null,
    stroke: node.transformTarget.stroke ?? node.stroke ?? null,
    textColor: node.transformTarget.textColor ?? node.textColor ?? null,
    strokeWidth: node.transformTarget.strokeWidth ?? node.strokeWidth ?? 2,
    shape: node.transformTarget.shape ?? node.shape ?? null,
    cornerRadius: node.transformTarget.cornerRadius ?? node.cornerRadius ?? 8,
    showSubBadge: node.transformTarget.showSubBadge
      ?? (node.type === 'subdiagram' ? (node.showSubBadge ?? true) : false),
  };
}

export class AnimationEngine {
  constructor(nodes, links, options = {}) {
    this.nodes = nodes;
    this.links = links;
    // getStateAtTime runs per animation frame; Map lookups keep it O(events)
    // instead of O(events × elements) from repeated Array.find scans.
    this._nodeById = new Map(nodes.map(node => [node.id, node]));
    this._linkById = new Map(links.map(link => [link.id, link]));
    this.opts = {
      initialDelay: options.initialDelay ?? 0.3,
      nodeDuration: options.nodeDuration ?? 0.5,
      nodeGap: options.nodeGap ?? 0.08,
      linkStartPause: options.linkStartPause ?? 0.2,
      linkDuration: options.linkDuration ?? 0.65,
      linkGap: options.linkGap ?? 0.06,
      holdAfter: options.holdAfter ?? 1.2,
      ancestorSubdiagramIds: options.ancestorSubdiagramIds ?? [],
    };

    this._timeline = this._buildTimeline();
  }

  _buildTimeline() {
    const {
      initialDelay,
      nodeDuration,
      nodeGap,
      linkStartPause,
      linkDuration,
      linkGap,
      holdAfter,
      ancestorSubdiagramIds,
    } = this.opts;

    const events = [];
    let t = initialDelay;
    const linkMap = this._linkById;
    const junctionStartCache = new Map();
    const getSubdiagramPopupMetrics = (node, start, duration, triggerLinkInfo = null) => {
      if (
        node?.type !== 'subdiagram' ||
        ancestorSubdiagramIds.includes(node.id) ||
        (node.snapshotNodes?.length ?? 0) === 0
      ) {
        return null;
      }

      const cleanedSnapshot = (node.snapshotNodes ?? []).map(n =>
        n.type === 'subdiagram' ? { ...n, animStartTime: null, animDuration: null } : n
      );
      const nestedEngine = new AnimationEngine(cleanedSnapshot, node.snapshotLinks ?? [], {
        holdAfter: 0,
        ancestorSubdiagramIds: [...ancestorSubdiagramIds, node.id],
      });
      const nestedTimeline = nestedEngine.getTimeline();
      const nestedContentDuration = nestedEngine.getContentDuration();
      const popupDelay = Math.max(0, node.popupDelay ?? 0);
      const popupPlaybackSpeed = Math.max(0.25, node.popupPlaybackSpeed ?? 1);
      const popupHold = Math.max(0, node.popupHold ?? 0);
      const popupEnabled = !!node.showPopupInPlayback;
      const popupStart = popupEnabled
        ? Math.max(
          start + popupDelay,
          triggerLinkInfo ? triggerLinkInfo.start + triggerLinkInfo.duration + popupDelay : -Infinity
        )
        : null;
      const popupEnd = popupEnabled
        ? popupStart + nestedContentDuration / popupPlaybackSpeed + popupHold
        : null;
      const transformMode = getTransformMode(node);
      const transformTargetNode = transformMode === 'existing'
        ? cleanedSnapshot.find(item => item.id === node.transformTargetNodeId) ?? null
        : null;
      const transformTargetTiming = transformTargetNode
        ? nestedTimeline.find(event => event.type === 'node' && event.id === transformTargetNode.id) ?? null
        : null;
      const transformTargetText = transformTargetNode
        ? getTextMorphRenderState(
          transformTargetNode,
          {
            start: transformTargetTiming?.start ?? 0,
            duration: transformTargetTiming?.duration ?? (transformTargetNode.animDuration ?? nodeDuration),
          },
          nestedContentDuration
        )
        : null;
      const transformDuration = Math.max(0.1, node.transformDuration ?? 0.4);
      const minTransformStart = popupEnabled ? popupEnd : start + duration;
      const transformTargetStyle = transformMode === 'custom'
        ? buildCustomTransformStyle(node)
        : buildExistingTransformStyle(
          transformTargetNode,
          node,
          transformTargetText?.baseText ?? transformTargetNode?.label ?? ''
        );
      const transformStart = transformTargetStyle
        ? Math.max(minTransformStart ?? 0, node.transformStartTime ?? (minTransformStart ?? 0))
        : null;
      const transformEnd = transformStart != null ? transformStart + transformDuration : null;
      const blockStart = start + duration;
      return {
        popupStart,
        popupEnd,
        blockStart,
        ownerEnd: start + duration,
        pauseLength: popupEnabled ? Math.max(0, popupEnd - blockStart) : 0,
        transformStart,
        transformEnd,
        transformTargetStyle,
      };
    };

    const getAutoJunctionStart = (link, fallbackStart) => {
      if (!(link.fromJunctionLinkId && link.fromJunctionJointId)) return fallbackStart;

      const cacheKey = `${link.fromJunctionLinkId}::${link.fromJunctionJointId}`;
      if (junctionStartCache.has(cacheKey)) {
        return junctionStartCache.get(cacheKey) ?? fallbackStart;
      }

      const parentInfo = linkInfoMap[link.fromJunctionLinkId];
      if (!parentInfo) {
        junctionStartCache.set(cacheKey, null);
        return fallbackStart;
      }

      const jointProgress = getLinkJointProgress(
        link.fromJunctionLinkId,
        link.fromJunctionJointId,
        this.links,
        this.nodes
      );
      const start = jointProgress == null
        ? parentInfo.start
        : parentInfo.start + parentInfo.duration * inverseEaseOut(jointProgress);

      junctionStartCache.set(cacheKey, start);
      return start;
    };

    const timelineNodes = this.nodes.filter(node => node.type !== 'mirror');
    const freeNodes     = timelineNodes.filter(n => !n.triggerAfterLinkId);
    const triggeredNodes = timelineNodes.filter(n =>  n.triggerAfterLinkId);

    for (const node of freeNodes) {
      if (isBlueprintItem(node, 'node')) {
        const duration = node.animDuration != null ? node.animDuration : nodeDuration;
        events.push({ type: 'node', id: node.id, start: 0, duration, displayDuration: duration, blueprint: true });
        continue;
      }
      // Event-triggered nodes get their real start after the timeline is built
      // (see resolveEventTriggers below), so they don't take a slot in the auto sequence.
      const eventTriggered = !!node.triggerEventId;
      const start    = eventTriggered ? (node.animStartTime ?? 0) : (node.animStartTime != null ? node.animStartTime : t);
      const duration = node.animDuration  != null ? node.animDuration  : nodeDuration;
      events.push({
        type: 'node',
        id: node.id,
        start,
        duration,
        displayDuration: duration,
      });
      if (!eventTriggered) t = Math.max(t, start + duration + nodeGap);
    }

    t += linkStartPause;

    const linkInfoMap = {};
    const processedSimultaneousJunctions = new Set();
    // Precompute variable token timing (binding) using current node-only timeline
    const nodeOnlyTimeline = events.filter(ev => ev.type === 'node');
    const websForBinding = computeVariableWebs(this.nodes, this.links, { timeline: nodeOnlyTimeline });
    const timingByLinkId = new Map();
    for (const web of websForBinding) {
      for (const [lId, timing] of Object.entries(web.tokenTiming)) {
        if (!timingByLinkId.has(lId)) timingByLinkId.set(lId, []);
        timingByLinkId.get(lId).push({ web, timing });
      }
    }

    for (const link of this.links) {
      // A link marked exemptFromSync is always treated as standalone, even if it
      // shares a junction with synced siblings.
      const junctionKey = link.exemptFromSync ? null : getJunctionKey(link);
      if (junctionKey && processedSimultaneousJunctions.has(junctionKey)) {
        continue;
      }

      const sourceJoint = link.fromJunctionLinkId && link.fromJunctionJointId
        ? linkMap.get(link.fromJunctionLinkId)?.joints?.find(joint => joint.id === link.fromJunctionJointId) ?? null
        : null;
      const syncBranches = !!sourceJoint?.syncBranches;

      if (junctionKey && syncBranches) {
        // Exclude any sibling that has opted out of sync.
        const siblingLinks = this.links.filter(item =>
          !item.exemptFromSync && getJunctionKey(item) === junctionKey
        );
        const autoStart = getAutoJunctionStart(link, t);
        const explicitStarts = siblingLinks
          .map(item => item.animStartTime)
          .filter(value => value != null);
        const start = explicitStarts.length
          ? Math.min(...explicitStarts)
          : autoStart;
        let groupEnd = start;
        for (const sibling of siblingLinks) {
          const duration = sibling.animDuration != null ? sibling.animDuration : linkDuration;
          events.push({ type: 'link', id: sibling.id, start, duration });
          linkInfoMap[sibling.id] = getLinkInfo(sibling, start, duration);
          groupEnd = Math.max(groupEnd, linkInfoMap[sibling.id].releaseEnd);
        }
        t = Math.max(t, groupEnd + linkGap);
        processedSimultaneousJunctions.add(junctionKey);
        continue;
      }

      if (isBlueprintItem(link, 'link')) {
        const duration = link.animDuration != null ? link.animDuration : linkDuration;
        events.push({ type: 'link', id: link.id, start: 0, duration, blueprint: true });
        linkInfoMap[link.id] = getLinkInfo(link, 0, duration);
        continue;
      }

      // Exempt links ignore junction timing and animate sequentially like normal links.
      const autoStart = link.exemptFromSync
        ? t
        : getAutoJunctionStart(link, t);
      // Event-triggered links get their real start in _resolveEventTriggers, so they
      // don't take a slot in the auto sequence.
      const eventTriggered = !!link.triggerEventId;
      let start    = eventTriggered
        ? (link.animStartTime ?? 0)
        : (link.animStartTime != null ? link.animStartTime : autoStart);
      let duration = link.animDuration  != null ? link.animDuration  : linkDuration;

      // If binding to token hop is enabled, override start/duration from tokenTiming
      if (link.bindToTokenHop) {
        const chosen = chooseHopCandidate(link, timingByLinkId.get(link.id));
        if (chosen) {
          const offset = Number.isFinite(link.bindHopOffset) ? link.bindHopOffset : 0;
          const scale = Number.isFinite(link.bindHopScale) && link.bindHopScale > 0 ? link.bindHopScale : 1;
          const hopStart = chosen.timing.start + offset;
          start = link.animStartTime != null ? link.animStartTime : hopStart;
          duration = link.animDuration != null
            ? Math.max(0.05, link.animDuration)
            : Math.max(0.05, chosen.timing.duration * scale);
        }
      }
      events.push({ type: 'link', id: link.id, start, duration });
      linkInfoMap[link.id] = getLinkInfo(link, start, duration);
      if (!eventTriggered) t = Math.max(t, linkInfoMap[link.id].releaseEnd + linkGap);
    }

    // Expose hop timing map for bound-link rendering in getStateAtTime
    this._hopTimingByLinkId = timingByLinkId;

    for (const node of triggeredNodes) {
      const info     = linkInfoMap[node.triggerAfterLinkId];
      const duration = node.animDuration != null ? node.animDuration : nodeDuration;
      const lead  = node.triggerMode === 'on-end' ? 0 : duration * 0.7;
      const delay = node.triggerDelay ?? 0;
      const start = info ? startAfterLink(info, lead, delay) : Math.max(0, t - lead + delay);
      events.push({
        type: 'node',
        id: node.id,
        start,
        duration,
        displayDuration: duration,
      });
    }

    const scheduledPauses = [];
    const scheduledLinkInfoMap = {};
    const pendingEvents = events.map((event, index) => ({ ...event, order: index }));
    const scheduledEvents = [];
    const getCandidateStart = (event) => {
      if (event.type !== 'node') return event.start;
      const node = this._nodeById.get(event.id);
      if (!node?.triggerAfterLinkId) return event.start;
      const triggerLinkInfo = scheduledLinkInfoMap[node.triggerAfterLinkId];
      if (!triggerLinkInfo) return null;
      const lead = node.triggerMode === 'on-end' ? 0 : event.duration * 0.7;
      const delay = node.triggerDelay ?? 0;
      return startAfterLink(triggerLinkInfo, lead, delay);
    };

    while (pendingEvents.length) {
      let nextIndex = -1;
      let nextStart = Infinity;
      let nextOrder = Infinity;

      for (let i = 0; i < pendingEvents.length; i += 1) {
        const candidateStart = getCandidateStart(pendingEvents[i]);
        if (candidateStart == null) continue;
        if (candidateStart < nextStart || (Math.abs(candidateStart - nextStart) < 0.0001 && pendingEvents[i].order < nextOrder)) {
          nextIndex = i;
          nextStart = candidateStart;
          nextOrder = pendingEvents[i].order;
        }
      }

      if (nextIndex === -1) {
        pendingEvents.sort((a, b) => a.start - b.start || a.order - b.order);
        nextIndex = 0;
        nextStart = pendingEvents[0].start;
      }

      const event = pendingEvents.splice(nextIndex, 1)[0];
      event.start = nextStart;
      let shiftedStart = event.start;
      for (const pause of event.blueprint ? [] : scheduledPauses) {
        if (pause.ownerId === event.id) continue;
        const shiftedEnd = shiftedStart + event.duration;
        if (shiftedEnd <= pause.ownerEnd) continue;
        if (shiftedStart >= pause.ownerEnd) {
          // Only push forward if still inside the popup window — avoids
          // double-shifting events whose trigger link was already shifted past
          // this pause, and avoids stacking pauseLengths across multiple subnodes.
          if (shiftedStart < pause.popupEnd) {
            shiftedStart = pause.popupEnd;
          }
          continue;
        }
        if (shiftedStart < pause.popupEnd) {
          shiftedStart = pause.popupEnd;
        }
      }

      event.start = shiftedStart;
      scheduledEvents.push(event);

      if (event.type === 'link') {
        scheduledLinkInfoMap[event.id] = getLinkInfo(linkMap.get(event.id), event.start, event.duration);
        continue;
      }

      const node = this._nodeById.get(event.id);
      const triggerLinkInfo = node?.triggerAfterLinkId ? scheduledLinkInfoMap[node.triggerAfterLinkId] : null;
      const popup = getSubdiagramPopupMetrics(node, event.start, event.duration, triggerLinkInfo);
      if (!popup) continue;

      event.displayDuration = Math.max(
        event.duration,
        popup.popupEnd != null ? popup.popupEnd - event.start : 0,
        popup.transformEnd != null ? popup.transformEnd - event.start : 0
      );
      event.popupStart = popup.popupStart;
      event.popupEnd = popup.popupEnd;
      event.transformStart = popup.transformStart;
      event.transformEnd = popup.transformEnd;
      event.transformTargetStyle = popup.transformTargetStyle;
      if (popup.popupStart != null && popup.popupEnd != null) {
        scheduledPauses.push({
          ownerId: event.id,
          popupStart: popup.popupStart,
          popupEnd: popup.popupEnd,
          ownerEnd: popup.ownerEnd,
          pauseLength: popup.pauseLength,
        });
        scheduledPauses.sort((a, b) => a.ownerEnd - b.ownerEnd || a.ownerId.localeCompare(b.ownerId));
      }
    }

    const finalEvents = scheduledEvents
      .sort((a, b) => a.order - b.order)
      .map(({ order, ...event }) => event);

    this._resolveEventTriggers(finalEvents, getSubdiagramPopupMetrics);

    for (const event of finalEvents) {
      if (event.type !== 'node') continue;
      const node = this._nodeById.get(event.id);
      if (!node || node.type === 'subdiagram') continue;

      const transformMode = getTransformMode(node);
      if (transformMode === 'none') continue;

      const candidate = transformMode === 'existing'
        ? this._nodeById.get(node.transformTargetNodeId)
        : null;
      const targetNode = candidate && candidate.id !== node.id && isResolvableTargetNode(candidate)
        ? candidate
        : null;
      const transformTargetStyle = transformMode === 'custom'
        ? buildCustomTransformStyle(node)
        : buildExistingTransformStyle(targetNode, node);
      if (!transformTargetStyle) continue;

      const transformDuration = Math.max(0.1, node.transformDuration ?? 0.4);
      const minTransformStart = event.start + event.duration;
      event.transformStart = Math.max(minTransformStart, node.transformStartTime ?? minTransformStart);
      event.transformEnd = event.transformStart + transformDuration;
      event.transformTargetStyle = transformTargetStyle;
      event.displayDuration = Math.max(
        event.displayDuration ?? event.duration,
        event.transformEnd - event.start
      );
    }

    // Compute simple popup window for non-subdiagram nodes that opt in.
    for (const event of finalEvents) {
      if (event.type !== 'node') continue;
      const node = this._nodeById.get(event.id);
      if (!node) continue;
      if (node.type === 'subdiagram') continue; // subdiagrams use nested popup windows

      const enabled = !!node.showSimplePopupInPlayback;
      if (!enabled) continue;

      const delay = Math.max(0, node.simplePopupDelay ?? 0.2);
      const dur   = Math.max(0.1, node.simplePopupDuration ?? 0.7);

      // If this node is triggered by a link, align popup start to the later of
      // node end + delay and trigger link end + delay (matches subdiagram logic).
      const triggerLinkInfo = node.triggerAfterLinkId
        ? scheduledLinkInfoMap[node.triggerAfterLinkId] ?? null
        : null;
      const candidateA = event.start + event.duration + delay;
      const candidateB = triggerLinkInfo ? (triggerLinkInfo.start + triggerLinkInfo.duration + delay) : -Infinity;
      const popupStart = Math.max(candidateA, candidateB);
      const popupEnd = popupStart + dur;

      event.popupStart = popupStart;
      event.popupEnd = popupEnd;
      event.popupStay = !!node.popupStayOpen;
      event.displayDuration = Math.max(event.displayDuration ?? event.duration, popupEnd - event.start);
    }

    this._contentDuration = 0;
    for (const event of finalEvents) {
      this._contentDuration = Math.max(
        this._contentDuration,
        event.start + (event.displayDuration ?? event.duration)
      );
    }

    // Extend to cover text morph end times, which are not represented as timeline events
    for (const event of finalEvents) {
      if (event.type !== 'node') continue;
      const node = this._nodeById.get(event.id);
      if (!node) continue;
      for (const morph of getNodeTextMorphs(node, { start: event.start, duration: event.duration })) {
        this._contentDuration = Math.max(this._contentDuration, morph.startTime + morph.duration);
      }
    }

    // Graph point keyframes use absolute timeline times in both chain and custom-vector modes.
    for (const node of this.nodes) {
      if (node.type !== 'graph') continue;
      const points = node.graphPoints ?? [];
      const defaultPointDur = 0.35;
      for (const point of points) {
        const start = Number.isFinite(point.startTime) ? point.startTime : 0;
        const duration = Number.isFinite(point.duration) && point.duration > 0
          ? point.duration
          : defaultPointDur;
        this._contentDuration = Math.max(this._contentDuration, start + duration);
      }
      // HKDF domain circles: cover both the appear keyframe and the optional
      // "calculate" keyframe (scattered dots) so playback runs to their end.
      for (const domain of node.graphDomains ?? []) {
        const ds = Number.isFinite(domain.startTime) ? domain.startTime : 0;
        const dd = Number.isFinite(domain.duration) && domain.duration > 0 ? domain.duration : 0.4;
        this._contentDuration = Math.max(this._contentDuration, ds + dd);
        if (domain.calc) {
          const ct = Number.isFinite(domain.calc.time) ? domain.calc.time : 0;
          const cd = Number.isFinite(domain.calc.duration) && domain.calc.duration > 0 ? domain.calc.duration : 1;
          this._contentDuration = Math.max(this._contentDuration, ct + cd);
        }
      }
    }

    for (const item of [...this.nodes, ...this.links]) {
      for (const keyframe of normalizeNodeFailureKeyframes(item.failureKeyframes)) {
        this._contentDuration = Math.max(
          this._contentDuration,
          keyframe.startTime + keyframe.duration
        );
      }
    }

    // Custom area-scroll steps are timeline keyframes too. Without extending the
    // duration here, playback can end after the first step and never reach the
    // remaining rotations.
    for (const node of this.nodes) {
      if (node.type !== 'area' || !node.scrollEnabled || node.scrollMode !== 'stepped') continue;
      for (const step of normalizeScrollSteps(node.scrollSteps)) {
        this._contentDuration = Math.max(this._contentDuration, step.time + step.duration);
      }
    }

    const manualTokenTimingById = computeManualTokenTimingByLinkId(this.links, finalEvents);
    for (const timing of Object.values(manualTokenTimingById)) {
      this._contentDuration = Math.max(this._contentDuration, timing.start + timing.duration);
    }
    for (const link of this.links) {
      for (const keyframe of normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes)) {
        this._contentDuration = Math.max(this._contentDuration, keyframe.time);
      }
    }

    this._totalDuration = Math.max(t, this._contentDuration) + holdAfter;

    return finalEvents;
  }

  // Nodes and links triggered by an event (a morph, failure, token, …) start when that
  // event happens. Events are read from the timeline itself and passes repeat until the
  // whole chain (A triggers B triggers C …) has settled, however long it is. Each pass
  // settles at least one more link of a chain, so a chain can't need more passes than
  // there are triggered items; only a trigger cycle runs into that limit.
  _resolveEventTriggers(timeline, getSubdiagramPopupMetrics) {
    const eventTriggeredLinkIds = new Set(
      this.links.filter(link => link.triggerEventId).map(link => link.id)
    );
    const triggered = [
      ...this.nodes
        .filter(node => node.type !== 'mirror')
        .map(node => {
          if (node.triggerEventId && !node.triggerAfterLinkId) {
            return { kind: 'node', item: node, eventId: node.triggerEventId };
          }
          // A node triggered by a link that itself moved to an event follows that link.
          if (node.triggerAfterLinkId && eventTriggeredLinkIds.has(node.triggerAfterLinkId)) {
            return { kind: 'node', item: node, eventId: `link:${node.triggerAfterLinkId}` };
          }
          return null;
        })
        .filter(Boolean),
      ...this.links
        .filter(link => link.triggerEventId)
        .map(link => ({ kind: 'link', item: link, eventId: link.triggerEventId })),
      // Tokens can be triggered on their own, independent of their link's draw.
      ...this.links
        .filter(link => link.manualTokenEnabled && link.manualTokenTriggerEventId
          && !isOwnTokenEvent(link.id, link.manualTokenTriggerEventId))
        .map(link => ({ kind: 'token', item: link, eventId: link.manualTokenTriggerEventId })),
    ];
    if (!triggered.length) return;
    const timelineEvents = new Map(timeline.map(event => [`${event.type}:${event.id}`, event]));

    const maxPasses = triggered.length + 2;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const webs = computeVariableWebs(this.nodes, this.links, { timeline });
      const events = buildEventsFromTimeline(this.nodes, this.links, timeline, webs);
      const eventById = new Map(events.map(event => [event.id, event]));
      let changed = false;

      for (const { kind, item, eventId } of triggered) {
        const own = timelineEvents.get(`${kind === 'token' ? 'link' : kind}:${item.id}`);
        const trigger = eventById.get(eventId);
        if (!own || !trigger) continue;
        if (kind === 'token') {
          // The token's start anchor (its delay still applies) is read by
          // computeManualTokenTimingByLinkId from the link's timeline event.
          const anchor = Math.max(0, trigger.end);
          if (Number.isFinite(own.tokenTriggerTime) && Math.abs(anchor - own.tokenTriggerTime) < 1e-6) continue;
          own.tokenTriggerTime = anchor;
          changed = true;
          continue;
        }
        // A token's event lasts until it has fully arrived, so items it triggers never
        // start while it is still travelling (no "while drawing" overlap for tokens).
        // Links start when the event ends unless they opt into overlapping it.
        const arrivesAtEnd = trigger.kind === 'token' || trigger.kind === 'variable-token';
        const overlaps = kind === 'node' ? item.triggerMode !== 'on-end' : item.triggerMode === 'overlap';
        const lead = overlaps && !arrivesAtEnd ? own.duration * 0.7 : 0;
        const delay = item.triggerDelay ?? 0;
        // A link's draw isn't over for what it triggers until its token has arrived.
        const linkToken = trigger.kind === 'link' && !this._linkById.get(trigger.ownerId)?.manualTokenTriggerEventId
          ? eventById.get(`token:${trigger.ownerId}`)
          : null;
        const start = Math.max(0, trigger.start, trigger.end - lead + delay, linkToken ? linkToken.end + delay : 0);
        if (Math.abs(start - own.start) < 1e-6) continue;
        own.start = start;
        changed = true;
        // Items later in this pass that this one triggers see its new time right away,
        // so a chain usually settles in a pass or two instead of one step per pass.
        const ownEvent = eventById.get(`${kind}:${item.id}`);
        if (ownEvent) {
          ownEvent.start = start;
          ownEvent.end = start + own.duration;
        }
        if (kind !== 'node') continue;

        own.displayDuration = own.duration;
        const popup = getSubdiagramPopupMetrics(item, start, own.duration, null);
        if (popup) {
          own.popupStart = popup.popupStart;
          own.popupEnd = popup.popupEnd;
          own.displayDuration = Math.max(
            own.duration,
            popup.popupEnd != null ? popup.popupEnd - start : 0
          );
        }
      }
      if (!changed) break;
    }
  }

  getTotalDuration() {
    return this._totalDuration;
  }

  getContentDuration() {
    return this._contentDuration;
  }

  getTimeline() {
    return this._timeline;
  }

  // Variable webs computed against the final timeline, cached so callers
  // (playback, exporters) don't recompute what the engine already derived.
  getVariableWebs() {
    if (!this._variableWebs) {
      this._variableWebs = computeVariableWebs(this.nodes, this.links, { timeline: this._timeline });
    }
    return this._variableWebs;
  }

  getStateAtTime(t, scrollTime = t) {
    const nodeStates = {};
    const linkStates = {};

    for (const event of this._timeline) {
      // Blueprint items are always fully shown.
      const raw = event.blueprint ? 1 : clamp((t - event.start) / event.duration, 0, 1);

      if (event.type === 'node') {
        const node = this._nodeById.get(event.id);
        const isWriteText = node?.type === 'text' && node?.textAnimMode === 'write';
        const duration = Math.max(event.duration, 0.0001);
        // Instant mode: skip the entry fade/scale-in and pop the node in fully the
        // moment its keyframe is reached. Morphs/transforms keep their own timing.
        const entryProgress = node?.disableAnimation ? (t >= event.start ? 1 : 0) : raw;
        const transformProgress = event.transformStart != null && event.transformEnd != null
          ? ease.easeInOut(clamp((t - event.transformStart) / Math.max(0.0001, event.transformEnd - event.transformStart), 0, 1))
          : 0;
        let popupProgress = 0;
        if (event.popupStart != null && t >= event.popupStart) {
          const end = event.popupEnd != null ? event.popupEnd : (event.popupStart + 0.6);
          if (t <= end) {
            popupProgress = (t - event.popupStart) / Math.max(0.0001, end - event.popupStart);
          } else if (event.popupStay) {
            popupProgress = 1; // hold open after the initial slide-in finishes
          } else {
            popupProgress = 0;
          }
        }
        const textState = node ? getTextMorphRenderState(node, { start: event.start, duration: event.duration }, t) : null;
        const styleState = node ? getStyleMorphRenderState(node, { start: event.start, duration: event.duration }, t) : null;
        const entryText = textState?.baseText ?? node?.label ?? '';
        const entryCharCount = Math.max(0, Math.ceil(entryText.length * entryProgress));
        const baseState = {
          opacity: isWriteText ? 1 : ease.easeOut(clamp(entryProgress * 1.6, 0, 1)),
          scale: isWriteText ? 1 : lerp(0.82, 1, ease.easeOut(entryProgress)),
          textMode: isWriteText ? 'write' : 'fade',
          textProgress: entryProgress,
          labelText: isWriteText ? entryText.slice(0, entryCharCount) : entryText,
          labelOpacity: transformProgress > 0
            ? 1 - transformProgress
            : (textState?.baseOpacity ?? 1),
          morphLabelText: transformProgress > 0
            ? (event.transformTargetStyle?.labelText ?? '')
            : (textState?.overlayText ?? ''),
          morphLabelOpacity: transformProgress > 0
            ? transformProgress
            : (textState?.overlayOpacity ?? 0),
          transformProgress,
          popupProgress,
          failureOpacity: getNodeFailureOpacity(node, t),
          targetFill: event.transformTargetStyle?.fill ?? null,
          targetStroke: event.transformTargetStyle?.stroke ?? null,
          targetTextColor: event.transformTargetStyle?.textColor ?? null,
          targetStrokeWidth: event.transformTargetStyle?.strokeWidth ?? null,
          targetShape: event.transformTargetStyle?.shape ?? null,
          targetCornerRadius: event.transformTargetStyle?.cornerRadius ?? null,
          targetShowSubBadge: event.transformTargetStyle?.showSubBadge ?? null,
          // Expose timing so renderer can align graph-local animations
          eventStart: event.start,
          eventDuration: event.duration,
        };

        // Apply morph-driven appearance (color/corner radius) when no explicit transform target
        // is active. If a morph is actively transitioning, blend from committed base to target.
        // If past a morph, hold its style by setting progress to 1.
        if (!event.transformTargetStyle && styleState) {
          const base = styleState.baseStyle;       // style committed by earlier morphs
          const tgt = styleState.hasActive ? styleState.targetStyle : styleState.baseStyle;

          // Alpha morph: blend the node's opacity from the committed value to this
          // morph's target so a morph can fade a node out (disappear) or back in.
          // Applied directly to opacity, independent of the fill/stroke cross-fade.
          const hasAlphaMorph = base.alpha != null || (tgt && tgt.alpha != null);
          if (hasAlphaMorph) {
            const fromAlpha = base.alpha != null ? base.alpha : 1;
            const toAlpha = (tgt && tgt.alpha != null) ? tgt.alpha : 1;
            const alphaP = styleState.hasActive ? ease.easeInOut(styleState.progress) : 1;
            baseState.opacity = baseState.opacity * lerp(fromAlpha, toAlpha, alphaP);
          }

          const hasBaseStyle = !!(base.fill || base.stroke || base.textColor || base.strokeWidth != null || base.cornerRadius != null);
          const hasTarget = !!(tgt && (tgt.fill != null || tgt.stroke != null || tgt.textColor != null || tgt.strokeWidth != null || tgt.cornerRadius != null));
          if (hasTarget || hasBaseStyle) {
            const morphP = styleState.hasActive ? ease.easeInOut(styleState.progress) : (hasBaseStyle ? 1 : 0);
            baseState.transformProgress = Math.max(baseState.transformProgress, morphP);
            // tgt is this morph's fully-resolved form (its values, or the node default
            // for anything it leaves unset). The latest morph defines the latest form.
            baseState.targetFill = tgt.fill ?? null;
            baseState.targetStroke = tgt.stroke ?? null;
            baseState.targetTextColor = tgt.textColor ?? null;
            baseState.targetStrokeWidth = tgt.strokeWidth ?? null;
            baseState.targetCornerRadius = tgt.cornerRadius ?? null;
            // Blend FROM the previously committed form (the prior morph's resolved
            // values), so chained morphs transition form→form smoothly instead of
            // snapping through the node's base color between keyframes.
            baseState.morphFromFill = base.fill ?? null;
            baseState.morphFromStroke = base.stroke ?? null;
            baseState.morphFromTextColor = base.textColor ?? null;
            baseState.morphFromStrokeWidth = base.strokeWidth ?? null;
            baseState.morphFromCornerRadius = base.cornerRadius ?? null;
          }
        }

        nodeStates[event.id] = baseState;
      } else {
        const link = this._linkById.get(event.id);
        // Default link progress from scheduled event
        let progress = ease.easeOut(raw);
        if (event.blueprint) {
          linkStates[event.id] = { progress: 1 };
          continue;
        }
        // Instant mode: skip the draw-in and pop fully drawn at the keyframe.
        if (link && link.disableAnimation) {
          linkStates[event.id] = { progress: t >= event.start ? 1 : 0 };
          continue;
        }
        // If this link is bound to a token hop, override using hop timing
        if (link && link.bindToTokenHop && this._hopTimingByLinkId) {
          const chosen = chooseHopCandidate(link, this._hopTimingByLinkId.get(link.id));
          if (chosen) {
            const offset = Number.isFinite(link.bindHopOffset) ? link.bindHopOffset : 0;
            const scale = Number.isFinite(link.bindHopScale) && link.bindHopScale > 0 ? link.bindHopScale : 1;
            const hopStart = chosen.timing.start + offset;
            const hopDur = link.animDuration != null
              ? Math.max(0.0001, link.animDuration)
              : Math.max(0.0001, chosen.timing.duration * scale);
            const hopRaw = clamp((t - hopStart) / hopDur, 0, 1);
            progress = ease.easeOut(hopRaw);
          }
        }
        linkStates[event.id] = { progress };
      }
    }

    // Scrolling areas continuously translate + wrap the nodes inside them so a
    // static grid reads as endless message generation. Applied after per-node
    // states are built so it layers on top of entry/morph animation.
    let anyScroll = false;
    const loopDuration = this._totalDuration ?? 0;
    for (const area of this.nodes) {
      if (area.type !== 'area' || !area.scrollEnabled) continue;
      const scroll = computeAreaScrollState(area, this.nodes, scrollTime, loopDuration, this.links);
      for (const id in scroll) {
        const state = nodeStates[id];
        if (!state) continue;
        const s = scroll[id];
        anyScroll = true;
        state.scrollDX = (state.scrollDX ?? 0) + s.scrollDX;
        state.scrollDY = (state.scrollDY ?? 0) + s.scrollDY;
        // The area rect is a hard clip window: members are cut at the exact edge.
        state.scrollClip = { x: s.clipX, y: s.clipY, w: s.clipW, h: s.clipH };
        // Deterministic per-band wrap counter; drives node re-entry fade AND the manual
        // token replay (the token fires once each time its tile wraps the viewport edge,
        // re-entering as the freshest message). See applyAnimState.
        state.scrollCycleIndex = s.cycleIndex;
        state.scrollSeamless = s.seamless;
        state.scrollCycleElapsed = s.cycleElapsed;
        // Deterministic seconds-per-wrap for carried manual tokens (snapped onto the
        // link's endpoints in computeAreaScrollState); undefined when not applicable.
        if (s.cyclePeriodSeconds != null) state.scrollCyclePeriod = s.cyclePeriodSeconds;
      }
    }

    // Carry links along with the scrolling nodes they connect. A link translates
    // only when both endpoints share the same scroll phase (same offset); during a
    // wrap mismatch — or when only one endpoint scrolls — it hides so it never
    // rubber-bands across the viewport.
    if (anyScroll) {
      for (const link of this.links) {
        const fromS = nodeStates[link.fromId];
        const toS = nodeStates[link.toId];
        const fromScroll = !!fromS && (fromS.scrollDX != null || fromS.scrollDY != null);
        const toScroll = !!toS && (toS.scrollDX != null || toS.scrollDY != null);
        if (!fromScroll && !toScroll) continue;
        const ls = linkStates[link.id];
        if (!ls) continue;
        // Both endpoints share a band when carried; either one's cycle index marks
        // when the link wraps the viewport edge (drives the re-entry fade + the manual
        // token replay). Carried always so the manual token reset stays in sync.
        ls.scrollCycleIndex = fromS?.scrollCycleIndex ?? toS?.scrollCycleIndex;
        ls.scrollSeamless = fromS?.scrollSeamless ?? toS?.scrollSeamless;
        ls.scrollCycleElapsed = fromS?.scrollCycleElapsed ?? toS?.scrollCycleElapsed;
        // Deterministic seconds-per-wrap, used to size the token's pass so it completes
        // within one wrap gap — including the first wrap (see applyAnimState).
        ls.scrollCyclePeriod = fromS?.scrollCyclePeriod ?? toS?.scrollCyclePeriod;
        if (fromScroll && toScroll) {
          const dxf = fromS.scrollDX ?? 0;
          const dyf = fromS.scrollDY ?? 0;
          const dxt = toS.scrollDX ?? 0;
          const dyt = toS.scrollDY ?? 0;
          if (Math.abs(dxf - dxt) < 0.5 && Math.abs(dyf - dyt) < 0.5) {
            // Same phase: translate with the endpoints and clip to the area edge.
            ls.scrollDX = dxf;
            ls.scrollDY = dyf;
            ls.scrollClip = fromS.scrollClip ?? toS.scrollClip ?? null;
            ls.scrollOpacity = 1;
          } else {
            // Wrap mismatch: one endpoint has looped — hide so it never stretches.
            ls.scrollDX = 0;
            ls.scrollDY = 0;
            ls.scrollOpacity = 0;
          }
        } else {
          // Endpoint straddles the scrolling area boundary — hide rather than stretch.
          ls.scrollDX = 0;
          ls.scrollDY = 0;
          ls.scrollOpacity = 0;
        }
      }
    }

    return { nodeStates, linkStates };
  }

  getBoundingBox() {
    const contentNodes = this.nodes.filter(n => n.type !== 'area' && n.type !== 'mirror');
    const nodes = contentNodes.length ? contentNodes : this.nodes;
    if (!nodes.length) return { x: 0, y: 0, w: 800, h: 600, cx: 400, cy: 300 };
    const minX = Math.min(...nodes.map(node => node.x));
    const minY = Math.min(...nodes.map(node => node.y));
    const maxX = Math.max(...nodes.map(node => node.x + node.width));
    const maxY = Math.max(...nodes.map(node => node.y + node.height));
    return {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };
  }
}
