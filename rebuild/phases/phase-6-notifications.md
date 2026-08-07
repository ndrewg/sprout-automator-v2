# Phase 6 — Run Notifications (Telegram) + Missed-Run Reconciliation

**Goal:** the user finds out what their automation did, on the device they actually look at, without opening the dashboard. Every run that reaches a terminal state sends a Telegram message — **and a run that never happened at all sends one too.**

That second half is the point. A failed run is loud; a *missed* run is silent, and silence is indistinguishable from success. Both halves ship together or the feature is a lie.

**Attach for this session:** `03-CONVENTIONS-AND-GUARDRAILS.md`, `reference/api-contract.md`, `reference/database-schema.md`, `reference/testing-strategy.md`, `reference/live-docs-and-mcp.md`.

> 📡 **Live docs (Context7):** Drizzle (schema DSL + `onConflictDoNothing`), express-rate-limit v7 (`keyGenerator`), node-cron. The Telegram Bot API is stable and documented inline below — no fetch needed for it.

**Independent of Phases 4B and 5.** This does not require a mail provider or a public host. Build it whenever.

> **Commit checkpoints** — commit only on a green gate; never a red one; *you* run the commit, not the agent.
> - Gate 6A → `fix(crypto): pin authTagLength on AES-GCM decipher [gate 6A]`
> - Gate 6B → `feat(phase-6): notification_settings schema + migration [gate 6B]`
> - Gate 6C → `feat(phase-6): telegram transport + notification service [gate 6C]`
> - Gate 6D → `feat(phase-6): dispatch on run terminal state [gate 6D]`
> - Gate 6E → `feat(phase-6): missed-run reconciliation sweep [gate 6E]`
> - Gate 6F → `feat(phase-6): notifications panel + settings routes [gate 6F]`
> Then tag: `git tag phase-6-complete`.

---

## Design decisions (locked — see D17)

| Decision | Value | Why |
|---|---|---|
| Channel | Telegram Bot API over plain `fetch` | No SMTP, no deliverability, no new dependency. Setup is ~1 min via BotFather. |
| Config home | New `notification_settings` table | Keeps `schedules` about *times*. Leaves room for a second channel without more columns on schedules. |
| Which outcomes | `success`, `failure`, `skipped`, `missed` — four independent toggles, all default **on** | See "Why `skipped` matters" below. Separate toggles mean silencing one later is a settings change, not a migration. |
| Which runs | Scheduled **and** manual | One rule, no branching on run origin. `runs` has no origin column and doesn't need one. |
| Bot token | AES-256-GCM via `lib/encryption` | It's a credential. Chat ID is **not** encrypted — it's an identifier, not a secret. |
| Delivery | Fire-and-forget, never awaited by the run | A notification must never change run status, run timing, or an HTTP response. |
| Missed detection | Reconciliation sweep every 5 min, DB-gated idempotency | A cron that didn't fire can't notify you about itself. Something else has to notice. |

### Why `skipped` matters (do not "optimize" this away)

`skipped` sounds benign. In this system it is not, because of where it comes from:

- Weekends never fire — `1-5` is in the cron expression.
- Holidays return from `fireCron` **before a run row exists** — no run, no status.

So the *only* producer of `skipped` is `isAlreadyClockedForToday()` returning `true`, and that function returns `true` in two very different cases (see the playbook, invariant #5):

1. **A matching row was found** — you really did already clock. Benign.
2. **It could not verify** — Attendance card missing, selector threw, page in an odd state. It fails safe and skips.

Case 2 means **you are not clocked in**, and it is the earliest signal that HRHub changed its markup. Suppressing `skipped` hides exactly the case the user most needs to see.

`clock.ts` already distinguishes them in its step messages. **Do not modify `clock.ts`** — it is the most brittle file in the repo. Instead the notifier reads the run's **last step message** and uses it as the reason line. Case 1 reads `Already clocked IN today (matched row …)`; case 2 reads `Could not locate Attendance card…` or `Could not verify clock state (…)`. Marker: a skip whose last step contains `safety measure` or `Could not` is rendered with ⚠️; anything else with ℹ️.

---

## 6A — Prerequisite: pin the GCM auth tag length

`src/lib/encryption.ts` currently creates the decipher without an explicit tag length:

```ts
const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
```

Node accepts a **truncated** auth tag here (DEP0182 / CVE-2025-54887 class), which weakens forgery resistance. Our tags are always 16 bytes, so pinning it is backward-compatible with every row already in the database.

Change **both** sides so they stay symmetrical:

```ts
const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: TAG_LEN });
// …
const decipher = createDecipheriv("aes-256-gcm", KEY, iv, { authTagLength: TAG_LEN });
```

Update `reference/crypto-and-otp-specs.md` to match — that file is the verbatim source and must not drift from the code.

**Gate 6A:** `pnpm test` — the existing encryption round-trip tests still pass (proves backward compatibility), plus a new case asserting that a payload with a truncated tag throws.

---

## 6B — Schema

Add to `src/db/schema.ts` (import `integer` from `drizzle-orm/pg-core`):

```ts
// notification_settings — one row per user; how they want to be told what happened
export const notificationSettings = pgTable("notification_settings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  // Encrypted — format owned by lib/encryption.ts. NULL until configured.
  telegramBotTokenEnc: text("telegram_bot_token_enc"),
  // NOT encrypted: an identifier, not a secret. "123456789" or "-1001234567890".
  telegramChatId: text("telegram_chat_id"),
  enabled: boolean("enabled").notNull().default(false),
  notifyOnSuccess: boolean("notify_on_success").notNull().default(true),
  notifyOnFailure: boolean("notify_on_failure").notNull().default(true),
  notifyOnSkipped: boolean("notify_on_skipped").notNull().default(true),
  notifyOnMissed: boolean("notify_on_missed").notNull().default(true),
  // Consecutive "chat not found / bot blocked" errors. Persisted so a restart
  // doesn't reset progress toward auto-disable.
  blockedCount: integer("blocked_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// missed_run_notices — idempotency ledger for the reconciliation sweep.
// One row per (user, Manila date, action) means "we already told them".
export const missedRunNotices = pgTable(
  "missed_run_notices",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // YYYY-MM-DD in Asia/Manila. Text, not date — it is a Manila calendar day,
    // not an instant, and manilaDateString() already produces exactly this.
    manilaDate: text("manila_date").notNull(),
    action: text("action", { enum: ["in", "out"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    onceUnique: uniqueIndex("missed_notice_once")
      .on(t.userId, t.manilaDate, t.action),
  }),
);

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type MissedRunNotice = typeof missedRunNotices.$inferSelect;
```

> ⚠️ **`enabled` defaults to `false` here — deliberately.** `schedules.enabled` defaults to `true` and that has already caused one lazy-opt-in bug (see phase-2 2E). Never notify someone who hasn't asked to be notified. Same lazy-opt-in rule as schedules: **no row exists until the first PUT.**

Generate and apply:

```bash
cd app/backend && pnpm db:generate --name notifications   # NOT `-- --name`
pnpm exec tsx --env-file=../../.env src/db/migrate.ts
```

Add two audit events to the closed union in `src/lib/audit.ts` (it is `AuditEventType`, **not** `AuditEvent`):

```ts
| "notification_settings_updated"
| "notification_auto_disabled"
```

Add to `src/config.ts`:

```ts
MISSED_RUN_GRACE_MINUTES: z.coerce.number().int().min(1).max(180).default(20),
```

**Gate 6B:** migration applies; `\d notification_settings` shows the unique `user_id`; `\d missed_run_notices` shows the composite unique index; `pnpm typecheck` clean.

---

## 6C — Telegram transport + notification service

Two files, split by concern. **Do not merge them** — the transport must stay DB-free and the policy must stay HTTP-free, so each is testable alone.

### `src/lib/telegram.ts` — transport only

The **only** module that talks to `api.telegram.org`. No database, no settings lookup, no policy.

```ts
import { logger } from "./logger";

const API_BASE = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 10_000;
const GETME_TIMEOUT_MS = 5_000;

export type TelegramError = "blocked" | "rate_limited" | "network" | "bad_token" | "unknown";

export type TelegramSendResult =
  | { ok: true }
  | { ok: false; error: TelegramError };

export type TelegramBotInfo =
  | { ok: true; username: string; id: number }
  | { ok: false; error: TelegramError };

/** Escape text destined for HTML parse_mode. Callers MUST use this for any
 *  value that came from a run (error strings, step messages). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  html: string,
): Promise<TelegramSendResult> {
  try {
    const res = await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Telegram returns non-JSON on some 5xx — never let that throw upward.
    let body: { ok?: boolean; error_code?: number; description?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { ok: false, error: "unknown" };
    }
    if (body.ok) return { ok: true };
    return { ok: false, error: classify(body.error_code, body.description) };
  } catch (err: unknown) {
    // AbortSignal.timeout and DNS/socket failures land here.
    logger.warn({ err }, "telegram send failed");
    return { ok: false, error: "network" };
  }
}

export async function getBotInfo(botToken: string): Promise<TelegramBotInfo> {
  try {
    const res = await fetch(`${API_BASE}/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(GETME_TIMEOUT_MS),
    });
    let body: { ok?: boolean; error_code?: number; description?: string;
                result?: { id: number; is_bot: boolean; username: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { ok: false, error: "unknown" };
    }
    if (!body.ok || !body.result?.is_bot) {
      return { ok: false, error: classify(body.error_code, body.description) };
    }
    return { ok: true, username: body.result.username, id: body.result.id };
  } catch {
    return { ok: false, error: "network" };
  }
}

function classify(code: number | undefined, description: string | undefined): TelegramError {
  const d = (description ?? "").toLowerCase();
  if (code === 401 || d.includes("unauthorized")) return "bad_token";
  if (code === 429) return "rate_limited";
  if (d.includes("chat not found") || d.includes("blocked") || d.includes("kicked")) {
    return "blocked";
  }
  return "unknown";
}
```

**Never log `botToken`.** It appears only in the URL passed to `fetch`; it must never reach a log line, an error message, an audit row, or an API response. The `redact` list in `lib/logger.ts` gains `telegramBotToken` and `botToken` as belt-and-braces.

### `src/services/notifications.ts` — policy

Owns settings lookup, message construction, the blocked-count state machine, and the two public entry points.

```ts
const AUTO_DISABLE_THRESHOLD = 3;
```

**`dispatch(userId, html, kind)` — the single send path:**

1. Load the user's `notification_settings` row. No row, or `enabled === false` → return `"skipped"` (this is **not** a success; it must not reset `blockedCount`).
2. Check the per-kind toggle (`notifyOnSuccess` / `…Failure` / `…Skipped` / `…Missed`) → if off, return `"skipped"`.
3. Decrypt the bot token; validate `chatId` against `/^-?\d+$/`. Missing or malformed → `"skipped"`.
4. `sendTelegramMessage(...)`.
5. On success: if `blockedCount > 0`, reset it to 0. Return `"sent"`.
6. On `"blocked"`: increment `blockedCount`. If it reaches `AUTO_DISABLE_THRESHOLD`, set `enabled = false` and `recordAudit("notification_auto_disabled", { userId, metadata: { blockedCount, reason: "consecutive_blocked" } })`. Return `"failed"`.
7. On any other error: log at `warn` and return `"failed"` — **do not** increment the counter. A network blip is not the user blocking the bot, and conflating them auto-disables people during an outage.

> The distinction in steps 5–7 is the whole reason `dispatch` returns three states rather than a boolean. `"skipped"` must never reset the counter, or a user with notifications off would silently clear their own blocked history.

**`notifyRunFinished({ run, status, error, lastStep })`:**

Builds and dispatches the terminal-state message. Times are rendered in Manila via `Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" })`. The date comes from `manilaDateString()` in `lib/ph-holidays` — do not reimplement it.

```
✅ <b>Clocked in</b>
05:31 · Mon 10 Aug

⚠️ <b>Clock-out failed</b>
18:06 · Mon 10 Aug
Login failed — could not reach dashboard. Check screenshots.

ℹ️ <b>Clock-in skipped</b>
05:31 · Mon 10 Aug
Already clocked IN today (matched row "08/10/26  IN  05:02").

⚠️ <b>Clock-in skipped — could not verify</b>
05:31 · Mon 10 Aug
Could not locate Attendance card. Skipping IN as a safety measure.
You may NOT be clocked in. Check HRHub.
```

The last variant is the one that earns the feature. A skip is rendered as ⚠️ **and** carries the explicit "you may not be clocked in" line when the last step matches `/safety measure|Could not/`.

All run-derived text (`error`, `lastStep`) goes through `escapeHtml` first.

**Gate 6C:** unit tests (no network, no DB — inject a fake transport) covering: each of the four message shapes renders the right glyph and reason; the two skip variants are distinguished; `escapeHtml` neutralises `<b>` in an error string; `dispatch` returns `"skipped"` when disabled and does **not** reset `blockedCount`; three consecutive `"blocked"` results flip `enabled` to false and write exactly one audit row; a `"network"` error leaves `blockedCount` untouched.

---

## 6D — Dispatch on terminal state

`executeQueuedRun` currently writes a terminal status in **three** places (`src/services/runs.ts`): the credentials-missing early return (~line 81), the success/skipped/failure update after `runAutomation` (~line 138), and the catch block (~line 155). Hanging a notification off each one is how a fourth site gets added later and silently notifies nobody.

**Refactor all three onto one helper** in `runs.ts`:

```ts
async function finalizeRun(
  run: Run,
  patch: { status: "success" | "skipped" | "failure"; loginMethod?: string | null; error?: string | null },
): Promise<void> {
  const [updated] = await db
    .update(runs)
    .set({ ...patch, finishedAt: new Date() })
    .where(eq(runs.id, run.id))
    .returning();
  if (!updated) throw new Error("finalizeRun: update returned no row");
  logger.info({ runId: run.id, status: patch.status }, "run finished");

  // Fire-and-forget (sanctioned idiom #2, §03). A notification must never
  // change run status or timing. notifyRunFinished never throws; the .catch
  // is belt-and-braces so a future refactor can't make this crash a run.
  void notifyRunFinished({
    run: updated,
    lastStep: updated.steps.at(-1)?.message ?? null,
  }).catch(() => {});
}
```

`.returning()` matters: the notifier needs the **persisted** `steps` array to read the last step, and the in-memory `run` object was loaded before execution — its `steps` and `finishedAt` are stale.

Then replace each of the three update sites with a `finalizeRun(...)` call. The credentials-missing site becomes `finalizeRun(run, { status: "failure", error: "No Sprout credentials available for this run" })` — that one is worth notifying about precisely because the user won't otherwise discover their config is broken until payday.

**Gate 6D:**
1. With notifications enabled, a manual `POST /runs` that fails delivers a Telegram message within a few seconds; the run's own status is unaffected.
2. With `enabled = false`, no message and no error.
3. With the Telegram API unreachable (point `API_BASE` at a dead port in a test), the run still reaches its terminal status normally. **This is the important one** — assert it with a test, not by eye.
4. `grep -c "status: \"failure\"" src/services/runs.ts` shows the status literals now live only inside `finalizeRun` call sites.

---

## 6E — Missed-run reconciliation

The feature the whole phase exists for. **A process that is down cannot report that it is down** — so this is a sweep that runs when the process *is* up and reconciles what should have happened against what did.

Register **one** global task at boot in `src/services/scheduler.ts` (not one per user):

```ts
cron.schedule("*/5 * * * *", () => void sweepMissedRuns(), { timezone: "Asia/Manila" });
```

`sweepMissedRuns()` — must never throw across the cron boundary:

1. If today (Manila) is a weekend or `isPhilippineHoliday()` → return. Same rules as `fireCron`; a holiday isn't a missed run.
2. Load all `schedules` rows where `enabled = true`. (Phase 7 adds: skip rows paused for today.)
3. For each row, for each action `in`/`out`:
   - Compute the expected fire time as today's Manila date at `clockInTime` / `clockOutTime`.
   - If `now < expected + MISSED_RUN_GRACE_MINUTES` → not late yet, skip. The grace window absorbs queue wait and a slow HRHub.
   - Look for a run for this user and action whose `startedAt` falls on today's Manila date (fetch the user's runs since `now - 24h` and filter with `manilaDateString(startedAt) === today` — this avoids timezone arithmetic in SQL). Found → nothing to do, whatever its status.
   - Not found → **insert into `missed_run_notices`** with `.onConflictDoNothing()` and `.returning()`. If nothing came back, another sweep already claimed it — return without sending.
   - A row came back → `dispatch(...)` the missed message.

The insert-then-send order is deliberate and mirrors D6: **the database decides who sends, not application logic.** Two overlapping sweeps, or a restart mid-sweep, cannot double-notify — the unique index on `(user_id, manila_date, action)` settles it. Never `SELECT` first and then insert.

```
🔴 <b>Clock-in did not run</b>
Expected 05:30 · Mon 10 Aug

No run was recorded today. The scheduler may have been asleep or the
server down. Clock in manually if you haven't already.
```

**Gate 6E:**
1. Unit: a schedule expecting 05:30 with `now` = 05:45 and no run → one notice row and one dispatch. Run the sweep again → still one notice row, no second dispatch.
2. Unit: a run exists today (any status, including `failure`) → no missed notice. A *failed* run already notified; it is not also missed.
3. Unit: weekend and holiday both short-circuit before any lookup.
4. Unit: `now` inside the grace window → nothing.
5. Integration: stop the backend before a near-future scheduled time, start it after the grace window, confirm exactly one missed notification.

---

## 6F — Settings routes + panel

### `GET /notifications` *(auth required)*

```ts
{
  enabled: boolean,
  telegramChatId: string | null,
  telegramTokenSet: boolean,        // NEVER the token itself
  notifyOnSuccess: boolean,
  notifyOnFailure: boolean,
  notifyOnSkipped: boolean,
  notifyOnMissed: boolean,
  configured: boolean,              // false until first PUT
  blockedCount: number
}
```

No row → all-default view with `configured: false`, exactly like `GET /schedule`.

### `PUT /notifications` *(partial update, `.strict()`)*

Same three-way semantics as `/credentials`: **omitted = unchanged, string = set, `null` = clear.**

```ts
telegramBotToken: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{20,}$/).max(200).nullable().optional(),
telegramChatId:   z.string().regex(/^-?\d{1,20}$/).nullable().optional(),
enabled:          z.boolean().optional(),
notifyOnSuccess:  z.boolean().optional(),   // …Failure, …Skipped, …Missed likewise
```

The token regex is a real guard, not cosmetics: the token is interpolated into a URL, so an unvalidated value is an SSRF / path-traversal vector. Empty body → `400 "No fields to update"`.

**Guard:** `enabled: true` is rejected with `400` unless a bot token and chat ID exist (in the payload or already stored). Enabling notifications that cannot possibly send is a silent lie.

**Counter reset:** setting `enabled` false→true, or changing either Telegram field, resets `blockedCount` to 0 — the user has evidently fixed something.

Audit `notification_settings_updated` with **which** fields changed and their new booleans. **Never** the token, never the chat ID value — `telegramChatIdSet: boolean` only.

### `POST /notifications/test` *(auth required)*

Per-user rate limit, 1 per 10s, using `express-rate-limit` v7:

```ts
const testLimiter = rateLimit({
  windowMs: 10_000,
  limit: 1,
  keyGenerator: (req) => `notif-test:${req.user?.id ?? "anon"}`,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Please wait a few seconds before testing again." },
});
```

> The v1 spec called this option `keyFn`. **That is wrong for v7 — it is `keyGenerator`.** A wrong key name silently falls back to IP keying, which would rate-limit every user behind one NAT together.

Flow: load settings → decrypt token → `getBotInfo()` to verify the token is real and belongs to a bot → send a test message naming the bot (`@username`) so the user can confirm they wired up the right one. Map `bad_token` / `blocked` to specific `400` messages; never echo a raw Telegram error.

### Frontend

`src/hooks/useNotifications.ts` (`useNotifications`, `useUpdateNotifications`, `useTestNotification`) and `src/components/panels/NotificationsPanel.tsx`, rendered in `Dashboard` after `SchedulePanel`.

Follow the **as-built CredentialsPanel pattern** — it already solved every problem this panel has:
- Bot token is an `InputGroup` with a reveal toggle, shows a `set` badge and `(unchanged)` placeholder when `telegramTokenSet`.
- **Only send the token if the user actually typed one.** Build a partial patch; if the field is untouched, omit it. Never send a masked placeholder string — that overwrites the real token with bullets.
- `save()` and `test()` are async → `await mutateAsync(...)` inside `try/catch` (⭐ the mutation rule).
- Four checkboxes for the outcome toggles, disabled while `enabled` is false.
- A collapsible "How do I set this up?" walkthrough: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token → message your new bot once → open `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy `chat.id`. Include the warning that the bot cannot message a user who has never messaged it first — that is the #1 cause of `chat not found`.
- Responsive: single column at 375px, per the Phase 3 `Platform: Web` rules.

**Gate 6F:**
1. `PUT` with a token → `GET` shows `telegramTokenSet: true` and **no token anywhere** in the response; `select telegram_bot_token_enc from notification_settings` is opaque base64url.
2. Save without touching the token field → the stored token survives.
3. `enabled: true` with no token → `400`.
4. Two `POST /notifications/test` within 10s → the second is `429`.
5. Test with a valid config → a message arrives naming the bot.
6. `grep -ri "botToken\|telegram_bot_token" --include=*.log` and the audit table contain no token value.

---

## Phase gate

All of 6A–6F green, plus the end-to-end proof:

1. Configure Telegram, enable all four outcome types.
2. Manual clock-in → ✅ message.
3. Clear Sprout credentials, manual run → ⚠️ failure message naming the reason.
4. Run again when already clocked → ℹ️ skipped message quoting the matched row.
5. Set a schedule two minutes out, stop the backend before it fires, restart after the grace window → 🔴 missed message, exactly one.
6. `pnpm typecheck && pnpm test` clean.

Tag `git tag phase-6-complete`.
