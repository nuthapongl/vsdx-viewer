import type { NodeState } from "../analysis/simulate";

export const STATE_COLOUR: Record<NodeState, string> = {
  up: "#12b76a",
  degraded: "#d4a017",
  off: "#d92d20",
  down: "#d92d20",
  cutoff: "#98a2b3",
};

export const STATE_LABEL: Record<NodeState, string> = {
  up: "Up",
  degraded: "Degraded",
  off: "Switched off",
  down: "Down",
  cutoff: "Cut off",
};
