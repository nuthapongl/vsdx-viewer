# VSDX Viewer & Editor

Browser-only viewer and editor for Microsoft Visio `.vsdx` files. Nothing is uploaded; the file is read with the File API and saved back to your disk.

```
VSDX file → ZIP reader → VSDX parser → internal diagram model → SVG renderer → viewer
```

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # parser unit tests (vitest + jsdom)
npm run sample   # regenerate public/sample.vsdx (synthetic file used by "Load sample" and the tests)
npm run build
```

## Running it locally

```bash
./run.sh          # installs what is missing, starts the dev server and opens the browser
./run.sh build    # production build, served at http://localhost:4173
./run.sh check    # type-check, lint and tests
```

On macOS you can also double-click `run.command` in Finder. Needs Node.js 20 or newer; everything stays on your machine (the file you open is read in the browser and never uploaded). Stop with Ctrl+C.

## Layout

| Path | Role |
| --- | --- |
| `src/model/` | **Internal diagram model** (`types.ts`) and generic matrix/placement math. The renderer only depends on this. |
| `src/visio/` | Everything Visio-specific: `package.ts` (ZIP/OPC + relationships), `parseDocument.ts` (pages, masters, styles), `parsePage.ts`, `parseShape.ts`, `geometry.ts` (geometry rows → path commands), `sheet.ts` (shape → master → style-sheet cell inheritance), `formula.ts`, `coordinateTransform.ts`, `loadVsdx.ts` (entry point). |
| `src/edit/` | **Editing.** `session.ts` (`EditSession`: open, undo/redo, live drags, save), `xmlEdit.ts` (the actual patches to the Visio XML), `interaction.ts` (resize/rotate maths), `saveFile.ts`. |
| `src/render/` | Pure helpers for the renderer (text wrapping, bounds). |
| `src/components/` | React UI: `FileDropzone`, `PageSelector`, `ViewerToolbar`, `VisioViewer` (pan/zoom), `DiagramRenderer` (SVG). |

Model conventions: px (96 per inch), origin top-left, Y down, rotation in degrees clockwise. Groups are flattened in paint order with `parentId`; each shape keeps an unrotated frame (`x, y, width, height`) plus `rotation`/`flipX`, and its outline as path commands in its own local frame.

## Supported so far

Pages (incl. background pages), masters (inherited geometry, formulas of the form `Width*k`), style sheets, groups, rotation and flips, rich text (Shift+Enter line breaks (U+2028), tabs, blank lines at the end, per-run font name, size, colour, bold/italic/underline, paragraph alignment, wrapping; font names may be a FaceName index, a literal name or "Themed", with complex-script/Asian fonts as fallbacks), line/fill colour, weight, dash patterns, transparency, arrow heads on open paths (sized from `BeginArrowSize`/`EndArrowSize` and the line weight), rounded corners, glued connectors (`Connects`), PNG/JPEG/GIF/SVG images and BMP images (decoded here, with their alpha channel and premultiplied colour, and re-encoded as PNG because browsers ignore BMP transparency). Pictures are drawn at their own offset/size and cropped to the shape's frame (`ImgOffsetX/Y`, `ImgWidth/Height`), and the geometry rows MoveTo, LineTo, ArcTo, EllipticalArcTo, Ellipse, Bezier rows and PolylineTo.

### Visio themes

Files made with a theme (the "Ion" cross-functional flowcharts, for instance) store `Themed` instead of a colour. The parser reads `visio/theme/theme1.xml` (`src/visio/theme.ts`) and rebuilds the look: the shape's base colour (its `FillBkgnd`, or the variation colour its QuickStyle code names) goes through the theme's fill style (a top-to-bottom gradient or a solid), its line style (a darker outline) and its effect style (a drop shadow); text on a themed shape is white on dark fills and the line colour on connector labels; a connector's label has its white background. Angles are always radians in the XML, whatever the cell's `U` says (swimlane headers are rotated that way). This is an approximation of Visio's rules, tuned on the Salesforce release-process sample.

## Known gaps

NURBS/spline rows are drawn as straight segments; gradient and hatch fills render as a solid foreground colour; theme colours only work when the file stores the resolved colour; paragraph indents/spacing, super/subscript and small caps are ignored; fonts the browser doesn't have fall back to a similar family (Carlito, which matches Calibri's metrics, is bundled); EMF/WMF images show a placeholder; ShapeSheet formulas beyond `Width`/`Height` arithmetic fall back to scaling the master's cached values.

## Viewer and editor modes

Every file opens in **Viewer** mode: you can pan (drag), zoom, click a shape to pick it, run the analysis, export PNGs and save, but a press or drag never changes the diagram - there are no handles, ports or inspector, double-click does not edit text and Delete / arrows / undo do nothing. Press **Editor** to turn editing on (the canvas gets an orange outline and the drawing, undo and ordering tools appear); press **Viewer** to switch it off again. Opening another file always returns to Viewer.

## Editing and saving

In Editor mode: select (click; click a group once to select it, again to drill into a child), move (drag or arrow keys, Shift = 10 px), resize and rotate (handles; Shift snaps rotation to 15°), edit text in place (double-click the shape, its text, or a line), fill / line colour and weight (inspector), delete, bring to front / send to back, add rectangle / ellipse / text box, undo / redo (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z), save (Ctrl/Cmd+S).

**Saving never regenerates the file.** Each edit patches the original XML of the shape that was touched, and only the page parts that changed are re-serialised; every other part of the package (masters, styles, images, theme...) is carried over byte for byte. Details that matter for Visio:

- A cell that is overwritten loses its formula (`F`), otherwise Visio would recalculate it and undo the edit on open. On resize, formulas that depend on `Width`/`Height` are re-evaluated and their cached values updated.
- Text edits only touch the characters that changed, so runs with different fonts/sizes/colours keep their formatting.
- Deleting a shape also removes its glue records and any formula that referenced it by `Sheet.N!`.

### Editing a line (plain polylines too)

A line is selected as a line, not as a box: its path is highlighted, its bends are marked and a round handle sits on each end (head and tail) - no frame, no resize or rotate handles. This holds for plain polylines (the lines of most diagrams, which have no glue) as well as for connectors. Drag a handle to move that end; the neighbouring piece stretches so square pieces stay square. A **magnet** pulls the end onto the middle of a side (a port, within 14 screen px) or onto the nearest point of a shape's outline (within 8 screen px), including a zone's border; the target shape's ports light up and a green ring marks the spot. Dragging the ends of a connector, or drawing a new one, uses the same magnet and attaches to the shape it snaps onto. **Reshaping the body:** a small square marks each bend and a bar sits in the middle of each piece between bends. Drag a **piece** to slide it across itself (the pieces on either side stretch; it lines up with the pieces beyond when it passes them); drag a **bend** to move it (the neighbouring bends that are joined to it by square pieces follow, so those pieces stay square; the line snaps to the x / y of its other bends within 6 screen px); drag the middle of a **straight** two-point line to add a bend. Doubled points in a file (a bend twice within 1.5 px) count as one bend. The pieces that touch an end have no bar: use the end handle. One undo step per drag (`src/edit/lineEdit.ts`). A connector that follows shapes is re-routed by its style when a shape moves, which replaces a hand-made shape. Not done: removing a bend by dragging it onto a neighbour (a bend that ends up in a straight run disappears by itself).

### Connectors (like Figma / draw.io)

- **Ports.** Point at a shape and four dots appear in the middle of its sides. Drag from a dot (or, with the connector tool, from anywhere on the shape) to another shape: a connector is created, glued to both shapes, and a dashed preview of its route follows the pointer. Drop on a dot to choose the side, on a shape to let the best side be chosen, or on empty space to leave the end free.
- **Auto-routing.** Elbow connectors leave a port in the direction of its side, avoid the other shapes, and use as few bends as they can (an A* search over the lines through the endpoints and the edges of nearby shapes, with a penalty per bend). Frames that only mark an area - no fill, text or picture, such as zone outlines - are not obstacles, so connectors run inside them.
- **Re-routing.** When a shape a connector is glued to moves or is resized, the connector is routed again from the same sides instead of being stretched. Connectors drawn as plain polylines (no glue in the file) keep the stretch behaviour described below.
- **Editing.** Select a connector to get a handle on each end: drag one onto another shape or port to re-attach it, or onto empty space to detach it. The inspector switches a connector between *Elbow* and *Straight* and turns its start/end arrow on or off.
- **In the file.** A connector is a Visio 1-D shape written the way Visio writes its own (Pin/Width/Angle are formulas of the end points) with `Connect` records for the glue. Its path style and sides are kept as plain numbers in user-defined cells (`vsdxStyle`, `vsdxBeginSide`, `vsdxEndSide`), which Visio ignores. The end points are stored as plain values rather than Visio's glue formulas, so in Visio the connector is recorded as glued but is not re-routed by Visio itself when a shape moves there; this has not been checked in Visio.

### Moving connectors

A 1-D connector can be dragged (or nudged with the arrow keys) on its own. Both end points and the pin move together, the length and angle stay, and - exactly as Visio does when you drag a connector off its shapes - it is detached: its `Connect` glue records are removed and the glue formulas on its end points become plain values, so Visio can't pull it back when the file is opened. Undo restores the glue, formulas and records included. Text can be added to or edited on a connector like on any shape (double-click it); the label sits at the middle of the line.

### Diagram analysis: "if this IP goes down, what is affected?"

Press **Analyze**. The app reads the diagram as a graph (`src/analysis/`), then you search an IP, host name or node name (or click a node) and it shows, on the diagram and in the side panel, what its failure would hit - in two separate directions, because an arrow A → B means "A calls B":

- **Depends on it**: everything that can reach the node by following arrows (a DB down hurts the apps that call it), nearest first, with the chain that explains it on hover.
- **Cut off**: what was reachable from the diagram's entry points (the nodes nothing points to) and no longer is once the node is gone (backends behind a failed balancer).

How the graph is read:

- **Nodes** are tiles - a group, or a shape with text - whose label is parsed for host names, IPv4 addresses and ports (`w2dbspho1c2los 172.20.22.111 :1433, 1434`). Several IPs in one tile are several interfaces of one machine. **Addresses on a line that says `VIP` are ignored** (they are virtual and shared). Zone outlines (no fill, text or picture), legends and ports written beside a line (`:443`) are not nodes; a small label lying on a tile (`HA (Active - Active)`) and an icon standing right next to a node belong to that node.
- **Edges** come from the lines. Where a line end sits on one node's border (or is glued to it) the connection is certain; an arrow gives the direction (no arrow = unknown, both ways, and the results that rely on it are marked *direction unspecified*). A line that starts on another line (a branch off a shared trunk) calls what the trunk's sending end is attached to.
- **Lines that end on a zone's border, or on nothing, are not guessed.** They are listed under *Connections to confirm* with the zone's nodes, nearest first; you tick the node(s) each end really joins. The answer is saved in the file as plain numbers in user-defined cells (`vsdxLinkBegin1..`, `vsdxLinkEnd1..`), which Visio ignores. On the diagram the lines that explain a result are drawn as animated dashes that march from the caller to the callee, with an arrowhead (animation is off under `prefers-reduced-motion`). When an end lies on a zone's border the zone's name (the title text near its corner, e.g. `LOS DC1`) is shown with a **Whole zone** checkbox that ticks every node inside it at once. Until confirmed they do not count; "Might also be affected" shows what they could add if every candidate were right.

Not done yet: treating redundancy (DC1/DC2 pairs, Active-Active/Standby) as *degraded* instead of *down* and pointing out single points of failure.

### Exporting a PNG

**⬚ Export area** lets you drag a box over any part of the page; the bar above the canvas shows the picture's size, a scale (1-4×), **Whole page** and **Export PNG**. **PNG** (next to Delete) puts the box around the selected shape (with a small margin) so you can adjust it or export at once. Esc closes the tool. The picture is the diagram itself - not the selection handles - drawn from a copy of the page's SVG (`src/render/exportPng.ts`) with the pictures and the Carlito font embedded, so it looks as on screen on a white background. While an analysis result is on show its marks (washed-out rest, coloured nodes, dashed lines) are part of the picture. Very large areas are scaled down (longest side 8192 px) and the status line says so.

### High-availability groups

Nodes that stand in for one another (the application servers of two data centres, primary and secondary database...) can be put in a group, under **High-availability groups** in the analysis panel: accept the suggestions (nodes with the same name once numbers, addresses and notes in brackets are ignored) or tick nodes by hand. The group number is saved on each node as a plain number in a user-defined row (`vsdxHaGroup`), which Visio ignores. With groups the result has three levels: **Down** (a caller whose every connected member of some group it calls has fallen - repeated until nothing more falls), **Degraded** (the failed node's surviving stand-ins, and callers that lost one of several servers: still working, no spare left; amber on the diagram) and **Cut off** (unchanged). A caller wired to only one member of a group still falls when that member does: the app trusts the lines, not the names. **Several failures at once:** under the result, "+ Also down" adds another node or a whole zone (a data centre) to the failed set, and Shift-click on the diagram adds or removes a node; the result is for all of them together (a group is lost only when every member is down). **Single points of failure** lists each node's failure on its own, worst first (nodes taken down / cut off / degraded, and whether it is an entry point); stand-ins and second routes take a node off the list, so grouping the stand-ins shortens it. Not done yet: Active-Standby versus Active-Active (a standby counts as able to take over).

### Tidy lines

In Editor mode, **Tidy lines** proposes a tidier route for the lines of the page (`src/edit/tidy.ts`) and shows it before anything changes: the present route dashed grey, the proposal in green, with a summary ("10 of 28 lines change - crowded length 3444 → 231 px"). **Apply** writes it as one undo step; **Cancel** (or Esc) leaves the file alone. The scope is the whole page or the selected line. What it does: lines that run side by side (or on top of one another) are laid out together on an even 7.5 px grid, in the order they already have; nearly horizontal / vertical pieces are made exact and tiny jogs and points on a straight run are removed; a line whose two ends are known nodes (and that has no glue) is routed again like a new connector, but only when that is clearly better (fewer bends or shorter, no detour, no new crossings). Ends attached to a node stay where they are; ends on a zone's border may slide along it; nothing is moved into a shape. A second run finds nothing more to change. It cannot remove crossings that the layout forces (lines that swap sides), and the lines in files drawn as shared trunks only get spaced, not re-drawn.

### Network monitor (simulated)

**Monitor** (in Viewer or Editor) lays a simulated network over the diagram, in the spirit of yFiles' network-monitoring demo: requests enter at the entry points (nodes nothing calls) and follow the arrows; every line that carries traffic gets green dashes running the way the requests go, and every node a status light. **Click a node** to switch it off (or back on); a drag still pans. The rest follows from the analysis (`src/analysis/simulate.ts`): callers with no stand-in left go **down** (red, dashed), nodes no entry point can reach are **cut off** (greyed), stand-ins and callers that lost one of their servers are **degraded** (amber), and the lines that went quiet are drawn grey and dotted. The side panel counts each state, lists the nodes in it (click to go there) and switches nodes back on. It uses the high-availability groups and confirmed lines made in Analyze; lines still to be confirmed are not simulated. There is no live data yet: no loads, no history.

### Moving a box moves what is inside it

Dragging (or nudging) a box also carries what is inside it, in the same undo step: the shapes and groups next to it whose centre is inside the box and of which at least 40% lies inside (a label's frame is usually a little larger than its text, so requiring the whole frame inside would miss it), and the lines that lie completely inside. A connector between two carried shapes keeps its glue; a line that leaves the box follows only the end that is inside. This applies to moving only: resizing or rotating a box leaves its contents where they are. A shape that mostly sticks out of the box, or sits inside a different group, is not carried, and a group is never torn apart.

### Lines follow their shapes

When a shape is moved, resized or rotated, the lines that touch it follow, in the same undo step. An end is attached if the file glues it to the shape (`Connects`), or - since many files draw their lines as plain polylines with no glue - if it lies on the shape's border (within 5 px). Moving a group takes the lines attached to anything inside it. Attached ends keep their relative position on the shape, so they stay on the border when it is resized and turn with it when it is rotated.

- Orthogonal polylines stay orthogonal: the segment next to the moving end shifts with it and the following one stretches. A straight two-point line simply tilts, as a straight connector does in Visio.
- 1-D connectors keep their glue and formulas (`PinX=(BeginX+EndX)/2`, `Width=SQRT(...)`, `Angle=ATAN2(...)`); only the end points and cached values change. Plain polylines get a fresh bounding box and rewritten geometry rows.
- This is stretching, not Visio's routing engine: it does not find a new path around obstacles, and a line whose shape moves far past the other end can fold over itself.

### Not done yet

- Connectors can be moved but not resized or rotated. Lines with curves are not re-routed when a shape moves (they can still be moved, restyled, labelled and deleted), and there is no way yet to drag a segment of an elbow connector or add waypoints.
- Groups can be moved, rotated and restyled but not resized. Single selection only; no copy/paste or duplicate.
- Text formatting (font, size, bold...) can't be changed yet, only the characters.
- Shapes that come from a master but whose group children the file doesn't list can only be edited as a whole.
- The result has been checked by re-opening it with this app's own parser, not in Visio itself.
