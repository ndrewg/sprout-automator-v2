import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { credentials, type Credential } from "../db/schema";
import { encrypt, decryptOptional } from "../lib/encryption";
import { recordAudit } from "../lib/audit";
import { requireAuth } from "../middleware/auth";
import { testImapConnection } from "../lib/imap-otp";

export const credentialsRouter = Router();
credentialsRouter.use(requireAuth);

type CredentialView = {
  sproutUsername: string | null;
  sproutPasswordSet: boolean;
  gmailEmail: string | null;
  gmailAppPasswordSet: boolean;
  updatedAt: string | null;
};

const EMPTY_VIEW: CredentialView = {
  sproutUsername: null,
  sproutPasswordSet: false,
  gmailEmail: null,
  gmailAppPasswordSet: false,
  updatedAt: null,
};

// Only the two non-secret fields are ever decrypted for display; passwords are
// exposed solely as `*Set` booleans. NEVER return a decrypted password.
function toView(row: Credential | undefined): CredentialView {
  if (!row) return EMPTY_VIEW;
  return {
    sproutUsername: decryptOptional(row.sproutUsernameEnc),
    sproutPasswordSet: row.sproutPasswordEnc != null,
    gmailEmail: decryptOptional(row.gmailEmailEnc),
    gmailAppPasswordSet: row.gmailAppPasswordEnc != null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

const putSchema = z
  .object({
    sproutUsername: z.union([z.string().min(1).max(200), z.null()]).optional(),
    sproutPassword: z.union([z.string().min(1).max(200), z.null()]).optional(),
    gmailEmail: z.union([z.string().email().max(254), z.null()]).optional(),
    gmailAppPassword: z
      .union([z.string().min(1).max(200), z.null()])
      .optional(),
  })
  .strict();

function clientInfo(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

async function loadRow(userId: string): Promise<Credential | undefined> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .limit(1);
  return row;
}

credentialsRouter.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const row = await loadRow(userId);
  res.json({ credentials: toView(row) });
});

credentialsRouter.put("/", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;

  // Map each PRESENT field: string → encrypt & set; null → clear.
  // (Omitted fields are absent from `data` and left unchanged.)
  // A field is "present" iff it's not undefined (JSON can't carry undefined, so
  // omitted = undefined = leave unchanged; this also narrows the type to
  // string | null for `encrypt`).
  const setObj: Partial<typeof credentials.$inferInsert> = {};
  const changed: string[] = [];
  if (data.sproutUsername !== undefined) {
    setObj.sproutUsernameEnc = data.sproutUsername === null ? null : encrypt(data.sproutUsername);
    changed.push("sproutUsername");
  }
  if (data.sproutPassword !== undefined) {
    setObj.sproutPasswordEnc = data.sproutPassword === null ? null : encrypt(data.sproutPassword);
    changed.push("sproutPassword");
  }
  if (data.gmailEmail !== undefined) {
    setObj.gmailEmailEnc = data.gmailEmail === null ? null : encrypt(data.gmailEmail);
    changed.push("gmailEmail");
  }
  if (data.gmailAppPassword !== undefined) {
    setObj.gmailAppPasswordEnc = data.gmailAppPassword === null ? null : encrypt(data.gmailAppPassword);
    changed.push("gmailAppPassword");
  }

  if (changed.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const existing = await loadRow(userId);
  let row: Credential | undefined;
  if (existing) {
    [row] = await db
      .update(credentials)
      .set({ ...setObj, updatedAt: new Date() })
      .where(eq(credentials.userId, userId))
      .returning();
  } else {
    [row] = await db
      .insert(credentials)
      .values({ userId, ...setObj })
      .returning();
  }
  if (!row) throw new Error("credentials upsert returned no row");

  await recordAudit("credentials_updated", {
    ...clientInfo(req),
    userId,
    metadata: { fields: changed },
  });
  res.json({ credentials: toView(row) });
});

credentialsRouter.post("/test-imap", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const row = await loadRow(userId);
  const email = row ? decryptOptional(row.gmailEmailEnc) : null;
  const appPassword = row ? decryptOptional(row.gmailAppPasswordEnc) : null;
  if (!email || !appPassword) {
    res.status(400).json({ error: "Set gmailEmail and gmailAppPassword first." });
    return;
  }
  const result = await testImapConnection({ email, appPassword });
  if (result.ok) {
    res.json({ ok: true, messageCount: result.messageCount });
    return;
  }
  res.status(400).json({ ok: false, error: result.error });
});

credentialsRouter.delete("/", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  await db
    .update(credentials)
    .set({
      sproutUsernameEnc: null,
      sproutPasswordEnc: null,
      gmailEmailEnc: null,
      gmailAppPasswordEnc: null,
      updatedAt: new Date(),
    })
    .where(eq(credentials.userId, userId));
  await recordAudit("credentials_deleted", {
    ...clientInfo(req),
    userId,
    metadata: { fields: ["deleted_all"] },
  });
  res.json({ ok: true });
});
