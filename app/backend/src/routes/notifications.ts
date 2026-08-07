import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { notificationSettings, type NotificationSettings } from "../db/schema";
import { encrypt, decryptOptional } from "../lib/encryption";
import { recordAudit } from "../lib/audit";
import { requireAuth } from "../middleware/auth";
import { notificationsTestLimiter } from "../middleware/security";
import { escapeHtml, getBotInfo, sendTelegramMessage, type SendRetryConfig } from "../lib/telegram";

// Interactive request: a human is watching the "Testing…" button and can simply
// click again. Cap retries far below background dispatch's default 3×15s so a
// genuine failure fails fast instead of hanging the button for ~90s. The
// difference belongs here — background dispatch keeps the transport default
// (review defect 19).
const TEST_RETRY: SendRetryConfig = { maxAttempts: 2 };

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

type NotificationSettingsView = {
  enabled: boolean;
  telegramChatId: string | null;
  telegramTokenSet: boolean; // NEVER the token itself
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnSkipped: boolean;
  notifyOnMissed: boolean;
  configured: boolean; // false until first PUT
  blockedCount: number;
};

const EMPTY_VIEW: NotificationSettingsView = {
  enabled: false,
  telegramChatId: null,
  telegramTokenSet: false,
  notifyOnSuccess: true,
  notifyOnFailure: true,
  notifyOnSkipped: true,
  notifyOnMissed: true,
  configured: false,
  blockedCount: 0,
};

function toView(row: NotificationSettings | undefined): NotificationSettingsView {
  if (!row) return EMPTY_VIEW;
  return {
    enabled: row.enabled,
    telegramChatId: row.telegramChatId,
    telegramTokenSet: row.telegramBotTokenEnc != null,
    notifyOnSuccess: row.notifyOnSuccess,
    notifyOnFailure: row.notifyOnFailure,
    notifyOnSkipped: row.notifyOnSkipped,
    notifyOnMissed: row.notifyOnMissed,
    configured: true,
    blockedCount: row.blockedCount,
  };
}

const putSchema = z
  .object({
    telegramBotToken: z
      .string()
      .regex(/^\d{5,}:[A-Za-z0-9_-]{20,}$/)
      .max(200)
      .nullable()
      .optional(),
    telegramChatId: z.string().regex(/^-?\d{1,20}$/).nullable().optional(),
    enabled: z.boolean().optional(),
    notifyOnSuccess: z.boolean().optional(),
    notifyOnFailure: z.boolean().optional(),
    notifyOnSkipped: z.boolean().optional(),
    notifyOnMissed: z.boolean().optional(),
  })
  .strict();

notificationsRouter.get("/", async (req: Request, res: Response) => {
  const [row] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, req.user!.id))
    .limit(1);
  res.json({ settings: toView(row) });
});

// Partial update, three-way semantics (omitted = unchanged, string = set,
// null = clear) — the same contract as /credentials.
notificationsRouter.put("/", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;

  const [existing] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId))
    .limit(1);

  const setObj: Partial<typeof notificationSettings.$inferInsert> = {};
  const changed: string[] = [];
  if (data.telegramBotToken !== undefined) {
    setObj.telegramBotTokenEnc =
      data.telegramBotToken === null ? null : encrypt(data.telegramBotToken);
    changed.push("telegramBotToken");
  }
  if (data.telegramChatId !== undefined) {
    setObj.telegramChatId = data.telegramChatId;
    changed.push("telegramChatId");
  }
  if (data.enabled !== undefined) {
    setObj.enabled = data.enabled;
    changed.push("enabled");
  }
  if (data.notifyOnSuccess !== undefined) {
    setObj.notifyOnSuccess = data.notifyOnSuccess;
    changed.push("notifyOnSuccess");
  }
  if (data.notifyOnFailure !== undefined) {
    setObj.notifyOnFailure = data.notifyOnFailure;
    changed.push("notifyOnFailure");
  }
  if (data.notifyOnSkipped !== undefined) {
    setObj.notifyOnSkipped = data.notifyOnSkipped;
    changed.push("notifyOnSkipped");
  }
  if (data.notifyOnMissed !== undefined) {
    setObj.notifyOnMissed = data.notifyOnMissed;
    changed.push("notifyOnMissed");
  }

  if (changed.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  // Enabling notifications that cannot possibly send is a silent lie: enabled
  // requires both a bot token and a chat ID, either in this payload or already
  // stored.
  const newEnabled = data.enabled ?? existing?.enabled ?? false;
  const hasToken =
    data.telegramBotToken !== undefined
      ? data.telegramBotToken !== null
      : existing?.telegramBotTokenEnc != null;
  const hasChatId =
    data.telegramChatId !== undefined
      ? data.telegramChatId !== null
      : existing?.telegramChatId != null;
  if (newEnabled && (!hasToken || !hasChatId)) {
    res.status(400).json({
      error: "Set a Telegram bot token and chat ID before enabling notifications.",
    });
    return;
  }

  // Re-enabling, or touching either Telegram field, resets the blocked count —
  // the user has evidently fixed something.
  const telegramFieldChanged =
    changed.includes("telegramBotToken") || changed.includes("telegramChatId");
  const enablingFromOff = data.enabled === true && existing?.enabled === false;
  if (telegramFieldChanged || enablingFromOff) {
    setObj.blockedCount = 0;
  }

  let row: NotificationSettings | undefined;
  if (existing) {
    [row] = await db
      .update(notificationSettings)
      .set({ ...setObj, updatedAt: new Date() })
      .where(eq(notificationSettings.userId, userId))
      .returning();
  } else {
    // Lazy opt-in: the DB default for enabled is false, so a fresh insert with
    // no `enabled` stays off. Never auto-notify someone who hasn't asked.
    [row] = await db
      .insert(notificationSettings)
      .values({ userId, ...setObj })
      .returning();
  }
  if (!row) throw new Error("notifications upsert returned no row");

  // Audit which fields changed and their new booleans. NEVER the token, NEVER
  // the chat ID value — set-booleans only (secrets rule, §03).
  const metadata: Record<string, unknown> = { fields: changed };
  for (const f of changed) {
    if (f === "telegramBotToken") {
      metadata["telegramTokenSet"] = data.telegramBotToken !== null;
    } else if (f === "telegramChatId") {
      metadata["telegramChatIdSet"] = data.telegramChatId !== null;
    } else if (f === "enabled") {
      metadata["enabled"] = data.enabled;
    } else if (f === "notifyOnSuccess") {
      metadata["notifyOnSuccess"] = data.notifyOnSuccess;
    } else if (f === "notifyOnFailure") {
      metadata["notifyOnFailure"] = data.notifyOnFailure;
    } else if (f === "notifyOnSkipped") {
      metadata["notifyOnSkipped"] = data.notifyOnSkipped;
    } else if (f === "notifyOnMissed") {
      metadata["notifyOnMissed"] = data.notifyOnMissed;
    }
  }
  await recordAudit("notification_settings_updated", {
    userId,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    metadata,
  });

  res.json({ settings: toView(row) });
});

// Per-user, 1 / 10s: verify the token is real, then send a message naming the
// bot so the user can confirm they wired up the right one.
notificationsRouter.post(
  "/test",
  notificationsTestLimiter,
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const [row] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, userId))
      .limit(1);
    const token = row ? decryptOptional(row.telegramBotTokenEnc) : null;
    const chatId = row?.telegramChatId ?? null;
    if (!token || !chatId || !/^-?\d+$/.test(chatId)) {
      res.status(400).json({
        error: "Set your Telegram bot token and chat ID before testing.",
      });
      return;
    }

    const info = await getBotInfo(token, TEST_RETRY);
    if (!info.ok) {
      if (info.error === "bad_token") {
        res.status(400).json({
          error: "The bot token is invalid. Copy it again from BotFather.",
        });
        return;
      }
      if (info.error === "network") {
        res.status(400).json({
          error: "Could not reach Telegram. Check the server's network connectivity.",
        });
        return;
      }
      res.status(400).json({ error: "Telegram rejected the bot token." });
      return;
    }

    const username = `@${info.username}`;
    const html = `Sprout Automator test — connected to <b>${escapeHtml(username)}</b>`;
    const sent = await sendTelegramMessage(token, chatId, html, TEST_RETRY);
    if (!sent.ok) {
      if (sent.error === "blocked") {
        res.status(400).json({
          error:
            "This chat is blocked or the chat ID is wrong. Message the bot first, then retry.",
        });
        return;
      }
      res.status(400).json({
        error: "Message could not be sent. Double-check the chat ID.",
      });
      return;
    }

    res.json({ ok: true, botUsername: username });
  },
);
