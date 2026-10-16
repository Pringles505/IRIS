const MIN_TOKEN_DURATION = 0.05;
const MANUAL_TOKEN_TRACK_PREFIX = 'manual-token:';

export function getManualTokenTrackId(linkId) {
  return `${MANUAL_TOKEN_TRACK_PREFIX}${linkId}`;
}

export function getManualTokenLinkId(trackId) {
  return typeof trackId === 'string' && trackId.startsWith(MANUAL_TOKEN_TRACK_PREFIX)
    ? trackId.slice(MANUAL_TOKEN_TRACK_PREFIX.length)
    : null;
}

export function normalizeManualTokenTextKeyframes(keyframes = []) {
  return [...(keyframes ?? [])]
    .map((keyframe, index) => ({
      id: keyframe?.id ?? `manual-token-text-${index}`,
      time: Math.max(0, Number.isFinite(keyframe?.time) ? keyframe.time : 0),
      text: keyframe?.text == null ? '' : String(keyframe.text),
    }))
    .sort((a, b) => a.time - b.time);
}

export function getManualTokenBaseText(link, fallback = '') {
  return (link?.manualTokenVariableValue ?? '').trim()
    || (link?.messageLabel ?? '').trim()
    || fallback;
}

export function getManualTokenTextAtTime(source, time, fallback = '') {
  let text = source?.baseText ?? getManualTokenBaseText(source, fallback);
  const keyframes = normalizeManualTokenTextKeyframes(
    source?.textKeyframes ?? source?.manualTokenTextKeyframes
  );
  for (const keyframe of keyframes) {
    if (keyframe.time > time) break;
    text = keyframe.text;
  }
  return text;
}

// Seconds the token text takes to fade out before a text key and back in after it.
export const TOKEN_TEXT_FADE = 0.12;

// Token text plus label opacity at `time`: the old text fades out just before a text
// key and the new text fades in just after it, so changes don't pop.
export function getManualTokenTextFadeAtTime(source, time, fade = TOKEN_TEXT_FADE) {
  const text = getManualTokenTextAtTime(source, time);
  const keyframes = normalizeManualTokenTextKeyframes(
    source?.textKeyframes ?? source?.manualTokenTextKeyframes
  );
  for (const keyframe of keyframes) {
    const delta = time - keyframe.time;
    if (Math.abs(delta) >= fade) continue;
    const before = getManualTokenTextAtTime(source, keyframe.time - 1e-6);
    if (before === keyframe.text) continue;
    const t = Math.min(1, Math.abs(delta) / fade);
    return { text, opacity: t * t * (3 - 2 * t) };
  }
  return { text, opacity: 1 };
}

export function getManualTokenDuration(link, linkEvent) {
  const configured = Number(link?.manualTokenDuration);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(MIN_TOKEN_DURATION, configured);
  }
  return Math.max(MIN_TOKEN_DURATION, linkEvent?.duration ?? MIN_TOKEN_DURATION);
}

// A token can't be triggered by its own travel.
export function isOwnTokenEvent(linkId, eventId) {
  return eventId === `token:${linkId}`;
}

// The resolved start anchor of an event-triggered token, or null when the token follows
// its link (no trigger, or the trigger event couldn't be resolved).
export function getManualTokenTriggerTime(link, linkEvent) {
  if (!link?.manualTokenTriggerEventId) return null;
  return Number.isFinite(linkEvent?.tokenTriggerTime) ? linkEvent.tokenTriggerTime : null;
}

// When a token that follows its link (no trigger of its own) arrives, for a link drawn
// from `start` for `duration`; null when the link has no such token. Whatever comes
// after the link waits for this, so nothing plays while the token is still travelling.
export function getLinkedTokenArrival(link, start, duration) {
  if (!link?.manualTokenEnabled || link.manualTokenTriggerEventId) return null;
  const delay = Number.isFinite(link.manualTokenDelay) ? link.manualTokenDelay : 0;
  const anchor = link.manualTokenAnchor === 'end' ? start + duration : start;
  return anchor + delay + getManualTokenDuration(link, { duration });
}

export function computeManualTokenTimingByLinkId(links = [], timeline = []) {
  const eventById = Object.fromEntries(
    timeline
      .filter(event => event.type === 'link')
      .map(event => [event.id, event])
  );
  const timingById = {};

  for (const link of links) {
    if (!link.manualTokenEnabled) continue;
    const event = eventById[link.id];
    if (!event) continue;

    const anchorAtEnd = link.manualTokenAnchor === 'end';
    const delay = Number.isFinite(link.manualTokenDelay) ? link.manualTokenDelay : 0;
    // A token triggered by an event starts when that event ends, independent of its
    // link's draw. The engine resolves that time onto the link's timeline event.
    const triggerTime = getManualTokenTriggerTime(link, event);
    const anchorTime = triggerTime ?? (anchorAtEnd ? event.start + event.duration : event.start);
    const start = anchorTime + delay;
    const duration = getManualTokenDuration(link, event);
    const invert = !!link.manualTokenInvert;
    const variableName = (link.manualTokenVariableName ?? '').trim()
      || (link.messageLabel ?? '').trim()
      || 'Manual token';
    // No Value/message means the token starts blank — the name is a label for monitors, not text.
    const baseText = getManualTokenBaseText(link, '');
    const textKeyframes = normalizeManualTokenTextKeyframes(link.manualTokenTextKeyframes);
    const originNodeId = invert ? link.toId : link.fromId;
    const destinationNodeId = invert ? link.fromId : link.toId;
    const arrivalAtNode = {};
    if (originNodeId) arrivalAtNode[originNodeId] = start;
    if (destinationNodeId) arrivalAtNode[destinationNodeId] = start + duration;
    const monitorEvents = textKeyframes.length > 0
      ? textKeyframes.map(keyframe => ({
          id: keyframe.id,
          at: keyframe.time,
          value: keyframe.text,
        }))
      : [{
          id: 'destination-arrival',
          at: start + duration,
          value: baseText,
        }];

    timingById[link.id] = {
      start,
      duration,
      triggerEventId: link.manualTokenTriggerEventId ?? null,
      invert,
      sourceNodeId: getManualTokenTrackId(link.id),
      variableName,
      variableValue: baseText,
      displayText: baseText,
      baseText,
      textKeyframes,
      textMaxLength: link.manualTokenMessageOverlap === false ? 24 : 6,
      originNodeId,
      destinationNodeId,
      arrivalAtNode,
      monitorEvents,
    };
  }

  return timingById;
}
