import "./env";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? "8080"}`;

async function authenticate(page: Page, api: TestApiClient) {
  const token = api.getToken();
  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, token);
}

async function apiFetch(api: TestApiClient, slug: string, path: string, init?: RequestInit) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${api.getToken()}`,
      "X-Workspace-Slug": slug,
    },
  });
}

// The draft rules (ownership, merge, confirmation) live in the Go handler
// tests. This covers the browser path: the form dialog's autosave, the pending
// list, and a draft card posted in a comment.
test("agent drafts: form autosave, finish later, and confirm from a comment card", async ({ page }) => {
  test.setTimeout(120_000);
  const api = await createTestApi();
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  let runtimeId: string | undefined;
  try {
    const workspace = (await api.getWorkspaces())[0]!;
    const user = await db.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [api.getEmail()]);
    const runtime = await db.query<{ id: string }>(
      `INSERT INTO agent_runtime (workspace_id, name, runtime_mode, provider, status, device_info, metadata, owner_id, last_seen_at)
       VALUES ($1, 'Agent draft verification', 'cloud', 'e2e_agent_drafts', 'online', 'E2E fixture', '{}'::jsonb, $2, now()) RETURNING id`,
      [workspace.id, user.rows[0]!.id],
    );
    runtimeId = runtime.rows[0]!.id;

    await authenticate(page, api);

    // The legacy create route lands on the agents page with the form open.
    await page.goto(`/${workspace.slug}/agents/new/manual`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/agents\?create=1/, { timeout: 30_000 });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeVisible({ timeout: 30_000 });

    // Typing a name creates the server draft and moves the URL onto it.
    const formName = `Form Draft ${Date.now().toString(36)}`;
    await dialog.getByRole("textbox", { name: "Name" }).fill(formName);
    await expect(page).toHaveURL(/\/agents\?draft=[0-9a-f-]+/, { timeout: 15_000 });
    await dialog.getByRole("button", { name: "Finish later" }).click();
    await expect(dialog).toBeHidden();

    // It now waits in the pending list; its row reopens it with the name kept.
    const pending = page.getByRole("region", { name: "Waiting for you to confirm" });
    await expect(pending.getByText(formName)).toBeVisible({ timeout: 15_000 });
    await pending.getByRole("button", { name: new RegExp(formName) }).click();
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "Name" })).toHaveValue(formName);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // A draft posted in a comment renders as a card the owner edits and
    // confirms in place.
    const cardName = `Card Draft ${Date.now().toString(36)}`;
    const created = await apiFetch(api, workspace.slug, "/api/agent-drafts", {
      method: "POST",
      body: JSON.stringify({ config: { name: cardName, description: "Drafted in a comment", runtime_id: runtimeId } }),
    });
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string; mention: string };
    const issue = await api.createIssue("Agent draft card verification");
    await api.createComment(issue.id, `Here is the proposal:\n\n${draft.mention}\n`);

    await page.goto(`/${workspace.slug}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });
    const card = page.locator("[data-agent-draft-card]");
    await expect(card.getByText(cardName)).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: "Expand to review" }).click();
    const description = card.getByRole("textbox", { name: "Description" });
    await description.fill("Edited inside the card");
    await expect
      .poll(async () => {
        const res = await apiFetch(api, workspace.slug, `/api/agent-drafts/${draft.id}`);
        return ((await res.json()) as { config: { description: string } }).config.description;
      }, { timeout: 15_000 })
      .toBe("Edited inside the card");
    await card.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/issues\//);
    await expect(card.getByRole("link", { name: "Open agent" })).toBeVisible({ timeout: 15_000 });
  } finally {
    await api.cleanup();
    await db.query(`DELETE FROM agent_draft WHERE workspace_id IN (SELECT workspace_id FROM agent_runtime WHERE id = $1)`, [runtimeId ?? null]);
    await db.query(`DELETE FROM agent WHERE runtime_id = $1`, [runtimeId ?? null]);
    if (runtimeId) await db.query(`DELETE FROM agent_runtime WHERE id = $1`, [runtimeId]);
    await db.end();
  }
});
