import { useLogout } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import type { User } from "@/api";
import { SchedulePanel } from "@/components/panels/SchedulePanel";
import { CredentialsPanel } from "@/components/panels/CredentialsPanel";
import { ManualRunPanel } from "@/components/panels/ManualRunPanel";
import { RunsPanel } from "@/components/panels/RunsPanel";

export function Dashboard({ user }: { user: User }) {
  const logout = useLogout();

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
        <SchedulePanel />
        <CredentialsPanel />
        <ManualRunPanel />
        <RunsPanel />
      </main>
    </div>
  );
}
