// A distinct color per event kind, shared by the Events list, the Event Cascade and
// the Trigger picker, so each kind of event is recognisable at a glance.
export const EVENT_KIND_COLOR = {
  node: '#3B82F6',            // blue
  link: '#22D3EE',            // cyan
  token: '#E879F9',           // fuchsia (matches tokens in the timeline)
  'token-text': '#F9A8D4',    // light pink
  'variable-token': '#A78BFA', // violet
  morph: '#FACC15',           // yellow
  transform: '#FB923C',       // orange
  popup: '#2DD4BF',           // teal
  failure: '#EF4444',         // red
  'scroll-step': '#94A3B8',   // slate
  'graph-point': '#34D399',   // green
  'graph-domain': '#A3E635',  // lime
  'graph-calc': '#D6D3D1',    // stone
};
