import { useLogout } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import type { User } from "@/api";

export function Dashboard({ user }: { user: User }) {
  const logout = useLogout();

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-semibold">Sprout Automator</span>
          <div className="flex items-center gap-3">
            <span className="truncate text-sm text-muted-foreground">
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
      <main className="mx-auto max-w-5xl px-4 py-6">
        <p className="text-muted-foreground">
          Dashboard panels (Schedule, Credentials, Run, History) arrive in gate
          3D.
        </p>
      </main>
    </div>
  );
}
