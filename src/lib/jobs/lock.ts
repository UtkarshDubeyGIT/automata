import { isDuplicateKey } from "@/lib/credits";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from(table: string): any };

export interface JobClaim {
  ok: boolean;
  release: () => Promise<void>;
}

const NOT_CLAIMED: JobClaim = { ok: false, release: async () => {} };

export async function claimJob(
  admin: DbClient,
  name: string,
  ttlMs: number,
  holder: string,
): Promise<JobClaim> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ttlMs).toISOString();

  const { error } = await admin
    .from("job_locks")
    .insert({ name, claimed_at: now.toISOString(), claimed_by: holder });

  if (!error) return claimed(admin, name, holder);

  if (!isDuplicateKey(error)) return NOT_CLAIMED;

  const { data: stolen } = await admin
    .from("job_locks")
    .update({ claimed_at: now.toISOString(), claimed_by: holder })
    .eq("name", name)
    .lt("claimed_at", cutoff)
    .select("name")
    .maybeSingle();

  return stolen ? claimed(admin, name, holder) : NOT_CLAIMED;
}

function claimed(admin: DbClient, name: string, holder: string): JobClaim {
  return {
    ok: true,
    async release() {
      await admin
        .from("job_locks")
        .update({ claimed_at: new Date(0).toISOString() })
        .eq("name", name)
        .eq("claimed_by", holder);
    },
  };
}
