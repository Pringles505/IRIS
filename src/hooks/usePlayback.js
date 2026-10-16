import { setTimelineCursor } from '../timelineCursor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimationEngine } from '../animation/AnimationEngine';
import { applyAnimState, clearAnimNodeCache, computeLinkRenders, resetAnimState } from '../animation/applyAnimState';
import { computeManualTokenTimingByLinkId } from '../animation/manualTokenTiming';
import { buildMirrorBindings } from '../mirror/mirrorData';
import useStore from '../store/useStore';
import { buildWebByLinkId } from '../variables/flow';

// Where the timeline ends: the user's explicit end, or automatically the furthest of
// the animation, the last slide break and a 4s minimum. Playback always runs to it.
export function computeTimelineEnd({ totalDuration = 0, contentDuration = 0, slideBreaks = [], timelineEnd = null }) {
  if (Number.isFinite(timelineEnd) && timelineEnd > 0) return timelineEnd;
  const maxBreak = slideBreaks?.length ? Math.max(...slideBreaks) : 0;
  return Math.max(totalDuration || 0, contentDuration || 0, maxBreak, 4);
}

export function usePlayback({ layerRef }) {
  const { nodes, links, alignment, slideBreaks, timelineEnd, editorMode } = useStore();
  // Blueprint mode is a still editing view: nothing plays and every element is shown
  // at rest, whatever its keyframes say about the current time.
  const blueprintMode = editorMode === 'blueprint';
  const blueprintModeRef = useRef(blueprintMode);
  blueprintModeRef.current = blueprintMode;

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  // Unwrapped playback time keeps completed node animations at their final state
  // while the area scroll clock repeats from zero.
  const playbackTimeRef = useRef(0);
  const clockStartRef = useRef(0);
  const timeStartRef = useRef(0);
  const rafRef = useRef(null);
  const lastUIUpdateRef = useRef(0);
  // Set once if a frame render throws, so we log the cause without spamming the console.
  const frameErrorLoggedRef = useRef(false);
  // Callers (e.g. KeyframePanel) can set this to receive every animation frame imperatively,
  // bypassing the 30fps React state throttle used for UI updates.
  const frameCallbackRef = useRef(null);
  // Separate slot for DiagramCanvas sub-diagram popup updates — avoids clobbering
  // the KeyframePanel playhead callback which also uses frameCallbackRef.
  const subdiagramFrameCallbackRef = useRef(null);

  const engine = useMemo(() => new AnimationEngine(nodes, links), [nodes, links]);
  const totalDuration   = engine.getTotalDuration();
  const contentDuration = engine.getContentDuration();
  const endTime = computeTimelineEnd({ totalDuration, contentDuration, slideBreaks, timelineEnd });
  const loopPlayback = useMemo(() => nodes.some(node => (
    node.type === 'area' && node.scrollEnabled && node.scrollSeamless !== false
  )), [nodes]);
  // A scrolling area imperatively clips + offsets the nodes inside it. That clip is
  // only undone the next time a frame is applied. Moving/resizing an area or toggling
  // its scroll off changes which nodes it clips but NOT the node count, so the
  // structural-edit reset below won't fire and the paused-frame refresh (keyed on
  // applyFrame) won't either. Without re-applying the frame, a node left clipped by a
  // now-removed area stays pinned inside the stale clip rect and can't be dragged free.
  // This signature changes whenever a scroll area's geometry or enabled-state changes,
  // so the paused frame gets refreshed and clearScrollClip runs for freed nodes.
  const areaScrollSignature = useMemo(() => nodes
    .filter(node => node.type === 'area')
    .map(a => `${a.id}:${a.scrollEnabled ? 1 : 0}:${a.x}:${a.y}:${a.width}:${a.height}`)
    .join('|'), [nodes]);
  // Failure keyframes and the failure look only change shape opacity imperatively, so the
  // paused frame must be re-applied when they change or edits stay invisible until scrubbing.
  const failureSignature = useMemo(() => nodes
    .map(node => (node.failureKeyframes?.length || node.failing
      ? `${node.id}:${JSON.stringify(node.failureKeyframes ?? [])}:${JSON.stringify(node.failureStyle ?? null)}`
      : ''))
    .join('|'), [nodes]);
  const timeline = useMemo(() => engine.getTimeline(), [engine]);
  const linkRenders = useMemo(() => computeLinkRenders(nodes, links), [nodes, links]);
  const mirrorBindings = useMemo(() => buildMirrorBindings(nodes, links), [nodes, links]);
  const webs = useMemo(() => engine.getVariableWebs(), [engine]);
  const webByLinkId = useMemo(() => buildWebByLinkId(webs), [webs]);
  const monitors = useMemo(() => nodes.filter(n => n.type === 'monitor'), [nodes]);
  const allLinkRenders = useMemo(() => ({
    ...linkRenders,
    ...mirrorBindings.linkRenders,
  }), [linkRenders, mirrorBindings.linkRenders]);

  const engineRef = useRef(engine);
  const linkRendersRef = useRef(allLinkRenders);
  const mirrorBindingsRef = useRef(mirrorBindings);
  const totalDurationRef = useRef(totalDuration);
  const endTimeRef = useRef(endTime);
  const contentDurationRef = useRef(contentDuration);
  const loopPlaybackRef = useRef(loopPlayback);

  useEffect(() => { engineRef.current = engine; }, [engine]);
  useEffect(() => { linkRendersRef.current = allLinkRenders; }, [allLinkRenders]);
  useEffect(() => { mirrorBindingsRef.current = mirrorBindings; }, [mirrorBindings]);
  useEffect(() => { totalDurationRef.current = totalDuration; }, [totalDuration]);
  useEffect(() => { endTimeRef.current = endTime; }, [endTime]);
  useEffect(() => { contentDurationRef.current = contentDuration; }, [contentDuration]);
  useEffect(() => { loopPlaybackRef.current = loopPlayback; }, [loopPlayback]);

  const timelineStart = useMemo(() => {
    const tl = engine.getTimeline();
    return tl && tl.length ? Math.min(...tl.map(ev => ev.start)) : 0;
  }, [engine]);

  const websRef = useRef(webs);
  const webByLinkIdRef = useRef(webByLinkId);
  const monitorsRef = useRef(monitors);
  useEffect(() => { websRef.current = webs; }, [webs]);
  useEffect(() => { webByLinkIdRef.current = webByLinkId; }, [webByLinkId]);
  useEffect(() => { monitorsRef.current = monitors; }, [monitors]);

  const bindToTokenHopById = useMemo(() => Object.fromEntries(links.map(l => [l.id, !!l.bindToTokenHop])), [links]);
  const bindMetaById = useMemo(() => Object.fromEntries(links.map(l => [l.id, { offset: Number.isFinite(l.bindHopOffset) ? l.bindHopOffset : 0, scale: Number.isFinite(l.bindHopScale) && l.bindHopScale > 0 ? l.bindHopScale : 1 }])), [links]);
  const linkStartOverrideById = useMemo(() => Object.fromEntries(links.map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animStartTime)) ? l.animStartTime : null])), [links]);
  const linkDurationOverrideById = useMemo(() => Object.fromEntries(links.map(l => [l.id, (l.bindToTokenHop && Number.isFinite(l.animDuration)) ? l.animDuration : null])), [links]);
  const failAtEndsById = useMemo(() => Object.fromEntries(links.map(l => [l.id, !!l.failAtEnds])), [links]);
  const failOnTokenEndById = useMemo(() => Object.fromEntries(links.map(l => [l.id, !!l.failOnTokenEnd])), [links]);
  const failingById = useMemo(() => Object.fromEntries(links.map(l => [l.id, !!l.failing])), [links]);
  const linkFailureById = useMemo(() => Object.fromEntries(links
    .filter(l => l.failureKeyframes?.length)
    .map(l => [l.id, { failureKeyframes: l.failureKeyframes }])), [links]);

  const manualTokenTimingById = useMemo(
    () => computeManualTokenTimingByLinkId(links, timeline),
    [links, timeline]
  );

  const applyFrame = useCallback((t, scrollTime = t) => {
    const layer = layerRef.current;
    if (!layer) return;
    if (blueprintModeRef.current) {
      const { nodes: allNodes, links: allLinks } = useStore.getState();
      resetAnimState(layer, allNodes, allLinks, mirrorBindingsRef.current);
      return;
    }
    // Contain per-frame render errors here so a single bad time `t` can't break
    // the caller: during playback it would otherwise kill the RAF loop, and while
    // scrubbing it would freeze the canvas mid-drag. Log the cause once.
    try {
      const state = engineRef.current.getStateAtTime(t, scrollTime);
      applyAnimState(layer, state, linkRendersRef.current, mirrorBindingsRef.current, {
        webs: websRef.current,
        webByLinkId: webByLinkIdRef.current,
        monitors: monitorsRef.current,
        currentTime: t,
        showGhostNodes: alignment?.showGhostNodes ?? false,
        timelineStart,
        bindToTokenHopById,
        bindMetaById,
        linkStartOverrideById,
        linkDurationOverrideById,
        manualTokenTimingById,
        failAtEndsById,
        failOnTokenEndById,
        failingById,
        linkFailureById,
        isPlaying: isPlayingRef.current,
      });
      layer.draw();
    } catch (err) {
      if (!frameErrorLoggedRef.current) {
        frameErrorLoggedRef.current = true;
        console.error('[usePlayback] frame render error:', err);
      }
    }
  }, [
    bindMetaById,
    bindToTokenHopById,
    layerRef,
    linkDurationOverrideById,
    linkStartOverrideById,
    manualTokenTimingById,
    timelineStart,
    failAtEndsById,
    failOnTokenEndById,
    failingById,
    linkFailureById,
  ]);

  // Latest applyFrame, callable from effects that must NOT re-run on every render
  // (applyFrame changes each render), e.g. the structural-edit reset below.
  const applyFrameRef = useRef(applyFrame);
  useEffect(() => { applyFrameRef.current = applyFrame; }, [applyFrame]);

  // Configuration edits (monitor source/watch, token text keys, styling) do
  // not move the playhead, so explicitly refresh the paused frame.
  useEffect(() => {
    if (isPlayingRef.current) return undefined;
    const frameId = requestAnimationFrame(() => applyFrame(
      playbackTimeRef.current,
      currentTimeRef.current
    ));
    return () => cancelAnimationFrame(frameId);
  }, [applyFrame, areaScrollSignature, failureSignature]);

  // Any edit can mount or unmount canvas shapes; drop cached shape lookups so the
  // animation finds newly mounted ones (cached misses would otherwise stick forever).
  useEffect(() => {
    clearAnimNodeCache(layerRef.current);
  }, [layerRef, nodes, links]);

  const stopLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (isPlayingRef.current || blueprintModeRef.current) return;

    if (!loopPlaybackRef.current && currentTimeRef.current >= endTimeRef.current - 0.05) {
      currentTimeRef.current = 0;
      playbackTimeRef.current = 0;
      setCurrentTime(0);
    }

    clockStartRef.current = performance.now();
    timeStartRef.current = playbackTimeRef.current;
    isPlayingRef.current = true;
    frameErrorLoggedRef.current = false;
    setIsPlaying(true);

    function frame() {
      if (!isPlayingRef.current) return;

      const elapsed = (performance.now() - clockStartRef.current) / 1000;
      const duration = endTimeRef.current;
      const rawTime = timeStartRef.current + elapsed;
      const shouldLoop = loopPlaybackRef.current && duration > 0.0001;
      const displayTime = shouldLoop
        ? ((rawTime % duration) + duration) % duration
        : Math.min(rawTime, duration);
      const animationTime = shouldLoop ? rawTime : displayTime;

      playbackTimeRef.current = animationTime;
      currentTimeRef.current = displayTime;
      // A throw inside any per-frame work must NOT skip the reschedule below —
      // otherwise the RAF loop dies and the playhead freezes ("stuck") for the
      // rest of playback. Contain it here so the timeline keeps advancing, and
      // surface the underlying error once so the root cause stays visible.
      try {
        applyFrame(animationTime, displayTime);
        frameCallbackRef.current?.(displayTime);
        subdiagramFrameCallbackRef.current?.(displayTime);
      } catch (err) {
        if (!frameErrorLoggedRef.current) {
          frameErrorLoggedRef.current = true;
          console.error('[usePlayback] frame render error (playback continues):', err);
        }
      }

      // Throttle React state updates to ~30fps — animation runs imperatively at full 60fps
      const now = performance.now();
      if (now - lastUIUpdateRef.current >= 33) {
        lastUIUpdateRef.current = now;
        setCurrentTime(displayTime);
      }

      if (shouldLoop || displayTime < duration) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        setCurrentTime(displayTime);
        stopLoop();
      }
    }

    rafRef.current = requestAnimationFrame(frame);
  }, [applyFrame, stopLoop]);

  const pause = useCallback(() => {
    stopLoop();
  }, [stopLoop]);

  const stop = useCallback(() => {
    stopLoop();
    currentTimeRef.current = 0;
    playbackTimeRef.current = 0;
    setCurrentTime(0);
    setTimelineCursor(0);
    const layer = layerRef.current;
    if (layer) resetAnimState(layer, nodes, links, mirrorBindingsRef.current);
  }, [layerRef, links, nodes, stopLoop]);

  const seek = useCallback((t, maxTime) => {
    // Manual scrubbing may target the timeline's "breathing room" past the content
    // (to place future keyframes), so callers can pass a larger max than the
    // playback end. Defaults to the timeline end when omitted.
    const upper = Number.isFinite(maxTime) ? Math.max(0, maxTime) : endTimeRef.current;
    const clamped = Math.max(0, Math.min(upper, t));
    currentTimeRef.current = clamped;
    playbackTimeRef.current = clamped;

    if (isPlayingRef.current) {
      clockStartRef.current = performance.now();
      timeStartRef.current = clamped;
    }

    applyFrame(clamped);
    // The playhead/subdiagram callbacks update the DOM directly; a throw here must
    // not abort the scrub (which would leave the playhead stuck mid-drag).
    try {
      frameCallbackRef.current?.(clamped);
      subdiagramFrameCallbackRef.current?.(clamped);
    } catch (err) {
      if (!frameErrorLoggedRef.current) {
        frameErrorLoggedRef.current = true;
        console.error('[usePlayback] seek callback error:', err);
      }
    }

    // Throttle React state updates — callers that need immediate visual feedback
    // (e.g. the timeline playhead) update the DOM directly via refs instead.
    const now = performance.now();
    if (now - lastUIUpdateRef.current >= 33) {
      lastUIUpdateRef.current = now;
      setCurrentTime(clamped);
    }
  }, [applyFrame]);

  const nodesLen = nodes.length;
  const linksLen = links.length;
  useEffect(() => {
    // A node/link was added or removed. Preserve the playhead position — snapping
    // back to 0 on every structural edit throws away the user's place in the
    // timeline. Stop any running loop, clamp the time to the (possibly shorter)
    // new duration, then reset the layer to a clean baseline and re-render the
    // current frame so new/removed items appear in the correct animation state.
    stopLoop();
    const clamped = Math.max(0, Math.min(currentTimeRef.current, endTimeRef.current));
    currentTimeRef.current = clamped;
    playbackTimeRef.current = clamped;
    setCurrentTime(clamped);
    const id = setTimeout(() => {
      const layer = layerRef.current;
      if (!layer) return;
      resetAnimState(layer, nodes, links, mirrorBindingsRef.current);
      applyFrameRef.current(clamped);
    }, 60);
    return () => clearTimeout(id);
  }, [layerRef, linksLen, nodesLen, stopLoop]);

  useEffect(() => () => stopLoop(), [stopLoop]);

  // Entering blueprint mode stops playback and shows every element; leaving it puts the
  // canvas back to the animation frame at the playhead.
  useEffect(() => {
    if (blueprintMode) stopLoop();
    applyFrameRef.current(playbackTimeRef.current, currentTimeRef.current);
  }, [blueprintMode, stopLoop]);

  // Force the React `currentTime` state to match the imperative ref. Scrubbing
  // updates the playhead DOM directly and only throttles state updates, so the
  // state can lag; callers (e.g. on scrub end) use this so a later re-render
  // doesn't snap the playhead back to a stale position.
  const commitTime = useCallback(() => {
    setCurrentTime(currentTimeRef.current);
  }, []);

  return { isPlaying, currentTime, currentTimeRef, totalDuration, contentDuration, endTime, timeline, play, pause, stop, seek, commitTime, frameCallbackRef, subdiagramFrameCallbackRef };
}
