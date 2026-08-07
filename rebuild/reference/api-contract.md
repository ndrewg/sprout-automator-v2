# Reference — API Contract

The complete HTTP surface. Every endpoint, request/response shape, status code, and validation rule. The frontend `src/api.ts` and the backend routes must match this exactly. Attach to **Phase 1** (auth/credentials), **Phase 2** (runs/schedule), and **Phase 3** (frontend client).

Conventions:
- All bodies are JSON. All Zod schemas use `.strict()` (unexpected fields → 400).
- Authenticated endpoints require the `sid` session cookie; without it → `401 {"error":"Not authenticated"}`.
- Validation failure → `400 {"error":"Invalid input","details": <zod flatten>}`.
- Server error → `500 {"error":"Internal server error"}` (no stack trace).

---

## Auth — `/auth`

### `POST /auth/signup`  *(public, rate-limited 10/15min)*
Body: `{ "email": string (email, ≤254), "password": string (12–200) }`
- `201 { "user": { "id", "email", "isAdmin" } }` + sets `sid` cookie (auto-login on signup).
- `409 { "error": "Email already registered" }` (Postgres `23505` on `lower(email)`).
- `400` invalid input.

### `POST /auth/login`  *(public, rate-limited 10/15min)*
Body: `{ "email": string, "password": string (12–200) }`
- `200 { "user": { "id", "email", "isAdmin" } }` + sets `sid` cookie.
- `401 { "error": "Invalid email or password" }` — **same message** for "no such user" and "bad password". On no-such-user, still run a dummy Argon2 verify (timing equalization). Audit `login_failure` with a non-reversible `emailHash` (never the email).
- `400` invalid input.

### `POST /auth/logout`  *(auth required)*
- `200 { "ok": true }` — deletes the session row, clears the cookie, audits `logout`.

### `GET /auth/me`  *(auth required)*
- `200 { "user": { "id", "email", "isAdmin" } }`
- `401` if not authenticated. (Frontend `useMe` must NOT retry on 401.)

---

## Credentials — `/credentials`  *(all auth required, rate-limited 120/min)*

`CredentialView` (the only shape ever returned — note NO plaintext passwords):
```ts
{
  sproutUsername: string | null,
  sproutPasswordSet: boolean,
  gmailEmail: string | null,
  gmailAppPasswordSet: boolean,
  updatedAt: string | null   // ISO
}
```

### `GET /credentials`
- `200 { "credentials": CredentialView }`. If no row yet, all-null/false view.

### `PUT /credentials`  *(partial update)*
Body (all optional, `.strict()`): `{ sproutUsername?, sproutPassword?, gmailEmail?, gmailAppPassword? }`
where each is `string (1–200, gmailEmail must be email ≤254) | null`.
Semantics per field: **omitted = leave unchanged; string = encrypt & set; `null` = clear.**
- `200 { "credentials": CredentialView }`.
- `400 { "error": "No fields to update" }` if the body has none of the four keys.
- Audits `credentials_updated` with `metadata.fields = [changed field names]` (never values).

### `POST /credentials/test-imap`
No body. Reads the stored (decrypted) Gmail email + app password, runs `testImapConnection`.
- `200 { "ok": true, "messageCount": number }`.
- `400 { "error": "Set gmailEmail and gmailAppPassword first." }` if either is unset.
- `400 { "ok": false, "error": <humanized IMAP error> }` on connection/auth failure.

### `DELETE /credentials`
- `200 { "ok": true }` — clears all four `*_enc` columns. Audits the deletion. *(⚑ RECOMMENDED: as a distinct `credentials_deleted` event.)*

---

## Schedule — `/schedule`  *(all auth required, rate-limited 120/min)*

`ScheduleView`:
```ts
{
  clockInTime: string,     // "HH:MM:SS"
  clockOutTime: string,    // "HH:MM:SS"
  enabled: boolean,
  updatedAt: string | null,// ISO
  configured: boolean,     // false until first PUT
  pausedFrom: string | null, // "YYYY-MM-DD" Manila day, inclusive; set/cleared as a pair
  pausedUntil: string | null,// inclusive
  pausedToday: boolean,    // server-computed; the UI must not recompute Manila dates
  today: { date: string /* YYYY-MM-DD Manila */, holiday: string | null }
}
```

### `GET /schedule`
- `200 { "schedule": ScheduleView }`. No row yet → defaults `05:30:00`/`18:05:00`, `enabled:false`, `configured:false`, `pausedFrom`/`pausedUntil` `null`, `pausedToday:false`, with `today` populated.

### `PUT /schedule`  *(lazy-creates the row)*
Body (all optional, `.strict()`): `{ clockInTime?: "HH:MM"|"HH:MM:SS", clockOutTime?: same, enabled?: boolean, pausedFrom?: "YYYY-MM-DD"|null, pausedUntil?: same }`.
Time regex: `^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$`. `"HH:MM"` is normalized to `"HH:MM:SS"`.
Date regex: `/^\d{4}-\d{2}-\d{2}$/` (Manila calendar day; nullable). The pause window is a **pair**: send both, both `null` (clears), or neither.
- `200 { "schedule": ScheduleView }`. Upserts the row, then **atomically** registers (if enabled) or unregisters the user's cron tasks. Audits `schedule_updated`.
- `400 { "error": "No fields to update" }` if empty body.
- `400 { "error": "Provide both pausedFrom and pausedUntil, or neither." }` if exactly one side is present (or one side is `null`).
- `400 { "error": "pausedUntil must be on or after pausedFrom" }` for a reversed range.
- `400 { "error": "That pause window has already ended." }` if `pausedUntil` is in the past.

---

## Runs — `/runs`  *(all auth required, rate-limited 120/min)*

`Run` (the public shape):
```ts
{
  id: string,
  action: "in" | "out",
  status: "pending" | "running" | "success" | "skipped" | "failure",
  loginMethod: string | null,
  error: string | null,
  steps: { timestamp: string, message: string }[],   // [] if none
  startedAt: string,        // ISO
  finishedAt: string | null,// ISO
  waitingForOtp: boolean    // true only while status=running AND the OTP bridge is waiting
}
```

### `POST /runs`  *(trigger a manual run)*
Body: `{ "action": "in" | "out" }` (`.strict()`).
- `202 { "run": Run }` — inserted as `pending` and enqueued. Client then polls `GET /runs/:id`.
- `400 { "error": "No Sprout credentials saved. ..." }` if the user has no sprout username/password.
- `409 { "error": "A run is already in progress" }` — the partial unique index rejected a second active run (`23505` → `already_running`).

### `GET /runs`
- `200 { "runs": Run[] }` — newest first, limit 20.

### `GET /runs/:id`
- `200 { "run": Run }` (scoped to the user).
- `404 { "error": "Run not found" }`.

### `POST /runs/:id/otp`  *(manual OTP fallback)*
Body: `{ "code": string matching /^\d{4,6}$/ }` (`.strict()`).
- `200 { "ok": true }` — code accepted into the OTP bridge (races IMAP; first wins).
- `404` run not found. `400` if the run isn't currently waiting for OTP, or the code format/acceptance fails.

### `GET /runs/queue/stats`  *(diagnostics)*
- `200 { "active": number, "waiting": number, "cap": number }`.

---

## Health — `/health`  *(public, unthrottled)*
- `200 { "status":"ok", "service":"sprout-automator-backend", "version":"0.0.0", "db":"ok"|"down", "timestamp": ISO }`.

---

## Frontend API client — `src/api.ts` (copy verbatim)

All requests use `credentials: "include"` and JSON. Errors throw `Error(body.error || "HTTP <status>")`.

```ts
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
```
