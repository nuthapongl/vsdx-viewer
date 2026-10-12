import { describe, expect, it } from "vitest";
import type { DiagramShape } from "../model/types";
import { buildTopology } from "./graph";
import { readGroups, suggestGroups } from "./groups";
import { analyzeImpact, findNodes, rankFailures } from "./impact";
import { extractCandidates, parseLabel } from "./nodes";
import type { Edge } from "./graph";
import type { AnalysisNode } from "./nodes";

// ---- helpers to draw small diagrams -------------------------------------------------------

const base = { rotation: 0, flipX: false, geometry: [] as DiagramShape["geometry"] };
const style = { strokeWidth: 1 };

/** A tile with a label, as a rectangle with fill. */
function tile(id: string, x: number, y: number, text: string, w = 120, h = 60, extra: Partial<DiagramShape> = {}): DiagramShape {
  return {
    ...base,
    id,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    text,
    textRuns: [{ text, fontSize: 10, fontFamily: "x", color: "#000", bold: false, italic: false, underline: false, align: "center" }],
    style: { ...style, fill: "#fff", stroke: "#000" },
    ...extra,
  };
}

/** A zone: an outline with no fill and no text. */
const zone = (id: string, x: number, y: number, w: number, h: number): DiagramShape => ({
  ...base,
  id,
  type: "rectangle",
  x,
  y,
  width: w,
  height: h,
  style: { ...style, stroke: "#f00" },
});

/** An open polyline through page points; `arrow` says where the head is. */
function line(
  id: string,
  pts: { x: number; y: number }[],
  arrow: "end" | "begin" | "both" | "none" = "end",
  extra: Partial<DiagramShape> = {},
): DiagramShape {
  return {
    ...base,
    id,
    type: "unknown",
    x: 0,
    y: 0,
    width: 2000,
    height: 2000,
    style: {
      ...style,
      stroke: "#000",
      ...(arrow === "end" || arrow === "both" ? { endArrow: 5 } : {}),
      ...(arrow === "begin" || arrow === "both" ? { beginArrow: 5 } : {}),
    },
    geometry: [
      { fill: false, stroke: true, commands: pts.map((p, i) => ({ op: i === 0 ? "M" : "L", x: p.x, y: p.y }) as const) },
    ],
    ...extra,
  };
}

const P = (x: number, y: number) => ({ x, y });

// ---- labels ------------------------------------------------------------------------------

describe("parseLabel", () => {
  it("reads the title, address, host name and ports", () => {
    const l = parseLabel("DB2 Server (Primary)\n w2dbspho1c2los 172.20.22.111\n :1433, 1434");
    expect(l.title).toBe("DB2 Server (Primary)");
    expect(l.ips).toEqual(["172.20.22.111"]);
    expect(l.hostnames).toEqual(["w2dbspho1c2los"]);
    expect(l.ports.sort()).toEqual(["1433", "1434"]);
  });

  it("several addresses are several interfaces of one machine", () => {
    const l = parseLabel("Active Directory\nw2dompho101.lhb.net 172.20.0.1 \nw2dompho102.lhb.net 172.20.0.2 \nLDAP: 389");
    expect(l.ips).toEqual(["172.20.0.1", "172.20.0.2"]);
    expect(l.hostnames).toContain("w2dompho101.lhb.net");
    expect(l.ports).toContain("389");
  });

  it("names a node by the first line that says something, not by a port or an address", () => {
    expect(parseLabel(":443 (VIP)\nw2apspho101los 172.20.23.99\nHA (Active - Standby)").title).toBe("w2apspho101los 172.20.23.99");
    expect(parseLabel(":443\n172.20.0.1\nw2apspho101los").title).toBe("w2apspho101los");
    expect(parseLabel("172.20.0.1").title).toBe("172.20.0.1");
  });

  it("ignores addresses on a VIP line", () => {
    const l = parseLabel("Instinct\nw2waspho301frd 172.20.23.117 (VIP)\nw2waspho3c1frd 172.20.23.161\n:80, 443");
    expect(l.ips).toEqual(["172.20.23.161"]);
    expect(parseLabel("Floating IP\nw2dbspho1v1los 172.20.22.109 (VIP DB)\nSQL Listener").ips).toEqual([]);
  });

  it("does not read names or addresses out of a URL", () => {
    const l = parseLabel("Web Back Office\nhttps://w2apspho101los.lhb.net/ACNWEB/UCP/Web/LogonOther.aspx?x=10.1.1.1");
    expect(l.hostnames).toEqual([]);
    expect(l.ips).toEqual([]);
    expect(l.title).toBe("Web Back Office");
    // ...but an ordinary name next to a URL still counts
    expect(parseLabel("App\nw2apspho1c1los 10.0.0.9\nhttp://example.com/x").hostnames).toEqual(["w2apspho1c1los"]);
  });

  it("rejects things that only look like addresses", () => {
    expect(parseLabel("Switch\n300.1.1.1 and 10.0.0.256").ips).toEqual([]);
  });
});

// ---- nodes --------------------------------------------------------------------------------

describe("extractCandidates", () => {
  it("keeps tiles, treats outlines as zones, and records which zone a tile lies in", () => {
    const shapes = [zone("z", 0, 0, 500, 300), tile("a", 50, 50, "App\n10.0.0.1"), tile("b", 700, 50, "Far\n10.0.0.2")];
    const { nodes, zones } = extractCandidates(shapes);
    expect(zones.map((z) => z.id)).toEqual(["z"]);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(nodes[0].zones).toEqual(["z"]);
    expect(nodes[1].zones).toEqual([]);
  });

  it("names a zone by the plain title near one of its corners", () => {
    const shapes = [
      zone("z1", 0, 0, 500, 300),
      tile("t1", 8, 6, "LOS DC1", 70, 20, { style: { ...style } }), // top left
      zone("z2", 0, 400, 500, 300),
      tile("t2", 8, 670, "Internal Server-DC1", 130, 20, { style: { ...style } }), // bottom left
      tile("a", 150, 100, "App\n10.0.0.1"),
      tile("port", 250, 150, ":443", 30, 14, { style: { ...style } }), // a note, not a name
    ];
    const { zoneNames } = extractCandidates(shapes);
    expect(zoneNames.get("z1")).toBe("LOS DC1");
    expect(zoneNames.get("z2")).toBe("Internal Server-DC1");
  });

  it("does not take a caption lying inside a tile for the zone's name", () => {
    const shapes = [
      zone("z", 0, 0, 500, 300),
      tile("sms", 300, 200, "SMS Gateway\n10.0.0.7", 190, 90), // a tile reaching the zone's bottom right corner
      tile("cap", 430, 270, "Send SMS", 50, 14, { style: { ...style } }), // its caption, inside the tile, nearest a corner
      tile("title", 8, 276, "Internal Server-DC1", 130, 18, { style: { ...style } }),
    ];
    expect(extractCandidates(shapes).zoneNames.get("z")).toBe("Internal Server-DC1");
  });

  it("leaves a zone unnamed when no title sits near a corner", () => {
    const shapes = [zone("z", 0, 0, 800, 600), tile("mid", 380, 290, "Centre label", 80, 20, { style: { ...style } })];
    expect(extractCandidates(shapes).zoneNames.has("z")).toBe(false);
  });

  it("reads a tile that is a group from the text of its parts", () => {
    const group: DiagramShape = { ...tile("g", 50, 50, "", 200, 80), type: "group", text: undefined, textRuns: undefined, style: { ...style } };
    const label = tile("g1", 55, 55, "Core Banking\nLHBPRD 172.20.5.3", 150, 40, { parentId: "g" });
    const caption = tile("g2", 60, 100, "Silverlake", 60, 15, { parentId: "g" });
    const { nodes } = extractCandidates([group, label, caption]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "g", title: "Core Banking", ips: ["172.20.5.3"] });
  });

  it("does not take a bare note beside a line (':443') for a machine, but keeps boxed tiles without an address", () => {
    // a text box with a (rectangular) outline that is not drawn: no fill, no line
    const note = tile("note", 500, 100, ":443", 40, 14, { style: { ...style } });
    const boxed = tile("box", 700, 100, "Click Next\nService Provider");
    const { nodes } = extractCandidates([note, boxed]);
    expect(nodes.map((n) => n.id)).toEqual(["box"]);
  });

  it("still merges an unnamed text box that lies on a tile into that tile", () => {
    const host = tile("host", 0, 0, "w2apspho101los 172.20.23.99", 200, 60);
    const label: DiagramShape = { ...tile("lbl", 20, 30, "HA (Active - Standby)", 80, 20), type: "text", style: { ...style } };
    const { nodes, labels } = extractCandidates([host, label]);
    expect(nodes.map((n) => n.id)).toEqual(["host"]);
    expect(labels.get("lbl")).toBe("host");
    expect(nodes[0].text).toContain("HA (Active - Standby)");
  });

  it("an icon standing right beside a node belongs to it, so a line ending on the icon ends on the node", () => {
    const text = tile("t", 100, 100, "w2apspho101los 172.20.23.99", 180, 30, { style: { ...style } }); // text only: no fill, no line
    const icon: DiagramShape = { ...tile("icon", 295, 98, "", 30, 30), text: undefined, textRuns: undefined, image: { format: "png", x: 0, y: 0, width: 30, height: 30 }, style: { ...style } };
    const far: DiagramShape = { ...icon, id: "far", x: 900, y: 900 };
    const { nodes, labels } = extractCandidates([text, icon, far]);
    expect(labels.get("icon")).toBe("t");
    expect(labels.has("far")).toBe(false);
    expect(nodes.map((n) => n.id)).toEqual(["t"]);
  });

  it("ignores lines and shapes of other pages", () => {
    const shapes = [tile("bg2:1", 0, 0, "Title 10.9.9.9"), line("l", [P(0, 0), P(10, 10)])];
    expect(extractCandidates(shapes).nodes).toEqual([]);
  });
});

// ---- topology -----------------------------------------------------------------------------

describe("buildTopology", () => {
  const a = tile("a", 0, 100, "App\n10.0.0.1");
  const b = tile("b", 400, 100, "DB\n10.0.0.2");

  it("an arrow from a to b is a call from a to b", () => {
    const t = buildTopology([a, b, line("l", [P(120, 130), P(400, 130)], "end")]);
    expect(t.edges).toEqual([expect.objectContaining({ a: "a", b: "b", kind: "forward", lineId: "l" })]);
    expect(t.lines[0].resolved).toBe(true);
  });

  it("an arrow at the begin end reverses the call", () => {
    const t = buildTopology([a, b, line("l", [P(120, 130), P(400, 130)], "begin")]);
    expect(t.edges).toEqual([expect.objectContaining({ a: "b", b: "a", kind: "forward" })]);
  });

  it("two arrows, or none, say so", () => {
    expect(buildTopology([a, b, line("l", [P(120, 130), P(400, 130)], "both")]).edges[0].kind).toBe("both");
    expect(buildTopology([a, b, line("l", [P(120, 130), P(400, 130)], "none")]).edges[0].kind).toBe("none");
  });

  it("follows an elbow line from end to end", () => {
    const t = buildTopology([a, b, line("l", [P(60, 160), P(60, 260), P(460, 260), P(460, 160)], "end")]);
    expect(t.edges).toEqual([expect.objectContaining({ a: "a", b: "b" })]);
  });

  it("a line that ends on a node's icon connects to the node", () => {
    const text = tile("t", 500, 100, "w2apspho101los 172.20.23.99", 180, 30, { style: { ...style } });
    const icon: DiagramShape = { ...tile("icon", 685, 98, "", 30, 30), text: undefined, textRuns: undefined, image: { format: "png", x: 0, y: 0, width: 30, height: 30 }, style: { ...style } };
    const t = buildTopology([a, text, icon, line("l", [P(120, 130), P(700, 130)], "end")]);
    expect(t.edges).toEqual([expect.objectContaining({ a: "a", b: "t" })]);
  });

  it("an end on a zone frame is unresolved and offers the zone's tiles, nearest first", () => {
    const z = zone("z", -20, 0, 300, 400);
    const near = tile("n", 20, 300, "Near\n10.0.1.1", 100, 40);
    const far = tile("f", 20, 20, "Far\n10.0.1.2", 100, 40);
    const t = buildTopology([z, near, far, b, line("l", [P(100, 400), P(100, 440), P(400, 440), P(400, 160)], "end")]);
    const l = t.lines[0];
    expect(l.resolved).toBe(false);
    expect(l.begin.kind).toBe("zone");
    expect(l.begin.candidates).toEqual(["n", "f"]);
    expect(t.edges).toEqual([]);
    expect(t.possibleEdges.map((e) => `${e.a}>${e.b}`)).toEqual(["n>b", "f>b"]);
    expect(t.possibleEdges.every((e) => e.pending)).toBe(true);
  });

  it("does not offer a zone's title label as a candidate", () => {
    const z = zone("z", -20, 0, 300, 400);
    const title = tile("t", -10, 5, "LOS DC1", 70, 20); // names no machine, connects to nothing
    const node = tile("n", 20, 300, "Near\n10.0.1.1", 100, 40);
    const t = buildTopology([z, title, node, b, line("l", [P(100, 400), P(100, 440), P(400, 440), P(400, 160)], "end")]);
    expect(t.lines[0].begin.candidates).toEqual(["n"]);
    expect(t.nodes.has("t")).toBe(false);
  });

  it("what the user confirmed settles it", () => {
    const z = zone("z", -20, 0, 300, 400);
    const near = tile("n", 20, 300, "Near\n10.0.1.1", 100, 40);
    const far = tile("f", 20, 20, "Far\n10.0.1.2", 100, 40);
    const unresolved = line("l", [P(100, 400), P(100, 440), P(400, 440), P(400, 160)], "end", { links: { begin: ["f"] } });
    const t = buildTopology([z, near, far, b, unresolved]);
    expect(t.lines[0].begin).toMatchObject({ kind: "node", source: "confirmed", nodeIds: ["f"] });
    expect(t.edges).toEqual([expect.objectContaining({ a: "f", b: "b" })]);
  });

  it("a confirmed end may be several nodes", () => {
    const t = buildTopology([
      zone("z", -20, 0, 300, 400),
      tile("n", 20, 300, "Near\n10.0.1.1", 100, 40),
      tile("f", 20, 20, "Far\n10.0.1.2", 100, 40),
      b,
      line("l", [P(100, 400), P(100, 440), P(400, 440), P(400, 160)], "end", { links: { begin: ["n", "f"] } }),
    ]);
    expect(t.edges.map((e) => `${e.a}>${e.b}`).sort()).toEqual(["f>b", "n>b"]);
  });

  it("uses the file's glue, also when it points at a part of a tile", () => {
    const group: DiagramShape = { ...tile("g", 0, 100, "", 120, 60), type: "group", text: undefined, textRuns: undefined, style: { ...style } };
    const inner = tile("g1", 5, 105, "Glued\n10.0.2.1", 100, 40, { parentId: "g" });
    const conn = line("c", [P(500, 500), P(600, 500)], "end", {
      type: "connector",
      connector: { begin: { point: P(500, 500), shapeId: "g1" }, end: { point: P(600, 500), shapeId: "b" } },
    });
    const t = buildTopology([group, inner, b, conn]);
    expect(t.edges).toEqual([expect.objectContaining({ a: "g", b: "b" })]);
    expect(t.lines[0].begin.source).toBe("glue");
  });

  it("an end that touches nothing is left alone, as is a line wholly inside a tile", () => {
    const t = buildTopology([a, b, line("l", [P(120, 130), P(300, 130)], "end")]);
    expect(t.lines[0].end.kind).toBe("none");
    expect(t.edges).toEqual([]);

    const group: DiagramShape = { ...tile("g", 0, 400, "", 200, 100), type: "group", text: undefined, textRuns: undefined, style: { ...style } };
    const label = tile("g1", 5, 405, "Tile\n10.0.3.1", 150, 40, { parentId: "g" });
    const decoration = line("d", [P(10, 480), P(190, 480)], "none", { parentId: "g" });
    expect(buildTopology([group, label, decoration]).lines).toEqual([]);
  });

  it("drops a label that names no machine and has nothing connected", () => {
    const t = buildTopology([a, b, tile("legend", 900, 900, "Load Balancer", 100, 20), line("l", [P(120, 130), P(400, 130)])]);
    expect([...t.nodes.keys()].sort()).toEqual(["a", "b"]);
  });

  it("keeps a node without an address when something is connected to it", () => {
    const x = tile("x", 800, 100, "Click Next\nService Provider", 120, 60);
    const t = buildTopology([a, x, line("l", [P(120, 130), P(800, 130)])]);
    expect(t.nodes.has("x")).toBe(true);
  });
});

// ---- impact -------------------------------------------------------------------------------

const node = (id: string, extra: Partial<AnalysisNode> = {}): AnalysisNode => ({
  id,
  title: id,
  hostnames: [],
  ips: [],
  ports: [],
  text: id,
  zones: [],
  ...extra,
});
const nodesOf = (...ids: string[]) => new Map(ids.map((i) => [i, node(i)]));
const fwd = (a: string, b: string): Edge => ({ lineId: `${a}${b}`, a, b, kind: "forward" });
const ids = (items?: { nodeId: string }[]) => items?.map((i) => i.nodeId);

describe("analyzeImpact", () => {
  const chain = [fwd("A", "B"), fwd("B", "C")];

  it("a node going down hurts whoever depends on it, nearest first", () => {
    const r = analyzeImpact(nodesOf("A", "B", "C"), chain, "C");
    expect(ids(r.dependents)).toEqual(["B", "A"]);
    expect(r.dependents.map((d) => d.hops)).toEqual([1, 2]);
    expect(r.dependents[1].path).toEqual(["C", "B", "A"]);
  });

  it("and cuts off what can only be reached through it", () => {
    const r = analyzeImpact(nodesOf("A", "B", "C"), chain, "B");
    expect(ids(r.dependents)).toEqual(["A"]);
    expect(ids(r.unreachable)).toEqual(["C"]);
    expect(r.roots).toEqual(["A"]);
  });

  it("the end of a chain cuts off nothing, and the entry point depends on nobody", () => {
    expect(analyzeImpact(nodesOf("A", "B", "C"), chain, "C").unreachable).toEqual([]);
    const top = analyzeImpact(nodesOf("A", "B", "C"), chain, "A");
    expect(top.dependents).toEqual([]);
    expect(ids(top.unreachable)).toEqual(["B", "C"]);
  });

  it("a second route keeps a node reachable", () => {
    const diamond = [fwd("A", "B"), fwd("B", "D"), fwd("A", "C"), fwd("C", "D")];
    const r = analyzeImpact(nodesOf("A", "B", "C", "D"), diamond, "B");
    expect(ids(r.dependents)).toEqual(["A"]);
    expect(r.unreachable).toEqual([]);
    expect(ids(analyzeImpact(nodesOf("A", "B", "C", "D"), diamond, "D").dependents)).toEqual(["B", "C", "A"]);
  });

  it("a line without an arrow counts both ways and makes the result uncertain", () => {
    const edges: Edge[] = [fwd("A", "B"), { lineId: "BC", a: "B", b: "C", kind: "none" }];
    const r = analyzeImpact(nodesOf("A", "B", "C"), edges, "B");
    expect(ids(r.unreachable)).toEqual(["C"]);
    expect(r.unreachable![0].uncertain).toBe(true);
    const down = analyzeImpact(nodesOf("A", "B", "C"), edges, "C");
    expect(down.dependents.map((d) => [d.nodeId, d.uncertain])).toEqual([["B", true], ["A", true]]);
  });

  it("a certain chain is not marked uncertain", () => {
    const r = analyzeImpact(nodesOf("A", "B", "C"), chain, "C");
    expect(r.dependents.every((d) => !d.uncertain)).toBe(true);
  });

  it("an arrow in both directions links them both ways", () => {
    const r = analyzeImpact(nodesOf("A", "B"), [{ lineId: "x", a: "A", b: "B", kind: "both" }], "A");
    expect(ids(r.dependents)).toEqual(["B"]);
  });

  it("copes with cycles, and says when there is no entry point", () => {
    const cycle = [fwd("A", "B"), fwd("B", "C"), fwd("C", "A")];
    const r = analyzeImpact(nodesOf("A", "B", "C"), cycle, "A");
    expect(ids(r.dependents)).toEqual(["C", "B"]);
    expect(r.unreachable).toBeUndefined();
    expect(r.roots).toEqual([]);
  });

  it("entry points can be given", () => {
    const cycle = [fwd("A", "B"), fwd("B", "C"), fwd("C", "A")];
    const r = analyzeImpact(nodesOf("A", "B", "C"), cycle, "B", { roots: ["A"] });
    expect(ids(r.unreachable)).toEqual(["C"]);
  });

  it("an isolated node affects nobody", () => {
    const r = analyzeImpact(nodesOf("A", "B", "Z"), [fwd("A", "B")], "Z");
    expect(r.dependents).toEqual([]);
    expect(r.unreachable).toEqual([]);
  });

  it("only reports nodes that exist", () => {
    const r = analyzeImpact(nodesOf("A", "C"), [fwd("A", "GHOST"), fwd("GHOST", "C")], "C");
    expect(ids(r.dependents)).toEqual(["A"]);
  });
});

describe("findNodes", () => {
  const topology = {
    nodes: new Map([
      ["1", node("1", { title: "DB2 Server (Primary)", ips: ["172.20.22.111"], hostnames: ["w2dbspho1c2los"] })],
      ["2", node("2", { title: "DB1 Server (Secondary)", ips: ["172.20.22.110"] })],
      ["3", node("3", { title: "Credit Center", ips: ["172.20.21.11"] })],
      ["4", node("4", { title: "Custodian", ips: ["172.20.21.11"] })],
    ]),
  };
  it("finds by exact IP, host name, address prefix and title", () => {
    expect(findNodes(topology, "172.20.22.111").map((n) => n.id)).toEqual(["1"]);
    expect(findNodes(topology, "W2DBSPHO1C2LOS").map((n) => n.id)).toEqual(["1"]);
    expect(findNodes(topology, "172.20.22.11").map((n) => n.id).sort()).toEqual(["1", "2"]);
    expect(findNodes(topology, "primary").map((n) => n.id)).toEqual(["1"]);
  });
  it("an address on two tiles returns both, so the user can pick", () => {
    expect(findNodes(topology, "172.20.21.11").map((n) => n.id).sort()).toEqual(["3", "4"]);
  });
  it("puts exact matches before partial ones, and finds nothing for nonsense", () => {
    expect(findNodes(topology, "172.20.22.110")[0].id).toBe("2");
    expect(findNodes(topology, "zzz")).toEqual([]);
    expect(findNodes(topology, "  ")).toEqual([]);
  });
});

// ---- high availability -------------------------------------------------------------------

describe("analyzeImpact with high-availability groups", () => {
  // F5 -> App1, App2 (stand-ins) -> DB
  const edges = [fwd("F5", "App1"), fwd("F5", "App2"), fwd("App1", "DB"), fwd("App2", "DB"), fwd("Web", "F5")];
  const nodes = nodesOf("Web", "F5", "App1", "App2", "DB");
  const groups = new Map([["App1", "ha:1"], ["App2", "ha:1"]]);

  it("without groups every caller of a failed node falls", () => {
    const r = analyzeImpact(nodes, edges, "App1");
    expect(ids(r.dependents)).toEqual(["F5", "Web"]);
    expect(r.degraded).toEqual([]);
  });

  it("a caller that can still reach a stand-in is only degraded, and so is the stand-in", () => {
    const r = analyzeImpact(nodes, edges, "App1", { groups });
    expect(ids(r.dependents)).toEqual([]);
    expect(r.degraded.map((d) => [d.nodeId, d.reason.kind])).toEqual([["App2", "peer"], ["F5", "caller"]]);
    const peer = r.degraded.find((d) => d.nodeId === "App2")!;
    expect(peer.reason).toEqual({ kind: "peer", lost: ["App1"], left: 1, size: 2 });
    const caller = r.degraded.find((d) => d.nodeId === "F5")!;
    expect(caller.reason).toEqual({ kind: "caller", lost: "App1", served: ["App2"] });
    expect(caller.path).toEqual(["App1", "F5"]);
  });

  it("a caller wired to only one member falls when it goes", () => {
    const only = [fwd("Job", "App1"), ...edges];
    const r = analyzeImpact(nodesOf("Job", "Web", "F5", "App1", "App2", "DB"), only, "App1", { groups });
    expect(ids(r.dependents)).toEqual(["Job"]);
    expect(ids(r.degraded)).toContain("F5");
  });

  it("a node that is down for good takes its callers down when no member of a group it calls is left", () => {
    // DB has a stand-in too, but both App1 and App2 call only DB1
    const e = [fwd("App1", "DB1"), fwd("App2", "DB1"), fwd("App1", "DB2")];
    const g = new Map([["DB1", "ha:2"], ["DB2", "ha:2"]]);
    const r = analyzeImpact(nodesOf("App1", "App2", "DB1", "DB2"), e, "DB1", { groups: g });
    expect(ids(r.dependents)).toEqual(["App2"]); // App2 is wired to DB1 only
    expect(r.degraded.map((d) => [d.nodeId, d.reason.kind])).toEqual([["App1", "caller"], ["DB2", "peer"]]);
  });

  it("falls cascade through groups", () => {
    // C calls B1 and B2 (stand-ins); both call A, which is down
    const e = [fwd("C", "B1"), fwd("C", "B2"), fwd("B1", "A"), fwd("B2", "A")];
    const g = new Map([["B1", "ha:1"], ["B2", "ha:1"]]);
    const r = analyzeImpact(nodesOf("A", "B1", "B2", "C"), e, "A", { groups: g });
    expect(ids(r.dependents)).toEqual(["B1", "B2", "C"]);
    expect(r.dependents[2].path).toEqual(["A", "B1", "C"]);
    expect(r.degraded).toEqual([]);
  });

  it("a group of nodes that nothing in it has failed is left alone", () => {
    const r = analyzeImpact(nodes, edges, "DB", { groups });
    expect(ids(r.dependents)).toEqual(["App1", "App2", "F5", "Web"]);
    expect(r.degraded).toEqual([]);
  });
});

describe("high-availability groups", () => {
  const n = (id: string, title: string, zones: string[] = []): AnalysisNode => ({ ...node(id), title, zones });
  it("suggests nodes that share a service name, ignoring numbers, addresses and notes", () => {
    const nodes = new Map([
      ["1", n("1", "LOS Application Server")],
      ["2", n("2", "LOS Application Server")],
      ["3", n("3", "DB1 Server (Seconday)")],
      ["4", n("4", "DB2 Server (Primary)")],
      ["5", n("5", "w2waspho301frd 172.20.23.117 (VIP)")],
      ["6", n("6", "w2waspho302frd 172.20.23.117 (VIP)")],
      ["7", n("7", "Proxy Server")],
    ]);
    const s = suggestGroups(nodes, new Set());
    expect(s.map((x) => x.members)).toEqual([["3", "4"], ["1", "2"], ["5", "6"]]);
    expect(suggestGroups(nodes, new Set(["1"])).map((x) => x.members)).toEqual([["3", "4"], ["5", "6"]]);
  });

  it("reads the user's groups from the node shapes and ignores a group of one", () => {
    const nodes = new Map([["1", n("1", "a")], ["2", n("2", "b")], ["3", n("3", "c")]]);
    const shapes = new Map([
      ["1", { ...tile("1", 0, 0, "a"), ha: 1 }],
      ["2", { ...tile("2", 0, 0, "b"), ha: 1 }],
      ["3", { ...tile("3", 0, 0, "c"), ha: 2 }],
    ]);
    const g = readGroups(nodes, shapes);
    expect(g.groups).toEqual([{ number: 1, members: ["1", "2"] }, { number: 2, members: ["3"] }]);
    expect([...g.groupOf]).toEqual([["1", "ha:1"], ["2", "ha:1"]]);
  });
});

// ---- several failures at once, and single points of failure ---------------------------------

describe("analyzeImpact with several failed nodes", () => {
  it("takes the failed nodes together: who falls with any of them, what is cut off with all of them", () => {
    // Web -> A -> C ; Web -> B -> C ; Job -> B
    const e = [fwd("Web", "A"), fwd("Web", "B"), fwd("A", "C"), fwd("B", "C"), fwd("Job", "B")];
    const n = nodesOf("Web", "A", "B", "C", "Job");
    const one = analyzeImpact(n, e, "A");
    expect(ids(one.dependents)).toEqual(["Web"]);
    expect(one.unreachable).toEqual([]); // C is still reached through B
    const both = analyzeImpact(n, e, ["A", "B"]);
    expect(both.sources).toEqual(["A", "B"]);
    expect(ids(both.dependents)).toEqual(["Job", "Web"]);
    expect(ids(both.unreachable)).toEqual(["C"]); // the second route is gone too
  });

  it("failed nodes are not reported as affected by one another", () => {
    const r = analyzeImpact(nodesOf("A", "B", "C"), [fwd("A", "B"), fwd("B", "C")], ["B", "C"]);
    expect(ids(r.dependents)).toEqual(["A"]);
  });

  it("with stand-ins, losing the whole group takes the callers down", () => {
    const e = [fwd("F5", "App1"), fwd("F5", "App2")];
    const g = new Map([["App1", "ha:1"], ["App2", "ha:1"]]);
    const n = nodesOf("F5", "App1", "App2");
    expect(ids(analyzeImpact(n, e, ["App1"], { groups: g }).dependents)).toEqual([]);
    const r = analyzeImpact(n, e, ["App1", "App2"], { groups: g });
    expect(ids(r.dependents)).toEqual(["F5"]);
    expect(r.degraded).toEqual([]);
  });
});

describe("rankFailures", () => {
  const topo = (edges: Edge[], ...n: string[]) =>
    ({ nodes: nodesOf(...n), edges, possibleEdges: [], lines: [], zones: [], zoneNames: new Map() }) as unknown as Parameters<typeof rankFailures>[0];

  it("lists the nodes whose failure alone hurts, worst first (ties by name)", () => {
    // Web -> LB -> App1, App2 -> DB. Without groups, every caller of a failed node falls.
    const e = [fwd("Web", "LB"), fwd("LB", "App1"), fwd("LB", "App2"), fwd("App1", "DB"), fwd("App2", "DB")];
    const r = rankFailures(topo(e, "Web", "LB", "App1", "App2", "DB"));
    expect(r.map((x) => x.nodeId)).toEqual(["DB", "LB", "Web", "App1", "App2"]);
    expect(r.find((x) => x.nodeId === "Web")).toMatchObject({ entry: true, down: 0, cutOff: 4 });
    expect(r.find((x) => x.nodeId === "DB")).toMatchObject({ down: 4, cutOff: 0, entry: false });
  });

  it("stand-ins take a node out of the list", () => {
    const e = [fwd("F5", "App1"), fwd("F5", "App2")];
    const g = new Map([["App1", "ha:1"], ["App2", "ha:1"]]);
    expect(rankFailures(topo(e, "F5", "App1", "App2")).map((x) => x.nodeId)).toEqual(["F5", "App1", "App2"]);
    const withHa = rankFailures(topo(e, "F5", "App1", "App2"), g);
    expect(withHa.map((x) => x.nodeId)).toEqual(["F5"]);
    expect(withHa[0]).toMatchObject({ entry: true, cutOff: 2, down: 0 }); // the entry point cuts off both apps
  });
});
