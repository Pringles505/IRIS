import { AnimationEngine } from '../animation/AnimationEngine';
import { computeManualTokenTimingByLinkId } from '../animation/manualTokenTiming';
import { normalizeScrollSteps } from '../animation/scrollStepTiming';
import { getNodeTextMorphs } from '../text/textMorphs';

const MIN_BREAK_GAP = 0.08;
const MIN_CLIP_SECONDS = 0.12;

function r2(value) {
  return Math.round(value * 100) / 100;
}

function uniqueSortedTimes(times, maxTime, startTime = 0) {
  const firstTime = r2(Math.max(0, Math.min(startTime, maxTime)));
  const sorted = times
    .filter(t => Number.isFinite(t) && t >= firstTime - MIN_BREAK_GAP && t < maxTime - MIN_BREAK_GAP)
    .map(t => Math.max(0, r2(t)))
    .sort((a, b) => a - b);

  const result = [firstTime];
  for (const time of sorted) {
    const normalized = Math.abs(time - firstTime) < MIN_BREAK_GAP ? firstTime : time;
    if (normalized - result[result.length - 1] >= MIN_BREAK_GAP) {
      result.push(normalized);
    }
  }
  if (maxTime - result[result.length - 1] < MIN_BREAK_GAP) {
    result[result.length - 1] = r2(maxTime);
  } else {
    result.push(r2(maxTime));
  }
  return result;
}

function describeTimelineEvent(event, nodeById, linkById) {
  if (event.type === 'node') {
    const node = nodeById[event.id];
    return node?.label || node?.type || 'Node';
  }
  const link = linkById[event.id];
  if (!link) return 'Link';
  const from = nodeById[link.fromId]?.label || '?';
  const to = nodeById[link.toId]?.label || '?';
  return `${from} -> ${to}`;
}

export function collectPresentationSegments(nodes, links, options = {}) {
  const { slideBreaks = [] } = options;
  const engine = new AnimationEngine(nodes, links);
  const timeline = engine.getTimeline();
  const contentDuration = Math.max(engine.getContentDuration(), MIN_CLIP_SECONDS);
  const nodeById = Object.fromEntries(nodes.map(node => [node.id, node]));
  const linkById = Object.fromEntries(links.map(link => [link.id, link]));
  const eventByNodeId = Object.fromEntries(
    timeline.filter(event => event.type === 'node').map(event => [event.id, event])
  );
  const times = [];

  for (const event of timeline) {
    times.push(event.start);
  }

  for (const timing of Object.values(computeManualTokenTimingByLinkId(links, timeline))) {
    times.push(timing.start, timing.start + timing.duration);
  }

  for (const node of nodes) {
    const event = eventByNodeId[node.id];
    if (event) {
      for (const morph of getNodeTextMorphs(node, { start: event.start, duration: event.duration })) {
        times.push(morph.startTime);
      }
    }
    if (node.transformMode && node.transformMode !== 'none' && Number.isFinite(node.transformStartTime)) {
      times.push(node.transformStartTime);
    }
    if (node.type === 'graph' && !node.graphChainPlayback) {
      for (const point of node.graphPoints ?? []) {
        if (Number.isFinite(point.startTime)) times.push(point.startTime);
      }
    }
    if (node.type === 'area' && node.scrollEnabled && node.scrollMode === 'stepped') {
      for (const step of normalizeScrollSteps(node.scrollSteps)) {
        times.push(step.time);
      }
    }
  }

  // Manual slide breaks are authoritative segment boundaries. The last break is
  // the final export end; content after it is intentionally excluded.
  let breaks;
  let manualBreakMode = false;
  const cleanedManual = Array.isArray(slideBreaks)
    ? [...new Set(slideBreaks
        .map(v => (Number.isFinite(v) ? Math.max(0, r2(v)) : null))
        .filter(v => v != null && v >= MIN_BREAK_GAP)
      )].sort((a, b) => a - b)
    : [];

  if (cleanedManual.length) {
    manualBreakMode = true;
    breaks = [0, ...cleanedManual];
  } else {
    const finiteTimes = times.filter(Number.isFinite);
    const firstKeyframe = finiteTimes.length ? Math.min(...finiteTimes) : 0;
    breaks = uniqueSortedTimes(times, contentDuration, firstKeyframe);
  }
  return breaks.slice(0, -1).map((start, index) => {
    const end = manualBreakMode
      ? breaks[index + 1]
      : Math.max(start + MIN_CLIP_SECONDS, breaks[index + 1]);
    const eventsAtStart = timeline.filter(event => Math.abs(event.start - start) < MIN_BREAK_GAP);
    const firstEvent = eventsAtStart[0];
    const eventLabel = firstEvent ? describeTimelineEvent(firstEvent, nodeById, linkById) : 'Opening frame';
    const safeEnd = manualBreakMode ? end : Math.min(end, contentDuration);
    return {
      index,
      start,
      end: safeEnd,
      durationSec: Math.max(0, safeEnd - start),
      title: `Slide ${index + 1}: ${eventLabel}`,
      eventCount: eventsAtStart.length,
    };
  }).filter(segment => segment.end - segment.start >= 1 / 60);
}
