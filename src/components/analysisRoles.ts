export type Role = "source" | "dependent" | "degraded" | "cutoff" | "possible";

export const ROLE_COLOUR: Record<Role, string> = {
  source: "#d92d20",
  dependent: "#f08c00",
  degraded: "#d4a017",
  cutoff: "#7b3fe4",
  possible: "#98a2b3",
};
