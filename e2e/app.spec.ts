import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/materials", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { materials: [] } });
    } else {
      await route.fulfill({ status: 201, json: { pages: 1, chunks: 2, facts: [] } });
    }
  });
  await page.route("**/api/interviews", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { interviews: [] } });
    } else {
      await route.fulfill({ status: 201, json: {
        interview: { id: "7a65ab08-03a7-4ec7-9359-a2ff4670ddea", status: "ready" },
        plan: [],
      } });
    }
  });
});

test("configures a 10/20/30 minute interview and shows the enforced plan", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "今天，练一次真正的面试" })).toBeVisible();
  await page.getByRole("button", { name: "30分钟" }).click();
  await expect(page.getByText("30 min", { exact: true })).toBeVisible();
  await expect(page.getByText("综合与收尾")).toBeVisible();
  await expect(page.getByText("最后一分钟强制收尾")).toBeVisible();
});

test("uploads a local material without navigating away", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await expect(page.getByRole("heading", { name: "材料与个人画像" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "resume.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 简历\n专业排名：3/80"),
  });
  await page.getByRole("button", { name: /本地解析并建立索引/ }).click();
  await expect(page.getByText(/已解析 1 页/)).toBeVisible();
});
test("material library explains an exact duplicate", async ({ page }) => {
  await page.route("**/api/materials", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { materials: [], facts: [] } });
      return;
    }
    await route.fulfill({
      status: 409,
      json: {
        error: "该材料已上传",
        duplicateMaterial: { id: "material-1", name: "jianli.pdf", createdAt: 1_767_225_600_000 },
      },
    });
  });

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "duplicate.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("same material"),
  });
  await page.getByRole("button", { name: /本地解析并建立索引/ }).click();
  await expect(page.locator(".notice")).toContainText(/^已存在相同材料：jianli\.pdf（.+）/);
});

test("material library deletes a material and its local state immediately", async ({ page }) => {
  const material = {
    id: "material-1", name: "jianli.pdf", category: "personal", status: "ready",
    parseStatus: "complete", createdAt: 1_767_225_600_000,
  };
  const fact = {
    id: "fact-1", materialId: material.id, field: "专业排名", value: "3/80",
    source: "jianli.pdf", confidence: 0.98, confirmed: false,
  };
  let deleted = false;
  let deleteMethod = "";

  await page.route("**/api/materials", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (deleted) return;
    await route.fulfill({ json: { materials: [material], facts: [fact] } });
  });
  await page.route("**/api/materials/material-1", async (route) => {
    deleteMethod = route.request().method();
    deleted = true;
    await route.fulfill({ json: { deletedId: material.id, cleanupPending: false } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: `引用材料 ${material.name}` }).click();
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("永久删除“jianli.pdf”及其画像事实？");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "删除 jianli.pdf" }).click();

  await expect(page.getByText("jianli.pdf", { exact: true })).toHaveCount(0);
  await expect(page.getByText("专业排名", { exact: true })).toHaveCount(0);
  expect(deleteMethod).toBe("DELETE");
  await page.locator("nav").getByRole("button", { name: /训练台/ }).click();
  await expect(page.getByRole("button", { name: `引用材料 ${material.name}` })).toHaveCount(0);
});

test("material library retries basic-only smart parsing and refreshes facts", async ({ page }) => {
  const material = {
    id: "material-1", name: "jianli.pdf", category: "personal", status: "ready",
    parseStatus: "basic_only", createdAt: 1_767_225_600_000,
  };
  let retried = false;
  let finishRetry: (() => void) | undefined;
  const retryGate = new Promise<void>((resolve) => { finishRetry = resolve; });

  await page.route("**/api/materials", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        materials: [{ ...material, parseStatus: retried ? "complete" : "basic_only" }],
        facts: retried ? [{
          id: "fact-smart", materialId: material.id, field: "科研项目",
          value: "低照度图像增强", source: "jianli.pdf", confidence: 0.91, confirmed: false,
        }] : [],
      },
    });
  });
  await page.route("**/api/materials/material-1/retry", async (route) => {
    await retryGate;
    retried = true;
    await route.fulfill({ json: { materialId: material.id, parseStatus: "complete", factsAdded: 1 } });
  });

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await expect(page.getByText("智能解析待重试", { exact: true })).toBeVisible();
  const retryButton = page.getByRole("button", { name: "重试智能解析 jianli.pdf" });
  await retryButton.click();
  await expect(retryButton).toBeDisabled();
  finishRetry?.();

  await expect(page.getByRole("textbox", { name: "" }).last()).toHaveValue("低照度图像增强");
  await expect(page.getByText("智能解析待重试", { exact: true })).toHaveCount(0);
});
