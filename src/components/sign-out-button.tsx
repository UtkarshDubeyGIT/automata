"use client";

import { useState } from "react";

import { signOut as signOutAction } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/feedback";

export function SignOutButton({ menuItem = false }: { menuItem?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const close = () => setConfirming(false);

  return (
    <>
      <Button
        type="button"
        variant="danger"
        icon="logout"
        role={menuItem ? "menuitem" : undefined}
        className={menuItem ? "w-full justify-start" : undefined}
        onClick={() => setConfirming(true)}
      >
        Sign out
      </Button>

      <Dialog
        open={confirming}
        onClose={close}
        title="Sign out?"
        subtitle="You'll need to sign in again to access your Automata workspace."
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <form action={signOutAction}>
              <Button type="submit" variant="danger" icon="logout">
                Sign out
              </Button>
            </form>
          </>
        }
      />
    </>
  );
}
