// Project events: everything in a project that has a creation ("start") and a
// destruction / completion ("end") time, plus how those events connect (which event
// triggers which, and which events belong to another). See eventsFromTimeline.js.
import { AnimationEngine } from '../animation/AnimationEngine';
import { buildEventEdges, buildEventsFromTimeline } from './eventsFromTimeline';

export { EVENT_EDGE_KINDS, EVENT_KINDS, buildEventEdges, buildEventsFromTimeline } from './eventsFromTimeline';

export function buildProjectEvents(nodes = [], links = []) {
  const engine = new AnimationEngine(nodes, links);
  return buildEventsFromTimeline(nodes, links, engine.getTimeline() ?? [], engine.getVariableWebs() ?? []);
}

// Events plus the connections between them: { events, edges }.
export function buildEventGraph(nodes = [], links = []) {
  const events = buildProjectEvents(nodes, links);
  return { events, edges: buildEventEdges(nodes, links, events) };
}
