import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { drainWhatsAppDeliveries, queueWorkflowReminder } from "@/lib/whatsapp/service";

export async function POST() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data: workspace } = await db.from("workspaces").select("id").eq("owner_id", user.id).maybeSingle();
  if (!workspace) return NextResponse.json({ error: "No workspace found." }, { status: 404 });
  const minute = new Date().toISOString().slice(0, 16);
  const delivery = await queueWorkflowReminder({
    workspaceId: workspace.id,
    kind: "test",
    body: "Your Automata WhatsApp workflow reminders are ready.",
    idempotencyKey: `whatsapp-test:${user.id}:${minute}`,
  });
  if (!delivery.queued) return NextResponse.json({ error: delivery.reason }, { status: 409 });
  const dispatch = await drainWhatsAppDeliveries(5);
  return NextResponse.json({ delivery, dispatch });
}
