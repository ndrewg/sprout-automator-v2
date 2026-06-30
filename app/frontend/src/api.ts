async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export type User = { id: string; email: string; isAdmin: boolean };

export type CredentialsView = {
  sproutUsername: string | null;
  sproutPasswordSet: boolean;
  gmailEmail: string | null;
  gmailAppPasswordSet: boolean;
  updatedAt: string | null;
};

export type ScheduleView = {
  clockInTime: string;
  clockOutTime: string;
  enabled: boolean;
  updatedAt: string | null;
  configured: boolean;
  today: { date: string; holiday: string | null };
};

export const api = {
  me: () => request<{ user: User }>("/auth/me"),
  signup: (email: string, password: string) =>
    request<{ user: User }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  getCredentials: () => request<{ credentials: CredentialsView }>("/credentials"),
  putCredentials: (patch: Record<string, string | null>) =>
    request<{ credentials: CredentialsView }>("/credentials", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  testImap: () =>
    request<{ ok: boolean; messageCount?: number; error?: string }>(
      "/credentials/test-imap",
      { method: "POST" },
    ),

  getSchedule: () => request<{ schedule: ScheduleView }>("/schedule"),
  putSchedule: (patch: {
    clockInTime?: string;
    clockOutTime?: string;
    enabled?: boolean;
  }) =>
    request<{ schedule: ScheduleView }>("/schedule", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  startRun: (action: "in" | "out") =>
    request<{ run: Run }>("/runs", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  listRuns: () => request<{ runs: Run[] }>("/runs"),
  submitOtp: (runId: string, code: string) =>
    request<{ ok: true }>(`/runs/${runId}/otp`, {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
};

export type RunStep = { timestamp: string; message: string };

export type Run = {
  id: string;
  action: "in" | "out";
  status: "pending" | "running" | "success" | "skipped" | "failure";
  loginMethod: string | null;
  error: string | null;
  steps?: RunStep[];
  startedAt: string;
  finishedAt: string | null;
  waitingForOtp: boolean;
};
