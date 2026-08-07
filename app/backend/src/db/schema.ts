import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
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
  // Inclusive Manila-calendar-day range during which automation is suppressed
  // (phase 7). date, not timestamp: these are calendar days, not instants, and
  // YYYY-MM-DD strings compare correctly with <= / >=. Both set or both null.
  pausedFrom: date("paused_from"),
  pausedUntil: date("paused_until"),
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type MissedRunNotice = typeof missedRunNotices.$inferSelect;
