import { useMemo, useState } from "react";
import { computeImpactView, findNodes, rankFailures, type FailureRank, type DegradedItem, type ImpactItem } from "../analysis/impact";
import { groupKey, suggestGroups, type HaGroups } from "../analysis/groups";
import type { LineInfo, Topology } from "../analysis/graph";
import type { AnalysisNode } from "../analysis/nodes";
import { ROLE_COLOUR } from "./analysisRoles";

interface Props {
  topology: Topology;
  ha: HaGroups;
  /** Put nodes into a high-availability group (a number) or out of any (undefined). */
  onGroups: (changes: { id: string; group?: number }[]) => void;
  /** The failed nodes (usually one). */
  sources: string[];
  onSources: (ids: string[]) => void;
  onFocusNode: (id: string) => void;
  focusLine: string | null;
  onFocusLine: (id: string | null) => void;
  onConfirm: (lineId: string, links: { begin?: string[]; end?: string[] }) => void;
  onClose: () => void;
}

const label = (n: AnalysisNode | undefined, id: string) => (n ? n.title || n.hostnames[0] || `#${id}` : `#${id}`);
const addresses = (n: AnalysisNode | undefined) => (n ? [...n.ips, ...(n.ips.length ? [] : n.hostnames)].join(", ") : "");

/** Name and first address, to tell apart nodes that share a name (the two data centres). */
const named = (nodes: Map<string, AnalysisNode>, id: string) => {
  const n = nodes.get(id);
  const ip = n?.ips[0] ?? n?.hostnames[0];
  return ip ? `${label(n, id)} (${ip})` : label(n, id);
};

function Chip({ colour, children }: { colour: string; children: React.ReactNode }) {
  return (
    <span className="chip" style={{ borderColor: colour, color: colour }}>
      {children}
    </span>
  );
}

function ResultList({
  items,
  nodes,
  reverse,
  possible,
  onFocusNode,
}: {
  items: (ImpactItem | DegradedItem)[];
  nodes: Map<string, AnalysisNode>;
  /** Dependents: the path was walked against the arrows, so read it the other way round. */
  reverse?: boolean;
  possible?: boolean;
  onFocusNode: (id: string) => void;
}) {
  if (items.length === 0) return <p className="muted">None.</p>;
  return (
    <ul className="results">
      {items.map((i) => {
        const n = nodes.get(i.nodeId);
        const route = (reverse ? [...i.path].reverse() : i.path).map((id) => label(nodes.get(id), id)).join(" → ");
        return (
          <li key={i.nodeId}>
            <button className="result" onClick={() => onFocusNode(i.nodeId)} title={route}>
              <span className="name">{label(n, i.nodeId)}</span>
              <span className="muted addr">{addresses(n)}</span>
              {"reason" in i && (
                <span className="reason">
                  {i.reason.kind === "peer"
                    ? `stand-in for ${i.reason.lost.map((id) => named(nodes, id)).join(", ")}: ${i.reason.left} of ${i.reason.size} left, no spare now`
                    : `lost ${named(nodes, i.reason.lost)}; still served by ${i.reason.served.map((id) => named(nodes, id)).join(", ")}`}
                </span>
              )}
              <span className="meta">
                <Chip colour="#667085">{i.hops} {i.hops === 1 ? "hop" : "hops"}</Chip>
                {i.uncertain && <Chip colour="#b25e00">direction unspecified</Chip>}
                {possible && <Chip colour="#667085">unconfirmed line</Chip>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EndDescription({ end, nodes }: { end: LineInfo["begin"]; nodes: Map<string, AnalysisNode> }) {
  if (end.kind === "node") return <span>{end.nodeIds.map((id) => label(nodes.get(id), id)).join(", ")}</span>;
  return <span className="muted">{end.kind === "zone" ? "on a zone's border" : "touches nothing"}</span>;
}

/** One line whose ends the user needs to settle. */
function ReviewLine({
  line,
  topology,
  focused,
  onFocus,
  onConfirm,
}: {
  line: LineInfo;
  topology: Topology;
  focused: boolean;
  onFocus: () => void;
  onConfirm: (links: { begin?: string[]; end?: string[] }) => void;
}) {
  const [picked, setPicked] = useState<{ begin: string[]; end: string[] }>({ begin: [], end: [] });
  const all = useMemo(
    () => [...topology.nodes.values()].sort((a, b) => a.title.localeCompare(b.title)),
    [topology],
  );
  const toggle = (which: "begin" | "end", id: string) =>
    setPicked((p) => ({ ...p, [which]: p[which].includes(id) ? p[which].filter((x) => x !== id) : [...p[which], id] }));

  const unresolved = (["begin", "end"] as const).filter((w) => line[w].kind !== "node");
  const ready = unresolved.every((w) => picked[w].length > 0);

  return (
    <li id={`review-${line.lineId}`} className={`review${focused ? " focused" : ""}`}>
      <button className="link-row" onClick={onFocus}>
        Line #{line.lineId}
        <span className="muted"> · arrow {line.arrows === "none" ? "none" : line.arrows === "both" ? "both ends" : `at ${line.arrows}`}</span>
      </button>
      {(["begin", "end"] as const).map((which) => (
        <div key={which} className="end">
          <span className="end-name">{which === "begin" ? "From" : "To"}</span>
          {line[which].kind === "node" ? (
            <EndDescription end={line[which]} nodes={topology.nodes} />
          ) : line[which].kind === "zone" ? (
            <div className="choices">
              <span className="muted">
                on the border of {topology.zoneNames.get(line[which].zoneId ?? "") ?? "a zone"}: which node?
              </span>
              <label className="zone-all">
                <input
                  type="checkbox"
                  checked={line[which].candidates.length > 0 && line[which].candidates.every((id) => picked[which].includes(id))}
                  disabled={line[which].candidates.length === 0}
                  onChange={(e) =>
                    setPicked((p) => ({ ...p, [which]: e.target.checked ? [...line[which].candidates] : [] }))
                  }
                />
                Whole zone <strong>{topology.zoneNames.get(line[which].zoneId ?? "") ?? ""}</strong>
                <span className="muted">({line[which].candidates.length} {line[which].candidates.length === 1 ? "node" : "nodes"})</span>
              </label>
              {line[which].candidates.map((id, k) => (
                <label key={id}>
                  <input type="checkbox" checked={picked[which].includes(id)} onChange={() => toggle(which, id)} />
                  {label(topology.nodes.get(id), id)}
                  <span className="muted">{addresses(topology.nodes.get(id))}</span>
                  {k === 0 && <Chip colour="#667085">nearest</Chip>}
                </label>
              ))}
            </div>
          ) : (
            <select
              value={picked[which][0] ?? ""}
              onChange={(e) => setPicked((p) => ({ ...p, [which]: e.target.value ? [e.target.value] : [] }))}
              aria-label={`Node at the ${which} of line ${line.lineId}`}
            >
              <option value="">touches nothing: choose a node…</option>
              {all.map((n) => (
                <option key={n.id} value={n.id}>
                  {label(n, n.id)} {addresses(n)}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
      <button
        className="confirm"
        disabled={!ready}
        onClick={() => onConfirm({ begin: picked.begin, end: picked.end })}
      >
        Confirm
      </button>
    </li>
  );
}

/** The nodes taken down together: remove one, add another, or add a whole zone (a data centre). */
function FailedNodes({
  topology,
  sources,
  onSources,
}: {
  topology: Topology;
  sources: string[];
  onSources: (ids: string[]) => void;
}) {
  const all = useMemo(() => [...topology.nodes.values()].sort((a, b) => a.title.localeCompare(b.title)), [topology]);
  const zones = useMemo(
    () =>
      topology.zones
        .map((z) => ({ id: z.id, name: topology.zoneNames.get(z.id), members: all.filter((n) => n.zones.includes(z.id)).map((n) => n.id) }))
        .filter((z): z is { id: string; name: string; members: string[] } => !!z.name && z.members.length > 0),
    [topology, all],
  );
  const add = (ids: string[]) => onSources([...sources, ...ids.filter((id) => !sources.includes(id))]);
  return (
    <div className="failed">
      {sources.length > 1 && (
        <ul className="chips">
          {sources.map((id) => (
            <li key={id}>
              <span>{named(topology.nodes, id)}</span>
              <button aria-label={`Bring ${label(topology.nodes.get(id), id)} back up`} onClick={() => onSources(sources.filter((x) => x !== id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <select
        value=""
        aria-label="Also take down another node"
        onChange={(e) => e.target.value && add([e.target.value])}
      >
        <option value="">+ Also down: another node…</option>
        {all
          .filter((n) => !sources.includes(n.id))
          .map((n) => (
            <option key={n.id} value={n.id}>
              {label(n, n.id)} {addresses(n)}
            </option>
          ))}
      </select>
      {zones.length > 0 && (
        <select
          value=""
          aria-label="Also take down a whole zone"
          onChange={(e) => {
            const z = zones.find((x) => x.id === e.target.value);
            if (z) add(z.members);
          }}
        >
          <option value="">+ Also down: a whole zone…</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name} ({z.members.length})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Each node's failure on its own, worst first: the single points of failure. */
function FailuresSection({
  topology,
  failures,
  onPick,
}: {
  topology: Topology;
  failures: FailureRank[];
  onPick: (id: string) => void;
}) {
  const rest = topology.nodes.size - failures.length;
  return (
    <section className="spof">
      <details>
        <summary>
          <strong>Single points of failure ({failures.length})</strong>
        </summary>
        <p className="muted">
          Nodes whose failure alone takes something else down or cuts it off, worst first. A node falls off this list when
          a stand-in or a second route covers it. Click one to see its effect.
        </p>
        {failures.length === 0 ? (
          <p className="muted">No node is a single point of failure.</p>
        ) : (
          <ul className="results">
            {failures.map((f) => {
              const n = topology.nodes.get(f.nodeId);
              return (
                <li key={f.nodeId}>
                  <button className="result" onClick={() => onPick(f.nodeId)}>
                    <span className="name">{label(n, f.nodeId)}</span>
                    <span className="muted addr">{addresses(n)}</span>
                    <span className="meta">
                      {f.entry && <Chip colour="#667085">entry point</Chip>}
                      {f.down > 0 && <Chip colour={ROLE_COLOUR.dependent}>{f.down} down</Chip>}
                      {f.cutOff > 0 && <Chip colour={ROLE_COLOUR.cutoff}>{f.cutOff} cut off</Chip>}
                      {f.degraded > 0 && <Chip colour={ROLE_COLOUR.degraded}>{f.degraded} degraded</Chip>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {rest > 0 && <p className="muted">{rest} {rest === 1 ? "node does" : "nodes do"} no harm to the rest when failing alone.</p>}
      </details>
    </section>
  );
}

/** The high-availability groups: those made, suggestions from the names, and a way to make one by hand. */
function GroupsSection({
  topology,
  ha,
  onGroups,
  onFocusNode,
}: {
  topology: Topology;
  ha: HaGroups;
  onGroups: (changes: { id: string; group?: number }[]) => void;
  onFocusNode: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const nextNumber = Math.max(0, ...ha.groups.map((g) => g.number)) + 1;
  const taken = useMemo(() => new Set(ha.groups.flatMap((g) => g.members)), [ha]);
  const suggestions = useMemo(() => suggestGroups(topology.nodes, taken), [topology, taken]);
  const all = useMemo(() => [...topology.nodes.values()].sort((a, b) => a.title.localeCompare(b.title)), [topology]);
  const name = (id: string) => named(topology.nodes, id);
  const make = (members: string[], offset = 0) => onGroups(members.map((id) => ({ id, group: nextNumber + offset })));
  const real = ha.groups.filter((g) => g.members.length > 1);

  return (
    <section className="ha">
      <h3>High-availability groups ({real.length})</h3>
      <p className="muted">
        Nodes in one group stand in for one another: a caller wired to several of them keeps working when one fails,
        and is shown as degraded instead of down. Saved in the file.
      </p>
      {real.length > 0 && (
        <ul className="groups">
          {real.map((g) => (
            <li key={g.number}>
              <span className="members">
                {g.members.map((m) => (
                  <button key={m} className="link" onClick={() => onFocusNode(m)} title={addresses(topology.nodes.get(m))}>
                    {name(m)}
                  </button>
                ))}
              </span>
              <button onClick={() => onGroups(g.members.map((id) => ({ id })))} title="Take these nodes out of the group">
                Ungroup
              </button>
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 0 && (
        <details>
          <summary>Suggested from the names ({suggestions.length})</summary>
          <ul className="groups">
            {suggestions.map((s, i) => (
              <li key={s.members.join(",")}>
                <span className="members">
                  <strong>{s.name}</strong>
                  <span className="muted">
                    {" "}
                    {s.members.map((m) => addresses(topology.nodes.get(m)) || name(m)).join(" | ")}
                  </span>
                </span>
                <button onClick={() => make(s.members)} data-suggestion={i}>
                  Group
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => onGroups(suggestions.flatMap((s, i) => s.members.map((id) => ({ id, group: nextNumber + i }))))}
          >
            Accept all
          </button>
        </details>
      )}
      <details>
        <summary>Make a group by hand</summary>
        <div className="choices">
          {all.map((n) => (
            <label key={n.id}>
              <input
                type="checkbox"
                checked={picked.includes(n.id)}
                onChange={() => setPicked((p) => (p.includes(n.id) ? p.filter((x) => x !== n.id) : [...p, n.id]))}
              />
              {label(n, n.id)} <span className="muted">{addresses(n)}</span>
              {taken.has(n.id) && <Chip colour="#667085">in a group (will move)</Chip>}
            </label>
          ))}
        </div>
        <button
          className="confirm"
          disabled={picked.length < 2}
          onClick={() => {
            make(picked);
            setPicked([]);
          }}
        >
          Group the {picked.length} selected
        </button>
      </details>
    </section>
  );
}

export function AnalysisPanel({ topology, ha, onGroups, sources, onSources, onFocusNode, focusLine, onFocusLine, onConfirm, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"dependents" | "degraded" | "cutoff">("dependents");
  const matches = useMemo(() => findNodes(topology, query).slice(0, 8), [topology, query]);
  const all = useMemo(
    () => [...topology.nodes.values()].sort((a, b) => a.title.localeCompare(b.title)),
    [topology],
  );
  const source = sources[0] ?? null;
  const node = source && sources.length === 1 ? topology.nodes.get(source) : undefined;
  const failures = useMemo(() => rankFailures(topology, ha.groupOf), [topology, ha]);

  const result = useMemo(() => (sources.length > 0 ? computeImpactView(topology, sources, ha.groupOf) : null), [topology, sources, ha]);
  const impact = result?.impact ?? null;
  const extras = result?.extras ?? null;

  const review = topology.lines.filter((l) => !l.resolved);
  // Lines still to be confirmed that might start or end at this node (it is one of the candidates).
  const involved = sources.length > 0 ? review.filter((l) => sources.some((x) => l.begin.candidates.includes(x) || l.end.candidates.includes(x))) : [];
  const endName = (e: LineInfo["begin"]) =>
    e.kind === "node"
      ? e.nodeIds.map((id) => label(topology.nodes.get(id), id)).join(", ")
      : e.kind === "zone"
        ? `${topology.zoneNames.get(e.zoneId ?? "") ?? "a zone"} (${e.candidates.length})`
        : "nothing";

  return (
    <aside className="analysis" aria-label="Impact analysis">
      <header>
        <strong>Impact analysis</strong>
        <button onClick={onClose} aria-label="Close analysis">×</button>
      </header>

      <section>
        <label className="search">
          <span>IP, host name or node</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. 172.20.22.111"
            aria-label="Search IP, host name or node"
          />
        </label>
        {query.trim() !== "" && (
          <ul className="matches">
            {matches.length === 0 && <li className="muted">No node matches.</li>}
            {matches.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => {
                    onSources([n.id]);
                    onFocusNode(n.id);
                    setQuery("");
                  }}
                >
                  <span className="name">{label(n, n.id)}</span>
                  <span className="muted addr">{addresses(n)}</span>
                </button>
              </li>
            ))}
            {matches.length > 1 && <li className="muted">More than one node matches: pick the one you mean.</li>}
          </ul>
        )}
        <details>
          <summary>All nodes ({all.length})</summary>
          <ul className="matches">
            {all.map((n) => (
              <li key={n.id}>
                <button onClick={() => { onSources([n.id]); onFocusNode(n.id); }}>
                  <span className="name">{label(n, n.id)}</span>
                  <span className="muted addr">{addresses(n)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
        {!source && <p className="muted">Pick a node here, or click one on the diagram (Shift-click for several), to see what its failure would affect.</p>}
      </section>

      {source && impact && (
        <section>
          <h3 style={{ color: ROLE_COLOUR.source }}>
            If{" "}
            {sources.map((id, i) => (
              <span key={id}>
                {i > 0 && (i === sources.length - 1 ? " and " : ", ")}
                <em>{sources.length > 1 ? named(topology.nodes, id) : label(topology.nodes.get(id), id)}</em>
              </span>
            ))}{" "}
            {sources.length > 1 ? "go down" : "goes down"}
          </h3>
          {node && (
            <p className="muted">
              {node.ips.length > 0 && <>IP {node.ips.join(", ")}. </>}
              {node.ports.length > 0 && <>Ports {node.ports.join(", ")}. </>}
              {node.ips.length > 1 && <>One machine, several interfaces. </>}
            </p>
          )}
          <FailedNodes topology={topology} sources={sources} onSources={onSources} />
          {sources.length === 1 && ha.groupOf.has(source) && (
            <p className="muted">
              In a high-availability group with{" "}
              {ha.groups
                .find((g) => groupKey(g.number) === ha.groupOf.get(source))
                ?.members.filter((m) => m !== source)
                .map((m) => label(topology.nodes.get(m), m))
                .join(", ")}
              .
            </p>
          )}
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "dependents"} className={tab === "dependents" ? "active" : undefined} onClick={() => setTab("dependents")}>
              {ha.groupOf.size > 0 ? "Down" : "Depends on it"} ({impact.dependents.length})
            </button>
            {ha.groupOf.size > 0 && (
              <button role="tab" aria-selected={tab === "degraded"} className={tab === "degraded" ? "active" : undefined} onClick={() => setTab("degraded")}>
                Degraded ({impact.degraded.length})
              </button>
            )}
            <button role="tab" aria-selected={tab === "cutoff"} className={tab === "cutoff" ? "active" : undefined} onClick={() => setTab("cutoff")}>
              Cut off ({impact.unreachable?.length ?? "–"})
            </button>
          </div>
          {tab === "dependents" ? (
            <>
              <p className="muted">
                {ha.groupOf.size > 0
                  ? "Nodes that stop working: they call it, directly or through others, and have no stand-in left to use."
                  : "Nodes that call it, directly or through others: they lose what it provides."}
              </p>
              <ResultList items={impact.dependents} nodes={topology.nodes} reverse onFocusNode={onFocusNode} />
            </>
          ) : tab === "degraded" ? (
            <>
              <p className="muted">Still working, but one stand-in short: the next failure in the group would hurt.</p>
              <ResultList items={impact.degraded} nodes={topology.nodes} onFocusNode={onFocusNode} />
            </>
          ) : impact.unreachable === undefined ? (
            <p className="muted">The diagram has no entry point (every node is pointed at by another), so what gets cut off can't be told.</p>
          ) : (
            <>
              <p className="muted">
                Nodes that could be reached from the diagram's entry points
                ({impact.roots.map((r) => label(topology.nodes.get(r), r)).join(", ")}) and no longer can be.
              </p>
              <ResultList items={impact.unreachable} nodes={topology.nodes} onFocusNode={onFocusNode} />
            </>
          )}
          {involved.length > 0 && (
            <div className="unconfirmed" role="note">
              <strong>
                {involved.length} unconfirmed {involved.length === 1 ? "line" : "lines"} may involve this node
              </strong>
              <span className="muted"> - they are not counted above. Confirm them to see the full effect.</span>
              <ul>
                {involved.slice(0, 8).map((l) => (
                  <li key={l.lineId}>
                    <button
                      className="link"
                      onClick={() => {
                        onFocusLine(l.lineId);
                        document.getElementById(`review-${l.lineId}`)?.scrollIntoView({ block: "nearest" });
                      }}
                    >
                      #{l.lineId}: {endName(l.begin)} → {endName(l.end)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {extras && (tab === "cutoff" ? extras.unreachable.length > 0 : extras.dependents.length > 0) && (
            <details className="extras">
              <summary>
                Might also be affected: {tab === "cutoff" ? extras.unreachable.length : extras.dependents.length} (needs the unconfirmed lines)
              </summary>
              <ResultList
                items={tab === "cutoff" ? extras.unreachable : extras.dependents}
                nodes={topology.nodes}
                reverse={tab !== "cutoff"}
                possible
                onFocusNode={onFocusNode}
              />
            </details>
          )}
        </section>
      )}

      <FailuresSection
        topology={topology}
        failures={failures}
        onPick={(id) => {
          onSources([id]);
          onFocusNode(id);
        }}
      />

      <GroupsSection topology={topology} ha={ha} onGroups={onGroups} onFocusNode={onFocusNode} />

      <section>
        <h3>Connections to confirm ({review.length})</h3>
        {review.length === 0 ? (
          <p className="muted">Every line was matched to its nodes.</p>
        ) : (
          <>
            <p className="muted">
              These lines end on a zone's border or on nothing, so the diagram alone doesn't say which node they join.
              Your answer is saved in the file.
            </p>
            <ul className="reviews">
              {review.map((l) => (
                <ReviewLine
                  key={l.lineId}
                  line={l}
                  topology={topology}
                  focused={focusLine === l.lineId}
                  onFocus={() => onFocusLine(focusLine === l.lineId ? null : l.lineId)}
                  onConfirm={(links) => {
                    const keep = (w: "begin" | "end") => (l[w].kind === "node" && l[w].source === "confirmed" ? l[w].nodeIds : undefined);
                    onConfirm(l.lineId, {
                      begin: l.begin.kind === "node" ? keep("begin") : links.begin,
                      end: l.end.kind === "node" ? keep("end") : links.end,
                    });
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </aside>
  );
}
