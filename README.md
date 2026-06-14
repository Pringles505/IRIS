<p align="center">
  <img src="./public/IrisTextLogoWhite.svg" alt="IRIS" width="230" valign="middle" />&nbsp;&nbsp;

</p>

---

## Getting started

```bash
npm install
npm run dev
```

## Conventions

- Properties marked **optional** may be absent on older saved projects and are filled by normalization or renderer fallbacks.
- A value of `null` usually means "automatic", "inherit the default", or "not configured", depending on the property.
- Times and durations are measured in seconds unless stated otherwise.
- Coordinates and dimensions are canvas pixels.
- Colors are CSS/Konva color strings, normally hex or `rgba(...)` values.
- Arrays such as `anchors`, `joints`, `textMorphs`, and `failureKeyframes` are persisted as ordered records.

## Project Document

A saved project is the top-level document containing the diagram and presentation settings.

- `version`: Saved-project schema version. New blank projects currently use version `1`.
- `id`: Unique project identifier.
- `name`: User-visible project name.
- `createdAt`: Timestamp recording when the project was created.
- `updatedAt`: Timestamp refreshed when the project is saved.
- `nodes`: Array containing every node-like diagram component, including areas, mirrors, text, monitors, graphs, variables, and sub-diagrams.
- `links`: Array containing every connection between nodes or junctions.
- `slideBreaks`: Ordered timeline positions used as manual slide/GIF/presentation divisions. An empty array lets export logic derive segments automatically; the final divider also acts as the export end.
- `captureFrame`: Optional presentation/export crop frame.
- `preview`: Optional captured project preview image used by the project picker.
- `nodeCount`: Saved project-list metadata containing the number of nodes.
- `linkCount`: Saved project-list metadata containing the number of links.

### Capture Frame

- `x`: Left edge of the export frame in canvas coordinates.
- `y`: Top edge of the export frame in canvas coordinates.
- `width`: Export-frame width. The default frame is sized for a 1920 x 1080 presentation aspect ratio.
- `height`: Export-frame height.
- `visible`: Whether the frame is shown in the editor.

## Common Node Properties

These properties form the base model for standard nodes and are reused by several specialized node types.

### Identity and Position

- `id`: Unique node identifier used by selections, links, mirrors, monitor watches, and animation references.
- `type`: Component type discriminator, such as `node`, `variable`, `monitor`, `graph`, `mirror`, `text`, `area`, or `subdiagram`.
- `x`: Left position on the canvas.
- `y`: Top position on the canvas.
- `width`: Component width.
- `height`: Component height.

### Appearance

- `shape`: Body geometry name. Standard values are `rectangle`, `rounded`, `pill`, `database`, `cylinder`, `diamond`, `hexagon`, `slanted`, `circle`, and `protocol`.
- `fill`: Body fill color.
- `stroke`: Body outline color.
- `strokeWidth`: Outline thickness.
- `cornerRadius`: Corner radius used by rectangle-based bodies. Pill rendering derives a fully rounded radius from the current dimensions.
- `label`: Main text displayed by the component.
- `fontSize`: Main label font size.
- `textColor`: Main label color.
- `bold`: Whether the main label uses bold text.
- `showSubBadge`: Whether a standard node displays the `SUB` badge. This is mainly used by sub-diagrams and transform targets.

### Text Aura

The text aura improves readability when animated text crosses other content.

- `textAura`: Enables the aura around the node label.
- `textAuraMode`: Aura rendering mode. `cutout` clears content behind the text to the page background; `solid` draws a colored plate.
- `textAuraColor`: Aura or plate color.
- `textAuraOpacity`: Aura opacity from `0` to `1`.
- `textAuraSize`: Feather/blur radius controlling how far the aura extends around the text.

### Entry Animation

- `animStartTime`: Absolute timeline start. `null` lets the animation engine schedule the node automatically.
- `animDuration`: Entry duration. `null` uses the engine default, currently about `0.5` seconds for nodes.
- `disableAnimation`: Makes the node appear fully at its scheduled start instead of animating through its normal entry.
- `triggerAfterLinkId`: Optional link whose progress controls this node's automatic start.
- `triggerMode`: Link trigger mode. `overlap` starts the node near the final 30 percent of the link draw; `on-end` waits for the link to finish.
- `triggerDelay`: Additional delay added after the calculated link trigger time.

### Status and Failure

- `failing`: Applies the always-on failure treatment, including the red failure mark/tint.
- `offline`: Applies the muted, dashed offline treatment and `OFFLINE` tag. Normalization keeps permanent failure and offline states mutually exclusive.
- `failureKeyframes`: Ordered timed failure windows. These are separate from the permanent `failing` flag.

#### Failure Keyframe Record

- `id`: Unique keyframe identifier.
- `startTime`: Absolute timeline time when the failure begins.
- `duration`: Length of the failure window. The default is approximately `0.8` seconds, with a fade near the end.

### Label Animation and Morphs

- `textAnimMode`: Initial label reveal. Supported values are `fade` and `write`.
- `textMorphs`: Ordered list of later text/style changes.

#### Text Morph Record

- `id`: Unique morph identifier.
- `text`: Complete label text for this form.
- `mode`: Transition mode, normally `fade` or `write`.
- `startTime`: Absolute timeline start for the morph.
- `duration`: Morph duration.
- `fill`: Optional body fill for this form. When omitted, the node's base fill is used rather than inheriting the previous morph's fill.
- `stroke`: Optional body outline color for this form.
- `textColor`: Optional label color for this form.
- `strokeWidth`: Optional outline thickness for this form.
- `cornerRadius`: Optional corner radius for this form.
- `alpha`: Optional overall form opacity from `0` to `1`.

Legacy saves may contain `morphText`, `morphMode`, `morphStartDelay`, `morphStartTime`, or `morphDuration`. Normalization converts those fields into `textMorphs` when no modern morph records exist.

### Simple Playback Popup

- `popupValue`: Text shown in the node's simple playback popup.
- `showSimplePopupInPlayback`: Enables the simple popup during playback.
- `simplePopupDelay`: Delay after the node becomes active before the popup appears.
- `simplePopupDuration`: Popup reveal duration.
- `popupStayOpen`: Keeps the popup visible instead of closing it after its normal display window.
- `popupFill`: Optional popup background color. `null` uses the renderer default.
- `popupWidth`: Optional explicit popup width. `null` uses automatic sizing.
- `popupHeight`: Optional explicit popup height. `null` uses automatic sizing.

### Node Transformation

- `transformMode`: Transformation source. `none` disables transformation, `existing` copies a referenced node, and `custom` uses `transformTarget`.
- `transformTargetNodeId`: Node or nested snapshot-node identifier used by `existing` mode.
- `transformStartTime`: Absolute transform start. `null` schedules it after the node's normal appearance; sub-diagrams can additionally wait for their popup sequence.
- `transformDuration`: Time spent morphing to the target appearance.
- `transformTarget`: Custom target appearance record.

#### Transform Target Record

- `label`: Target label.
- `width`: Target width.
- `height`: Target height.
- `fill`: Target fill color.
- `stroke`: Target outline color.
- `textColor`: Target label color.
- `strokeWidth`: Target outline thickness.
- `shape`: Target body shape.
- `cornerRadius`: Target corner radius.
- `showSubBadge`: Target state of the `SUB` badge.

### Token Flow Termination

- `tokenKillFor`: Map keyed by variable-node ID. A truthy entry stops that variable's token traversal after it reaches this node.

### Custom Anchors

- `anchors`: Array of named/custom connection points placed on the node outline.

#### Anchor Record

- `id`: Unique anchor identifier referenced by link endpoints.
- `side`: Outline side containing the anchor: `top`, `right`, `bottom`, or `left`.
- `along`: Signed offset from the center of the selected side. It is horizontal on top/bottom and vertical on left/right.
- `isJunction`: Whether the anchor exposes branch/junction behavior. For compatibility, values other than explicit `false` are treated as enabled.

## Standard Node

Standard nodes use `type: "node"` and all common node properties. A newly created node uses a rounded shape, a `150 x 52` body, a two-pixel outline, and the label `Node`.

- `type`: Always `node` for this component.
- `shape`: Selects one of the standard shape renderers described below.
- `showSubBadge`: Can make an ordinary node visually carry the `SUB` badge, although it does not give it sub-diagram behavior.

## Shape Variants

Changing the shape from the property panel applies the corresponding width, height, and corner-radius preset. Those dimensions remain editable afterward.

### Rectangle

- `shape`: `rectangle`.
- `width`: Preset to `150`.
- `height`: Preset to `52`.
- `cornerRadius`: Preset to `0` for square corners.

### Rounded Rectangle

- `shape`: `rounded`.
- `width`: Preset to `150`.
- `height`: Preset to `52`.
- `cornerRadius`: Preset to `10` by the shape selector; base nodes otherwise default to `8`.

### Pill

- `shape`: `pill`.
- `width`: Preset to `176`.
- `height`: Preset to `54`.
- `cornerRadius`: Stored as `999`, while rendering uses half the smaller current dimension.

### Database

- `shape`: `database`.
- `width`: Preset to `168`.
- `height`: Preset to `64`.
- `cornerRadius`: Preset to `12`.
- Rendering: Draws a cylinder/database body with curved top and bottom edges.

### Cylinder

- `shape`: `cylinder`.
- `width`: Preset to `160`.
- `height`: Preset to `58`.
- `cornerRadius`: Preset to `12`.
- Rendering: Uses the same cylinder-style body family as the database shape.

### Diamond

- `shape`: `diamond`.
- `width`: Preset to `154`.
- `height`: Preset to `86`.
- `cornerRadius`: Not used by the four-point diamond path.

### Hexagon

- `shape`: `hexagon`.
- `width`: Preset to `168`.
- `height`: Preset to `92`.
- `cornerRadius`: Not used by the six-point path.
- Rendering: Side insets are derived from the current width and height.

### Slanted

- `shape`: `slanted`.
- `width`: Preset to `168`.
- `height`: Preset to `58`.
- `cornerRadius`: Not used by the parallelogram path.

### Circle

- `shape`: `circle`.
- `width`: Preset to `96`.
- `height`: Preset to `96`.
- `cornerRadius`: Stored as `999` but not used by the ellipse renderer.
- Rendering: Produces a true circle only when width and height match; unequal dimensions produce an ellipse.

### Protocol

- `shape`: `protocol`.
- `width`: Preset to `152`.
- `height`: Preset to `60`.
- `cornerRadius`: Preset to `10`.
- Rendering: Draws an inset rounded body with two connector pins on each side.

## Text Node

Text nodes use `type: "text"` and inherit common timing, status, morph, and transform properties. Their body is transparent by default.

- `type`: Always `text`.
- `label`: Text content displayed on the canvas.
- `fill`: Transparent by default.
- `stroke`: Transparent by default.
- `strokeWidth`: `0` by default, making the text visually unboxed.
- `cornerRadius`: `0` by default.
- `fontSize`: Defaults to `20` for newly inserted text.
- `equationMode`: Enables equation-aware text rendering/formatting.
- `textPadX`: Horizontal padding used when calculating the automatic text-node width.
- `textPadY`: Vertical padding used when calculating the automatic text-node height.
- `width`: Automatically recalculated from the text and horizontal padding unless an explicit width is supplied by an update.
- `height`: Automatically recalculated from the text and vertical padding unless an explicit height is supplied by an update.

## Variable Node

Variable nodes introduce values into the directed link graph and animate tokens through reachable downstream links.

- `type`: Always `variable`.
- `label`: Display label for the node itself. Defaults to `Variable`.
- `variableLabel`: Logical variable name, such as `count` or `status`.
- `variableValue`: Logical/display value carried through the graph.
- `inputMode`: `visual` displays an animated token; `silent` preserves logical propagation and monitor updates without drawing the token sprite.
- `tokenHopDuration`: Default time for this variable's token to traverse each link.
- `tokenStartOffset`: Delay after the variable node appears before its first hop can begin.
- `tokenText`: Optional token text override. `null` falls back to the variable value/name and then the global token text.
- `tokenShape`: Optional shape override such as `circle`, `square`, or `diamond`. `null` uses the global simulation setting.
- `tokenSize`: Optional token radius/half-size override. `null` uses the global setting.
- `tokenFill`: Optional token fill override.
- `tokenStroke`: Optional token outline override.
- `tokenTextColor`: Optional token-label color override.
- `tokenTextSize`: Optional token-label size override.

### Variable Flow Rules

- Flow follows link direction from `fromId` to `toId` using a breadth-first traversal.
- A variable needs a variable name, value, or token text to produce a meaningful flow.
- A token waits for its variable node, the configured start offset, the relevant link drawing, and the preceding hop.
- Link-level `tokenHopOverrides` for this variable take precedence over the link's generic token timing properties.
- A node's `tokenKillFor` entry can stop the variable from propagating farther downstream.

## Monitor Node

Monitor nodes display a variable or manual-token value during playback. They expose a center linking port but do not themselves participate in normal variable-flow traversal.

- `type`: Always `monitor`.
- `label`: Base monitor label. Defaults to `Monitor`.
- `monitorTitle`: Optional heading shown above the monitored value.
- `showMonitorTag`: Draws the monitor-style border/tag treatment around the current value.
- `variableNodeId`: ID of the variable node or manual-token track being monitored. `null` means no primary source is selected.
- `monitorWatches`: Additional node-specific watch/template rules for a variable web.
- `initialValue`: Value displayed before playback has delivered an update.
- `width`: Defaults to `200`.
- `height`: Defaults to `72`.
- `textMorphs`: Can animate monitor text over time. The monitor editor primarily exposes text, mode, text color, start, and duration, while the common morph model supports the other style fields.

### Monitor Watch Record

- `id`: Unique watch identifier.
- `nodeId`: Downstream node whose token arrival triggers this watch.
- `template`: Display template used when the watched node is reached. `{value}` inserts the variable value and `{name}` inserts the variable name.

### Manual-Token Monitoring

- A monitor may track a manually configured link token instead of a variable node.
- Manual token text keyframes become monitor updates at their configured absolute times.
- When no text keyframes exist, the monitor updates when the manual token reaches its destination.

## Graph Node

Graph nodes render a sampled mathematical curve plus optional points, vectors, coordinate labels, and animated circular domains.

- `type`: Always `graph`.
- `label`: Defaults to `Graph`.
- `formula`: Curve expression. The parser accepts forms beginning with `y =` or `y^2 =`.
- `graphParams`: Comma- or semicolon-separated parameter assignments, for example `a=-1, b=1`.
- `xMin`: Minimum plotted x value.
- `xMax`: Maximum plotted x value.
- `yMin`: Optional minimum y value. `null` enables automatic y-range calculation unless a center override determines it.
- `yMax`: Optional maximum y value.
- `centerX`: Optional horizontal graph center used to derive symmetric x bounds when explicit bounds are not used.
- `centerY`: Optional vertical graph center used to derive symmetric y bounds when explicit bounds are not used.
- `samples`: Number of curve samples. Rendering clamps the effective value to the range `60` through `2000`.
- `showAxes`: Shows or hides graph axes.
- `showCoords`: Shows or hides coordinate labels.
- `graphPoints`: Array of named/styled points in graph coordinates.
- `graphVectors`: Array of arrows connecting graph points.
- `showDomains`: Shows or hides graph domains.
- `graphDomains`: Ordered array of circular domains. Earlier records have higher overlap priority and are drawn on top.
- `vectorSpeed`: Playback time allocated to each chained point/vector step.
- `graphChainPlayback`: When enabled, graph points and vectors reveal as one alternating chain. When disabled, individual point timing properties are used.
- `graphPointSizeDefault`: Default radius for graph points.
- `graphPointFillDefault`: Default point fill color.
- `graphPointStrokeDefault`: Default point outline color.
- `vectorColorDefault`: Default vector color.
- `vectorWidthDefault`: Default vector line width.
- `vectorHeadLengthDefault`: Default arrowhead length.
- `vectorHeadWidthDefault`: Default arrowhead width.

### Formula Behavior

- `^` is treated as exponentiation.
- Common `Math` functions and configured parameters are supported.
- Implicit multiplication is normalized by the expression parser.
- `y^2 = expression` plots positive and negative square-root branches where the right-hand side is nonnegative.
- Invalid expressions are ignored rather than breaking the canvas renderer.

### Graph Point Record

- `id`: Unique point identifier used by vectors.
- `x`: Point x value in graph coordinates.
- `y`: Point y value in graph coordinates.
- `size`: Optional point radius override.
- `fill`: Optional point fill override.
- `stroke`: Optional point outline override.
- `startTime`: Optional absolute point reveal time when chain playback is disabled.
- `duration`: Optional point reveal duration.
- `afterVector`: Reserved/legacy ordering field documented in the model comment but not currently consumed by rendering or scheduling code.

### Graph Vector Record

- `id`: Unique vector identifier.
- `fromId`: Starting graph-point ID.
- `toId`: Ending graph-point ID.
- `color`: Optional line/head color override.
- `width`: Optional line-width override.
- `headLength`: Optional arrowhead-length override.
- `headWidth`: Optional arrowhead-width override.

### Graph Domain Record

- `id`: Unique domain identifier.
- `label`: Text shown for the domain.
- `labelColor`: Optional label color.
- `labelSize`: Optional label font size.
- `cx`: Domain center x value in graph coordinates.
- `cy`: Domain center y value in graph coordinates.
- `r`: Domain radius in graph units.
- `color`: Domain color.
- `startTime`: Optional absolute reveal time.
- `duration`: Optional reveal duration.
- `calc`: Optional calculation-dot animation settings.

#### Domain Calculation Record

- `time`: Absolute start time for calculation dots.
- `duration`: Time over which calculation dots appear.
- `count`: Number of calculation dots.
- `dotColor`: Optional dot-color override.
- `dotSize`: Optional dot-size override.
- `seed`: Deterministic random seed controlling dot placement.

## Mirror Node

Mirror nodes display selected source nodes and links inside a framed, scaled copy.

- `type`: Always `mirror`.
- `label`: Defaults to `Mirror`.
- `sourceNodeIds`: IDs of source nodes included in the mirror.
- `sourceLinkIds`: IDs of source links explicitly included in the mirror. Links whose endpoints are both selected source nodes can also be included automatically.
- `mirrorMode`: `mirror` flips the copied content horizontally; `exact` preserves the original orientation.
- `mirrorNodeOverrides`: Map keyed by source-node ID containing local appearance overrides for mirrored node copies.
- `mirrorLinkOverrides`: Map keyed by source-link ID containing local appearance overrides for mirrored link copies.
- `mirrorScale`: Positive explicit content scale. The mirror otherwise calculates a fit scale from the source bounds and frame.
- `width`: Mirror frame width. It can be adjusted to source bounds, scale, and internal padding.
- `height`: Mirror frame height.
- `fill`: Transparent by default.
- `stroke`: Frame color.
- `strokeWidth`: Frame outline thickness.
- `cornerRadius`: Frame corner radius.

### Mirror Node Override Record

- `label`: Optional replacement label for the mirrored copy.
- `fill`: Optional replacement fill color.
- `stroke`: Optional replacement outline color.
- `textColor`: Optional replacement label color.

### Mirror Link Override Record

- `stroke`: Optional replacement link color for the mirrored copy.

### Derived Mirror Fields

These fields are attached to generated mirror children and are not authored source-component properties.

- `sourceNodeId`: Original node represented by a generated mirror child.
- `sourceLinkId`: Original link represented by a generated mirror child.
- `sourceMirrorId`: Mirror frame that generated the child.

## Area Node

Areas group a rectangular canvas region. They can act as a visible grouping frame or as a clipped scrolling viewport for nodes whose centers lie inside the area.

- `type`: Always `area`.
- `label`: Area caption.
- `width`: Area viewport width. Defaults to `340`.
- `height`: Area viewport height. Defaults to `240`.
- `fill`: Area background color.
- `stroke`: Area border color.
- `strokeWidth`: Border thickness.
- `cornerRadius`: Border corner radius.
- `fontSize`: Area-label size.
- `textColor`: Area-label color.
- `areaInvisible`: Hides the fill, border, and label while retaining the area's clipping/scroll behavior and editor selection controls.
- `areaAnimMode`: Entry mode. `fade` keeps the full geometry and fades opacity; `draw` grows width and height from the top-left and fades the label during the second half.
- `areaOpacity`: Base opacity applied to the visible area fill, border, and label.
- `animStartTime`: Absolute area entry start, or `null` for automatic scheduling.
- `animDuration`: Area entry duration.
- `disableAnimation`: Skips the visual entry transition.

### Area Scrolling

- `scrollEnabled`: Enables clipped movement of member nodes.
- `scrollAxis`: Movement direction: `up`, `down`, `left`, or `right`.
- `scrollSpeed`: Continuous movement speed in pixels per second.
- `scrollGap`: Extra gap added to the continuous wrap period.
- `scrollFade`: Schema/UI flag intended for edge fades. It is currently not read by the scrolling renderer.
- `scrollSeamless`: Snaps motion to complete cycles across the playback/export duration and keeps the wrap seam outside the viewport.
- `scrollStartTime`: Absolute delay before non-keyframed scrolling begins. Keyframed steps use their own absolute times.
- `scrollMode`: `continuous` glides at constant speed; `stepped` advances one tile at a time.
- `scrollStepInterval`: Time between automatic ratchet steps when stepped mode has no explicit keyframes.
- `scrollStepDuration`: Eased movement duration within each automatic step interval.
- `scrollSteps`: Explicit stepped-motion keyframes. When present, they fully control stepped motion.
- `scrollTiles`: Optional minimum number of tiles in a cycle. `0` uses detected bands.
- `scrollTileSize`: Optional forced distance for one tile/step. `0` uses the median detected band pitch.

### Scroll Step Record

- `id`: Unique step identifier.
- `time`: Absolute timeline time at which this step begins.
- `duration`: Time used to ease forward by exactly one tile.

### Area Membership and Clipping

- Membership is determined from the saved layout using each node's center point.
- Other areas and mirrors are excluded from scrolling membership.
- Members are grouped into rows for vertical movement and columns for horizontal movement so multi-node visual tiles move together.
- The area rectangle is a hard clip boundary; scrolling content is not rendered outside it.
- Manual-token link endpoints inside the same scrolling area are synchronized to the token's anchor tile to prevent route and token phase mismatches.

## Sub-diagram Node

Sub-diagrams contain a snapshot of another diagram and can open it interactively or play it in a nested popup.

- `type`: Always `subdiagram`.
- `label`: Main node label. Defaults to `Sub-diagram`.
- `snapshotNodes`: Copied node records belonging to the nested diagram.
- `snapshotLinks`: Copied link records belonging to the nested diagram.
- `sourceProjectId`: Optional ID of the saved project used to populate the snapshots.
- `popupTitle`: Optional title shown in the nested playback popup.
- `showSubBadge`: Shows the `SUB` badge on the node.
- `showPopupInPlayback`: Enables nested-diagram playback in a popup.
- `popupDelay`: Delay before nested popup playback begins.
- `popupPlaybackSpeed`: Speed multiplier applied to the nested timeline.
- `popupHold`: Time the popup remains visible after nested animation finishes.
- `variableLabel`: Present in the sub-diagram schema for compatibility but not currently used by active sub-diagram behavior.
- `showPreviewInPlayback`: Legacy fallback recognized by playback/export code. New edits use `showPopupInPlayback`.

Double-clicking a sub-diagram opens its nested editor view. Transform, status, common entry timing, anchors, popup, and text properties continue to apply to the outer sub-diagram node.

## Link

Links connect node endpoints, anchors, or junctions. Their ordered path consists of a start endpoint, zero or more joints, and an end endpoint.

### Identity and Endpoints

- `id`: Unique link identifier.
- `fromId`: Source node ID. For a branch from a junction, this remains the original parent link's source node while the visible start is resolved from the junction.
- `toId`: Destination node ID.
- `routeStyle`: Optional routing mode. `orthogonal` generates right-angle waypoints when there are no manual joints; absent/default routing uses the direct or manually jointed path.

### Appearance

- `stroke`: Link color.
- `strokeWidth`: Link thickness.
- `showArrowTip`: Shows a directional arrowhead.
- `arrowTipMode`: `flow` moves the tip with the drawing head; `end` fades the tip in at the completed endpoint.
- `messageLabel`: Optional text displayed along the route.

### Link Entry Timing

- `animStartTime`: Absolute link draw start. `null` lets the engine calculate it from connected nodes, triggers, sync groups, or token binding.
- `animDuration`: Draw duration. `null` uses the engine default, currently about `0.65` seconds for links.
- `disableAnimation`: Shows the full link at its scheduled start.
- `autoTriggerTarget`: Allows link completion/progress to schedule the target node automatically.

### Failure and Synchronization

- `failing`: Applies the link's continuous failure treatment.
- `failAtEnds`: Shows failure marks when the animated drawing head reaches the route's start or end.
- `failOnTokenEnd`: Triggers link failure when its token reaches the token destination.
- `syncGroupKey`: Optional group identifier used to start related branch links together.
- `exemptFromSync`: Keeps this link on standalone scheduling even when it would otherwise belong to a junction synchronization group.

### Token-Bound Link Drawing

- `bindToTokenHop`: Uses a variable token hop as the link's automatic draw timing source.
- `bindVariableId`: Optional specific variable-node ID. `null` selects the earliest applicable variable hop.
- `bindHopOffset`: Time offset added to the selected hop start.
- `bindHopScale`: Multiplier applied to the selected hop duration.
- Explicit `animStartTime` or `animDuration` values take priority over the corresponding token-derived value.

### Generic Variable Token Overrides

- `tokenHopDuration`: Optional default traversal duration for tokens on this link. `null` falls back to the variable node's hop duration.
- `tokenHopDelay`: Nonnegative delay before a token traverses this link.
- `tokenHopSkip`: Skips visible/logical traversal of this link for variables unless a variable-specific override changes it.
- `tokenHopOverrides`: Map keyed by variable-node ID containing per-variable traversal settings.

#### Per-variable Hop Override Record

- `skip`: Optional variable-specific skip flag.
- `delay`: Optional variable-specific delay. Unlike the generic delay, variable-specific editing can represent a negative offset.
- `duration`: Optional variable-specific traversal duration.

## Link Endpoint Anchoring

Each endpoint can attach to a node side, center, custom anchor, or joint on another link.

### Side Anchors

- `fromAnchorSide`: Source side: `top`, `right`, `bottom`, `left`, or `center`. `null` lets geometry choose a side.
- `toAnchorSide`: Destination side using the same values.
- `fromAlongPos`: Source offset from the center of the selected side.
- `toAlongPos`: Destination offset from the center of the selected side.
- `fromAnchorLockedCenter`: Prevents automatic packing from moving the source endpoint away from the side center.
- `toAnchorLockedCenter`: Prevents automatic packing from moving the destination endpoint away from the side center.

When multiple links use the same side, unlocked unnamed endpoints are packed along that side with an intended spacing of about 18 pixels. Top/bottom offsets move horizontally; left/right offsets move vertically. A `center` endpoint resolves to the node center.

### Named Custom Anchors

- `fromAnchorId`: ID of a custom anchor in the source node's `anchors` array.
- `toAnchorId`: ID of a custom anchor in the destination node's `anchors` array.
- A named anchor's own `side` and `along` values determine the exact position and prevent normal side packing.

### Link-to-Junction Endpoints

- `fromJunctionLinkId`: Parent link containing the joint used as this link's visible source.
- `fromJunctionJointId`: Joint ID on `fromJunctionLinkId` used as this link's visible source.
- `toJunctionLinkId`: Link containing the joint used as this link's visible destination.
- `toJunctionJointId`: Joint ID on `toJunctionLinkId` used as this link's visible destination.

## Link Joints

Joints are ordered manual waypoints stored in `link.joints`. They reshape a route and can be promoted to junctions.

- `joints`: Ordered joint array. Array order is path order from source to destination.

### Joint Record

- `id`: Unique joint identifier used by editing and junction references.
- `x`: Joint x coordinate. It is stored without the visual lane offset applied to parallel links.
- `y`: Joint y coordinate.
- `size`: Visible joint radius. `0` hides the normal marker while still allowing selected editing UI.
- `prevCurve`: Curvature applied to the segment entering this joint.
- `nextCurve`: Curvature applied to the segment leaving this joint.
- `isJunction`: Promotes the waypoint to a branchable junction.
- `syncBranches`: When true on a junction, sibling branches receive the same synchronization group and automatic start.

### Joint Curvature

- A value near `0` creates a hard pipe/corner.
- A value near `18` creates a soft bend.
- A value near `36` creates a round bend.
- Linked curvature editing changes `prevCurve` and `nextCurve` together.
- Split curvature editing allows the incoming and outgoing sides to differ.
- The `Make 90 degrees` action moves the joint to an orthogonal intersection derived from its neighboring path points.

## Junctions and Branches

A junction is a joint with `isJunction: true`, or a custom node anchor whose `isJunction` behavior is enabled. Junctions expose a branch handle for creating child links.

### Junction Properties

- `isJunction`: Enables branch creation from the joint or anchor.
- `syncBranches`: Joint-only option that starts sibling branches as a synchronized group.
- `syncGroupKey`: Stored on branch links. The default derived key is based on the parent link and joint IDs.
- `exemptFromSync`: Branch-link escape hatch that disables synchronized scheduling for that individual link.

### Junction Timing

- Without explicit timing, a branch starts when the parent link's drawing progress reaches the junction position.
- Parent-link easing and the junction's distance along the route are included in the calculated time.
- With `syncBranches` enabled, sibling links from the same junction receive the same automatic start.
- Explicit `animStartTime` values can still override automatic branch timing.

### Junction Deletion

- Removing a normal joint only removes that waypoint from its route.
- Removing a junction joint also removes descendant child links that branch from that joint, preventing dangling junction references.

## Manual Link Token

A link may carry a standalone token/message without requiring a variable node.

- `manualTokenEnabled`: Enables the standalone link token.
- `manualTokenAnchor`: Scheduling reference. `start` measures the delay from link start; `end` measures it from link completion.
- `manualTokenDelay`: Signed offset from the selected scheduling reference.
- `manualTokenDuration`: Explicit traversal duration. `null` falls back to the link animation duration.
- `manualTokenInvert`: Reverses token motion from target to source.
- `manualTokenVariableName`: Logical name exposed to monitors/templates.
- `manualTokenVariableValue`: Logical value exposed to monitors/templates.
- `manualTokenTextKeyframes`: Absolute-time changes to the token's displayed text.
- `manualTokenMessageOverlap`: When true, text is drawn on the token; when false, it is positioned above the token.
- `manualTokenColor`: Optional token fill override.
- `manualTokenSize`: Optional token size override.
- `manualTokenTextColor`: Optional token-label color override.
- `manualTokenTextSize`: Optional token-label size override.
- Token shape is inherited from the applicable variable/global token style rather than having a separate manual-token shape property.

### Manual Token Text Keyframe

- `id`: Unique keyframe identifier.
- `time`: Absolute timeline time of the text change.
- `text`: Complete token text after the keyframe.

## Global Simulation Options

These settings provide fallback appearance values for variable and manual tokens.

- `tokenShape`: Global token geometry: `circle`, `square`, or `diamond`.
- `tokenSize`: Global token radius/half-size.
- `tokenFill`: Global token fill color.
- `tokenStroke`: Global token outline color.
- `tokenText`: Global fallback token text.
- `tokenTextColor`: Global token-label color.
- `tokenTextSize`: Global token-label size.

Variable-specific settings override these values. Manual-token color, size, and text settings then override the applicable fallback values for that standalone token.

## New Link Defaults

- `nextLinkDefaults`: Copy of the link default model used when the next link is created. Changes here affect future links rather than existing links.
- Every property documented in the Link section can be represented in this defaults object, although the UI primarily exposes commonly reused appearance and behavior fields.

## Editor-only and Derived State

The store also contains interaction state that is not a diagram component property.

- `selectedNodeIds`: IDs of currently selected nodes.
- `selectedLinkIds`: IDs of currently selected links.
- `linking`: In-progress link creation state, including source node, anchor, or junction information.
- `editingJoint`: Joint currently being manipulated.
- `playhead`: Current editor timeline position.
- `isPlaying`: Whether playback is active.
- `zoom`: Canvas zoom factor.
- `pan`: Canvas translation.
- `activeProjectId`: Saved project currently loaded.
- `nestedStack`: Navigation state used when editing inside sub-diagrams.
- `clipboard`: Copied diagram records used by editor paste operations.

## Source-level Application Components

This section maps the React/canvas components to their responsibilities. Their principal data is supplied through the Zustand store and callbacks rather than through a public reusable component API.

### `App`

- `App`: Chooses between the project browser and active diagram editor, initializes project data, and composes the top bar, canvas, timeline, properties, context menu, and nested sub-diagram UI.

### `ProjectsPage`

- `ProjectsPage`: Lists saved projects and handles creation, opening, renaming, preview display, and deletion flows through the project store.

### `TopBar`

- `TopBar`: Provides project navigation, save/export commands, playback controls, capture-frame controls, and editor-wide actions.

### `DiagramCanvas`

- `DiagramCanvas`: Owns the Konva stage/layers, pan/zoom, selection, dragging, linking, joint editing, guides, nested playback overlays, and rendering of every diagram element.

### `PropertiesPanel`

- `PropertiesPanel`: Displays type-specific controls for selected nodes and links and writes normalized updates to the store.

### `ContextMenu`

- `ContextMenu`: Creates all supported node/shape/link types and exposes contextual actions for nodes, links, joints, junctions, anchors, and graph content.

### `KeyframePanel`

- `KeyframePanel`: Displays the timeline and edits starts, durations, failures, morphs, graph events, scrolling steps, token text events, and slide divisions.

### `SubdiagramOverlay`

- `SubdiagramOverlay`: Renders the nested diagram popup during playback and coordinates its scaled timing and hold interval.

### `NodeShape`

- `NodeShape`: Renders standard nodes, text nodes, variable nodes, graph nodes, body shape variants, labels, morph frames, custom anchors, graph content, and node interaction handles.

### `MonitorShape`

- `MonitorShape`: Renders monitor title/value presentation, initial and animated values, monitor tags, and monitor connection behavior.

### `AreaShape`

- `AreaShape`: Renders the area frame, label, invisible mode, and selection affordances used by grouping and scrolling areas.

### `MirrorShape`

- `MirrorShape`: Builds and renders scaled/flipped mirror children and their frame from `mirrorData` results.

### `SubdiagramShape`

- `SubdiagramShape`: Renders the outer sub-diagram node, badge, status, anchors, label, and popup-related visual hooks.

### `LinkShape`

- `LinkShape`: Resolves endpoint geometry, joints, curves, orthogonal paths, parallel lanes, arrows, labels, tokens, junction handles, route editing, and link animation state.

### `NodeStatusMark`

- `NodeStatusMark`: Draws node failure/offline indicators from permanent state and timed failure windows.

### `LinkFailureMark`

- `LinkFailureMark`: Draws link failure marks at configured route positions and token/end events.

### `GhostOverlay`

- `GhostOverlay`: Draws temporary drag/linking previews and alignment feedback without modifying persisted diagram records.

## Supporting Modules

These are not visible components, but they define important property behavior.

- `store/useStore.js`: Authoritative defaults, normalization, mutations, selection, linking, joints, junctions, graph edits, mirrors, sub-diagrams, and editor state.
- `animation/AnimationEngine.js`: Calculates automatic starts, durations, trigger overlap, link synchronization, token-bound timing, and animation states.
- `animation/applyAnimState.js`: Applies calculated state to Konva nodes, including area draw/fade behavior and scrolling transforms.
- `animation/scrollGrid.js`: Calculates area membership, tile pitch, continuous/stepped offsets, wrapping, clipping, and scroll-carried token timing.
- `animation/scrollStepTiming.js`: Normalizes explicit area steps and computes fractional tile progress.
- `animation/manualTokenTiming.js`: Calculates manual-token scheduling and traversal state.
- `animation/nodeFailureTiming.js`: Evaluates permanent and keyframed failure state.
- `links/linkGeometry.js`: Resolves node boundaries, sides, named anchors, junction endpoints, joints, curves, lane offsets, and path measurements.
- `variables/flow.js`: Builds directed variable webs, token hop schedules, monitor events, and kill/skip behavior.
- `mirror/mirrorData.js`: Selects mirror source content and generates scaled, flipped, overridden child records.
- `text/textMorphs.js`: Normalizes morph records and resolves the active text/style form.
- `text/equationText.js`: Converts equation text into renderable label segments.
- `projects/projectStore.js`: Creates, loads, saves, lists, renames, and deletes persisted project documents.
- `export/VideoExporter.js`, `GifPackageExporter.js`, `Mp4PackageExporter.js`, `pptx.js`: Render the same model and timing properties into export formats.
