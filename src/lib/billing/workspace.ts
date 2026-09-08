import type { ServerSupabase } from "@/lib/workspace";

/** Billing access always comes from the request's RLS client. */
export async function billingWorkspace(
  db: ServerSupabase,
  userId: string,
  requestedId?: string,
): Promise<{ id: string; customerId: string | null } | null> {
  let membershipQuery = db.from("workspace_members").select("workspace_id,role").eq("user_id", userId);
  if (requestedId) membershipQuery = membershipQuery.eq("workspace_id", requestedId);
  const { data: membership } = await membershipQuery.order("joined_at").limit(1).maybeSingle();
  let workspaceId: string | undefined;
  if (membership) {
    if (membership.role !== "owner" && membership.role !== "admin") return null;
    workspaceId = membership.workspace_id;
  } else {
    // Zidane's original schema has one owner per workspace and no membership
    // table. Match that owner explicitly, including any requested workspace.
    let ownerQuery = db.from("workspaces").select("id").eq("owner_id", userId);
    if (requestedId) ownerQuery = ownerQuery.eq("id", requestedId);
    const { data: owned } = await ownerQuery.limit(1).maybeSingle();
    workspaceId = owned?.id;
  }
  if (!workspaceId) return null;

  const { data: workspace } = await db.from("workspaces").select("stripe_customer_id").eq("id", workspaceId).maybeSingle();
  if (workspace?.stripe_customer_id) return { id: workspaceId, customerId: workspace.stripe_customer_id };
  const { data: billing } = await db.from("billing_customers").select("stripe_customer_id").eq("workspace_id", workspaceId).maybeSingle();
  return { id: workspaceId, customerId: billing?.stripe_customer_id ?? null };
}
