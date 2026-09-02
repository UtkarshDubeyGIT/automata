import { WorkflowBuilder } from "@/components/workflow/workflow-builder";
import { currentWorkspace } from "@/lib/workspace/current";
import type { WorkflowGraph } from "@/lib/workflows/types";
import type { WorkflowPositions } from "@/lib/workflows/editor";

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "new") return <WorkflowBuilder isNew workflowId={id} />;
  const context = await currentWorkspace();
  if (context) {
    const { data: workflow } = await context.supabase.from("workflows").select("name,state,draft_graph,draft_positions,draft_revision,draft_version_id,published_version_id").eq("id", id).single();
    const fallbackVersionId = workflow?.draft_version_id ?? workflow?.published_version_id;
    const { data: fallbackVersion } = !workflow?.draft_graph && fallbackVersionId ? await context.supabase.from("workflow_versions").select("graph").eq("id", fallbackVersionId).single() : { data: null };
    const { data: publishedVersion } = workflow?.published_version_id ? await context.supabase.from("workflow_versions").select("graph").eq("id", workflow.published_version_id).single() : { data: null };
    const graph = (workflow?.draft_graph ?? fallbackVersion?.graph) as WorkflowGraph | undefined;
    if (workflow && graph) return <WorkflowBuilder workflowId={id} workflowName={workflow.name} initialGraph={graph} initialPositions={(workflow.draft_positions ?? {}) as WorkflowPositions} initialRevision={Number(workflow.draft_revision ?? 0)} publishedGraph={publishedVersion?.graph as WorkflowGraph | undefined} initiallyPublished={workflow.state === "active"} />;
  }
  return <WorkflowBuilder workflowId={id} />;
}
