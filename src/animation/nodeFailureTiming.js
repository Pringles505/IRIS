export const DEFAULT_NODE_FAILURE_DURATION = 0.8;

// A node can have at most one timed failure. Since a failure persists once it
// happens, only the earliest one ever matters; any extras are dropped.
export function normalizeNodeFailureKeyframes(keyframes = []) {
  if (!Array.isArray(keyframes)) return [];
  return keyframes
    .filter(Boolean)
    .map((keyframe, index) => ({
      ...keyframe,
      id: keyframe.id ?? `node-failure-${index}`,
      startTime: Number.isFinite(keyframe.startTime) ? Math.max(0, keyframe.startTime) : 0,
      duration: Number.isFinite(keyframe.duration) && keyframe.duration > 0
        ? keyframe.duration
        : DEFAULT_NODE_FAILURE_DURATION,
    }))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, 1);
}

// A failure keyframe animates the failure in across its duration (like a node's entry
// block) and the node then stays failed for the rest of the timeline.
export function getNodeFailureOpacity(node, time) {
  if (node?.failing) return 1;

  let opacity = 0;
  for (const keyframe of normalizeNodeFailureKeyframes(node?.failureKeyframes)) {
    if (time < keyframe.startTime) continue;
    const progress = Math.min(1, (time - keyframe.startTime) / keyframe.duration);
    opacity = Math.max(opacity, 1 - Math.pow(1 - progress, 3));
  }
  return opacity;
}
