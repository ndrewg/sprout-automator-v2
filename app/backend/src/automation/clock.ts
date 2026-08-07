// Reads the Attendance card on the dashboard and checks whether today already
// has an IN or OUT entry, then performs the 4-step clock action against the
// bootbox dialogs.

import type { Page } from "playwright";
import { manilaDateString } from "../lib/ph-holidays";
import { screenshot } from "./screenshot";

export type ClockAction = "in" | "out";

export type ClockActionResult = {
  success: boolean;
  message?: string;
  error?: string;
};

/**
 * Returns whether today already has a row for the action we're about to
 * perform (skip), with the reason. Fail-safe: any unexpected condition returns
 * skipped: true — better to miss one auto-clock than to accidentally
 * double-clock. `reason` is the message already logged to the run's steps, so
 * the notifier can distinguish "matched row" (benign) from "could not verify"
 * (the user is probably NOT clocked in).
 */
export async function isAlreadyClockedForToday(
  page: Page,
  action: ClockAction,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<{ skipped: boolean; reason: string }> {
  const label = action === "in" ? "IN" : "OUT";
  const actionRegex = new RegExp(`\\b${label}\\b`);

  const iso = manilaDateString(new Date()); // e.g. "2026-05-28"
  const parts = iso.split("-");
  const yyyy = parts[0]!;
  const mm = parts[1]!;
  const dd = parts[2]!;
  const yy = yyyy.slice(-2);

  const todayCandidates = [
    `${mm}/${dd}/${yy}`, // 05/28/26
    `${Number(mm)}/${Number(dd)}/${yy}`, // 5/28/26
    `${yyyy}-${mm}-${dd}`, // 2026-05-28 ISO
  ];

  try {
    const attendanceSection = page
      .locator("text=Attendance")
      .locator(
        "xpath=ancestor::*[contains(@class,'card') or contains(@class,'Card') or contains(@class,'panel') or contains(@class,'widget') or contains(@class,'section')]",
      )
      .first();

    let containerText: string;
    if (await attendanceSection.isVisible().catch(() => false)) {
      containerText = await attendanceSection.innerText();
    } else {
      const reason = `Could not locate Attendance card. Skipping ${label} as a safety measure.`;
      log?.(reason);
      await screenshot(page, userId, runId, "already-clocked-check-no-card");
      return { skipped: true, reason };
    }

    const lines = containerText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const matchedLine = lines.find(
      (line) =>
        todayCandidates.some((d) => line.includes(d)) && actionRegex.test(line),
    );

    await screenshot(page, userId, runId, "already-clocked-check");

    if (matchedLine) {
      const reason = `Already clocked ${label} today (matched row "${matchedLine}") — skipping.`;
      log?.(reason);
      return { skipped: true, reason };
    }

    const reason = `No ${label} row found for ${todayCandidates[0]} — proceeding with clock action.`;
    log?.(reason);
    return { skipped: false, reason };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `Could not verify clock state (${msg}). Skipping ${label} as a safety measure.`;
    log?.(reason);
    await screenshot(page, userId, runId, "already-clocked-check-error").catch(
      () => {},
    );
    return { skipped: true, reason };
  }
}

export async function performClockAction(
  page: Page,
  action: ClockAction,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<ClockActionResult> {
  const actionLabel = action === "in" ? "Clock In" : "Clock Out";

  // Step 1: open dropdown — desktop button preferred, mobile fallback
  log?.("Opening clock action dropdown...");
  const dskBtn = page.locator(".clock-in-out-dropdown .dsk-btn").first();
  const mblBtn = page.locator(".clock-in-out-dropdown .mbl-btn").first();
  if (await dskBtn.isVisible().catch(() => false)) {
    await dskBtn.click();
  } else if (await mblBtn.isVisible().catch(() => false)) {
    await mblBtn.click();
  } else {
    throw new Error(
      "Neither .dsk-btn nor .mbl-btn found in .clock-in-out-dropdown",
    );
  }
  await page.waitForTimeout(500);
  await screenshot(page, userId, runId, `${action}-dropdown-opened`);

  // Step 2: click the action <a> inside the dropdown menu
  log?.(`Selecting dropdown menu option: ${actionLabel}...`);
  const menuLink = page
    .locator(".clock-in-out-dropdown .dropdown-menu a")
    .filter({ hasText: actionLabel });
  await menuLink.waitFor({ state: "visible", timeout: 5000 });
  await menuLink.click();

  // Step 3: bootbox confirmation — "Yes" button
  log?.("Waiting for Sprout confirmation dialog...");
  const dialogClass =
    action === "in" ? ".clock-in-dialog" : ".clock-out-dialog";
  const yesBtn = page.locator(`${dialogClass} .our-button`);
  await yesBtn.waitFor({ state: "visible", timeout: 15000 });
  await screenshot(page, userId, runId, `${action}-confirmation-modal`);
  log?.("Clicking confirmation button...");
  await yesBtn.click();

  // Step 4: success bootbox alert (different titles for in vs out)
  log?.("Waiting for portal success response...");
  const successTitle =
    action === "in" ? "Time Entry Confirmation" : "Clocking Status Update";
  const successDialog = page
    .locator(`${dialogClass} .modal-title`)
    .filter({ hasText: successTitle });

  const successAppeared = await successDialog
    .waitFor({ state: "visible", timeout: 30000 })
    .then(() => true)
    .catch(() => false);

  if (successAppeared) {
    const bodyText = await page
      .locator(`${dialogClass} .bootbox-body`)
      .innerText()
      .catch(() => "");
    await screenshot(page, userId, runId, `${action}-success`);
    const okBtn = page.locator(`${dialogClass} .btn-primary`);
    if (await okBtn.isVisible().catch(() => false)) {
      await okBtn.click();
    }
    return { success: true, message: bodyText.trim() };
  }

  // Error dialog path
  const errorBody = await page
    .locator(`${dialogClass} .bootbox-body`)
    .innerText()
    .catch(() => "");
  if (errorBody) {
    await screenshot(page, userId, runId, `${action}-error-dialog`);
    const okBtn = page.locator(`${dialogClass} .btn-primary`);
    if (await okBtn.isVisible().catch(() => false)) {
      await okBtn.click();
    }
    return { success: false, error: errorBody.trim() };
  }

  await screenshot(page, userId, runId, `${action}-no-success-modal`);
  return {
    success: false,
    error: "Clock action completed but no confirmation dialog appeared",
  };
}
