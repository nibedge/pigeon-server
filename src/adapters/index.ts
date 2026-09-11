import { github } from "./github";
import { grafana } from "./grafana";
import { uptimekuma } from "./uptimekuma";
import type { Adapter } from "./util";

export type { Adapter } from "./util";
export { clip, pick, str } from "./util";

const ALL: Adapter[] = [github, grafana, uptimekuma];

const REGISTRY = new Map(ALL.map((a) => [a.name, a]));

export function getAdapter(name: string): Adapter | undefined {
  return REGISTRY.get(name.toLowerCase());
}

export function listAdapters(): { name: string; label: string }[] {
  return ALL.map(({ name, label }) => ({ name, label }));
}
