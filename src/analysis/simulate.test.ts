import { describe, expect, it } from "vitest";
import type { Edge } from "./graph";
import type { AnalysisNode } from "./nodes";
import { simulate } from "./simulate";

const node = (id: string): AnalysisNode => ({ id, title: id, hostnames: [], ips: [], ports: [], text: id, zones: [] });
const topo = (edges: Edge[], ...ids: string[]) => ({ nodes: new Map(ids.map((i) => [i, node(i)])), edges });
const fwd = (a: string, b: string): Edge => ({ lineId: `${a}${b}`, a, b, kind: "forward" });
const lines = (fs: { lineId: string }[]) => fs.map((f) => f.lineId).sort();

// Web -> LB -> App1, App2 -> DB
const net = topo([fwd("Web", "LB"), fwd("LB", "App1"), fwd("LB", "App2"), fwd("App1", "DB"), fwd("App2", "DB")], "Web", "LB", "App1", "App2", "DB");
const ha = new Map([["App1", "ha:1"], ["App2", "ha:1"]]);

describe("simulate", () => {
  it("with everything up, traffic runs from the entry points along every line", () => {
    const s = simulate(net, []);
    expect(s.entries).toEqual(["Web"]);
    expect(lines(s.flows)).toEqual(["App1DB", "App2DB", "LBApp1", "LBApp2", "WebLB"]);
    expect(s.flows.find((f) => f.lineId === "WebLB")).toMatchObject({ from: "Web", to: "LB" });
    expect(s.stopped).toEqual([]);
    expect([...s.state.values()].every((x) => x === "up")).toBe(true);
  });

  it("switching a stand-in off moves the traffic onto the other one", () => {
    const s = simulate(net, ["App1"], ha);
    expect(s.state.get("App1")).toBe("off");
    expect(s.state.get("App2")).toBe("degraded");
    expect(s.state.get("LB")).toBe("degraded");
    expect(s.state.get("DB")).toBe("up");
    expect(lines(s.flows)).toEqual(["App2DB", "LBApp2", "WebLB"]);
    expect(lines(s.stopped)).toEqual(["App1DB", "LBApp1"]);
  });

  it("without stand-ins the callers fall, and what lies beyond is cut off", () => {
    const s = simulate(net, ["LB"]);
    expect(s.state.get("Web")).toBe("down");
    expect(s.state.get("App1")).toBe("cutoff");
    expect(s.state.get("DB")).toBe("cutoff");
    expect(s.flows).toEqual([]);
    expect(lines(s.stopped)).toHaveLength(5);
  });

  it("several nodes can be off at once, and switching an entry point off stops everything it fed", () => {
    const s = simulate(net, ["App1", "App2"], ha);
    expect(s.state.get("LB")).toBe("down");
    expect(s.state.get("DB")).toBe("cutoff");
    const w = simulate(net, ["Web"]);
    expect(w.flows).toEqual([]);
  });

  it("a line with no arrow carries traffic in the direction it is reached", () => {
    const s = simulate(topo([fwd("A", "B"), { lineId: "BC", a: "C", b: "B", kind: "none" }], "A", "B", "C"), []);
    expect(s.flows.find((f) => f.lineId === "BC")).toMatchObject({ from: "B", to: "C" });
  });
});
