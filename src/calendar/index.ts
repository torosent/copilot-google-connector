import type { PrivateProvenance, ServiceDependencies, ToolSpec } from "../core/types.js";
import { createReadTools } from "./reads.js";
import { createWriteTools } from "./writes.js";

export function createCalendarTools(deps: ServiceDependencies & { provenance: PrivateProvenance }): ToolSpec[] {
  return [...createReadTools(deps), ...createWriteTools(deps)];
}
