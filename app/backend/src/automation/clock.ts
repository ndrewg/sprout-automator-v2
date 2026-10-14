// Performs the 4-step clock action against the bootbox dialogs.
//
// The already-clocked guard that used to live here is GONE (phase 17): reading
// the attendance card, deciding whether to act at all, and deciding what the
// result means are now the orchestration's job (clock-attempt.ts) and the
// parser's (attendance-card.ts), because none of them was testable while it was
// Playwright code. What remains here is the part that genuinely needs a Page.
//
// EVERY selector, wait and screenshot below is verbatim from the playbook
// (reference/hrhub-automation-playbook.md) and re-confirmed against the live
// dashboard markup on 2026-10-14:
//   .clock-in-out-dropdown .dsk-btn / .mbl-btn -> .dropdown-menu a (Clock In/Out)
//   -> .clock-in-dialog|.clock-out-dialog .our-button ("Yes")
//   -> .clock-in-dialog|.clock-out-dialog .modal-title
//      ("Time Entry Confirmation" / "Clocking Status Update") -> .btn-primary
// AGENTS.md rule 10: do not tidy this file.

import type { Page } from "playwright";
import type { ClockAction, ClockPressResult } from "./portal-seam";
import { screenshot } from "./screenshot";

export type { ClockAction };

export async function performClockAction(
  page: Page,
  action: ClockAction,
  userId: string,
  runId: string,
  log?: (message: string) => void,
): Promise<ClockPressResult> {
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
    // Reported, not believed: the orchestration re-reads the card and the ROW
    // decides. HRHub has been known to render a success dialog for an action
    // the server did not perform (playbook invariant 4).
    return { outcome: "confirmed", message: bodyText.trim() || null };
  }

  // Error dialog path. HRHub's failure alert uses the SAME container class but
  // a different title ("Clock In"/"Clock Out") and puts the server's message in
  // the body — verified in the live markup 2026-10-14. No success title plus a
  // non-empty body is therefore an explicit error, not a missing dialog.
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
    return { outcome: "error_dialog", error: errorBody.trim() };
  }

  await screenshot(page, userId, runId, `${action}-no-success-modal`);
  return { outcome: "no_dialog" };
}
