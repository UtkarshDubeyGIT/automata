import { NextResponse } from "next/server";

/** Checkout is paused while new Pro grants are reviewed manually. */
export async function POST() {
  return NextResponse.json(
    { error: "Pro is currently invite only. Request access from the billing page." },
    { status: 503 },
  );
}
