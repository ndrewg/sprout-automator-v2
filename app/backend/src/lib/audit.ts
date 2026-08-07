import { db } from "../db/client";
import { auditLog } from "../db/schema";
import { logger } from "./logger";

// The closed set of security-relevant events (per reference/database-schema.md).
export type AuditEventType =
  | "signup"
  | "signup_rejected"
  | "login_success"
  | "login_failure"
  | "logout"
  | "password_changed"
  | "credentials_updated"
  | "credentials_deleted"
  | "schedule_updated"
  | "notification_settings_updated"
  | "notification_auto_disabled"
  | "password_reset_requested"
  | "password_reset_completed";

export type AuditContext = {
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Records a security event. Best-effort: a failure here must never break the
 * request that triggered it. Never pass secret values in `metadata` — only
 * field names / non-reversible hashes (see the secrets rule, §03).
 */
export async function recordAudit(
  eventType: AuditEventType,
  ctx: AuditContext = {},
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      eventType,
      userId: ctx.userId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      metadata: ctx.metadata ?? null,
    });
  } catch (err: unknown) {
    logger.error({ err, eventType }, "recordAudit failed");
  }
}
