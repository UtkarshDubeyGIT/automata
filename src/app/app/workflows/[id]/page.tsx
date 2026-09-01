import { WorkflowBuilder } from "@/components/workflow/workflow-builder";
import { currentWorkspace } from "@/lib/workspace/current";
import type { WorkflowGraph } from "@/lib/workflows/types";

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "new") return <WorkflowBuilder isNew workflowId={id} />;
  const context = await currentWorkspace();
  if (context) {
    const { data: workflow } = await context.supabase.from("workflows").select("name,state,draft_version_id,published_version_id").eq("id", id).single();
    const versionId = workflow?.draft_version_id ?? workflow?.published_version_id;
    const { data: version } = versionId ? await context.supabase.from("workflow_versions").select("graph").eq("id", versionId).single() : { data: null };
    if (workflow && version?.graph) return <WorkflowBuilder workflowId={id} workflowName={workflow.name} initialGraph={version.graph as WorkflowGraph} initiallyPublished={workflow.state === "active"} />;
  }
  return <WorkflowBuilder workflowId={id} />;
}
