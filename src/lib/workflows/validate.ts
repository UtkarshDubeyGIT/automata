import { outEdges, TRIGGER_TYPES, type WorkflowGraph } from "./types";

function hasCycle(graph: WorkflowGraph): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id) || !graph.steps[id]) return false;
    visiting.add(id);
    for (const next of outEdges(graph.steps[id])) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return visit(graph.start);
}

export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = [];
  const first = graph.steps[graph.start];
  if (!first || !TRIGGER_TYPES.has(first.type)) errors.push("The first step must be a trigger.");

  for (const step of Object.values(graph.steps)) {
    for (const destination of outEdges(step)) {
      if (!graph.steps[destination]) errors.push(`${step.name} points to a step that does not exist: ${destination}.`);
    }
  }

  if (hasCycle(graph)) errors.push("Workflow contains a cycle.");
  return [...new Set(errors)];
}
