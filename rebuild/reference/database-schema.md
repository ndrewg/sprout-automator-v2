# Reference — Database Schema

This is the complete, canonical Drizzle schema. **Reproduce `src/db/schema.ts` verbatim.** Then generate the migration from it (`pnpm db:generate --name init` — no `--` separator on pnpm 11), review the SQL, and commit both.

Attach this file to **Phase 1**.

---

## `src/db/schema.ts` (copy verbatim)

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// users — authentication identity
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
  }),
);

// sessions — server-side session store (cookie holds only the id)
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

// credentials — one row per user, holds encrypted Sprout + Gmail credentials
export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  // Encrypted blobs — format defined by lib/encryption.ts (AES-256-GCM)
  sproutUsernameEnc: text("sprout_username_enc"),
  sproutPasswordEnc: text("sprout_password_enc"),
  gmailEmailEnc: text("gmail_email_enc"),
  gmailAppPasswordEnc: text("gmail_app_password_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// schedules — per-user clock-in/out times
export const schedules = pgTable("schedules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  clockInTime: time("clock_in_time").notNull().default("05:30:00"),
  clockOutTime: time("clock_out_time").notNull().default("18:05:00"),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// runs — history of every automation execution
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action", { enum: ["in", "out"] }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "success", "skipped", "failure"],
    })
      .notNull()
      .default("pending"),
    loginMethod: text("login_method"),
    error: text("error"),
    steps: jsonb("steps")
      .$type<{ timestamp: string; message: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("runs_user_idx").on(t.userId),
    startedIdx: index("runs_started_idx").on(t.startedAt),
    // DB-level guarantee: at most one pending/running run per user.
    activeUnique: uniqueIndex("runs_one_active_per_user")
      .on(t.userId)
      .where(sql`status IN ('pending', 'running')`),
  }),
);

// audit_log — security-relevant events
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("audit_user_idx").on(t.userId),
    eventIdx: index("audit_event_idx").on(t.eventType),
    createdIdx: index("audit_created_idx").on(t.createdAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
```

## `src/db/client.ts` (copy verbatim)

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config";
import * as schema from "./schema";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
```

## `src/db/migrate.ts` (copy verbatim)

```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client";

async function main(): Promise<void> {
  console.log("[migrate] running migrations from ./drizzle …");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] done");
  await pool.end();
}

main().catch((err: unknown) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
```

---

## Critical schema invariants (the model must not "simplify" these away)

1. **`users_email_unique` is on `lower(email)`**, not `email`. Case-insensitive uniqueness. Lookups must also use `lower(...)`.
2. **`runs_one_active_per_user` is a PARTIAL unique index** with `WHERE status IN ('pending','running')`. This is the entire race-protection mechanism (D6). It must appear in the generated migration — verify it does.
3. **`credentials.userId` and `schedules.userId` are `.unique()`** — exactly one row per user.
4. **`audit_log.userId` is `ON DELETE SET NULL`**; every other FK to `users` is `ON DELETE CASCADE`. Audit entries outlive the account.
5. **`steps` defaults to `'[]'::jsonb` and is `NOT NULL`.** Run-step appends use `steps || '[...]'::jsonb`.
6. **All timestamps are `withTimezone: true`** (`timestamptz`).
7. `action` and `status` are text columns with **enum constraints** baked into the column definition.

## Audit event types (the closed set used by `lib/audit.ts`)

```
signup | login_success | login_failure | logout
password_changed | credentials_updated | schedule_updated
```
⚑ RECOMMENDED: add `credentials_deleted` (as-built reuses `credentials_updated` with `fields:["deleted_all"]`), and (if you do Phase-4 email flows) `email_verified`, `password_reset_requested`, `password_reset_completed`, `account_deleted`.
