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
