import { useEffect, useRef } from 'react';
import useStore from '../store/useStore';
import { hasTriggeredKeyframes, resolveTriggeredKeyframes } from './triggeredKeyframes';

// Keeps triggered failures at the end of their trigger event whenever the project
// changes. Writes go straight to the store (no undo step) since they only follow
// other edits. If a trigger cycle keeps changing things, it stops after a few rounds
// until the next real edit.
export function useTriggeredKeyframeSync() {
  const nodes = useStore(state => state.nodes);
  const links = useStore(state => state.links);
  const ownWriteRef = useRef(false);
  const roundsRef = useRef(0);

  useEffect(() => {
    if (ownWriteRef.current) {
      ownWriteRef.current = false;
      roundsRef.current += 1;
    } else {
      roundsRef.current = 0;
    }
    if (roundsRef.current > 5 || !hasTriggeredKeyframes(nodes, links)) return;

    let result;
    try {
      result = resolveTriggeredKeyframes(nodes, links);
    } catch (err) {
      console.error('[useTriggeredKeyframeSync] could not resolve triggered keyframes:', err);
      return;
    }
    if (!result.changed) return;
    ownWriteRef.current = true;
    useStore.setState({ nodes: result.nodes, links: result.links });
  }, [nodes, links]);
}
