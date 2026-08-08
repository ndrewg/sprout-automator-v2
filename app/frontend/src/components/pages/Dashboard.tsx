import { useLogout, useResendVerification } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TriangleAlert } from "lucide-react";
import type { User } from "@/api";
import { SchedulePanel } from "@/components/panels/SchedulePanel";
import { CredentialsPanel } from "@/components/panels/CredentialsPanel";
import { ManualRunPanel } from "@/components/panels/ManualRunPanel";
import { RunsPanel } from "@/components/panels/RunsPanel";
import { NotificationsPanel } from "@/components/panels/NotificationsPanel";

export function Dashboard({ user }: { user: User }) {
  const logout = useLogout();
  const resend = useResendVerification();
  const resendError =
    resend.isError && resend.error instanceof Error
      ? resend.error.message
      : null;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">Sprout Automator</span>
          <div className="flex items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {user.email}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
        {!user.emailVerifiedAt ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>Email not verified</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>Check your inbox for the verification link we sent you.</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resend.mutate()}
                disabled={resend.isPending}
              >
                {resend.isPending ? "Sending…" : "Resend verification email"}
              </Button>
              {resend.isSuccess ? (
                <span className="text-sm text-muted-foreground">
                  Verification email sent.
                </span>
              ) : null}
              {resendError ? (
                <span className="text-sm text-destructive">{resendError}</span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <SchedulePanel />
        <NotificationsPanel />
        <CredentialsPanel />
        <ManualRunPanel />
        <RunsPanel />
      </main>
    </div>
  );
}
