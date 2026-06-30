import { useMe } from "@/hooks/useAuth";
import { AuthPage } from "./pages/AuthPage";
import { Dashboard } from "./pages/Dashboard";

export function AuthGate() {
  const { data: user, isLoading } = useMe();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return user ? <Dashboard user={user} /> : <AuthPage />;
}
