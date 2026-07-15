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

test("material deletion shows a notice when the server returns non-JSON", async ({ page }) => {
  const material = {
    id: "material-error", name: "keep-me.pdf", category: "personal", status: "ready",
    parseStatus: "complete", createdAt: 1_767_225_600_000,
  };
  await page.route("**/api/materials", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { materials: [material], facts: [] } });
    else await route.fallback();
  });
  await page.route("**/api/materials/material-error", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/html", body: "<h1>server exploded</h1>" });
  });

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除 keep-me.pdf" }).click();

  await expect(page.getByRole("status")).toContainText("材料删除失败，请稍后重试");
  await expect(page.getByText("keep-me.pdf", { exact: true })).toBeVisible();
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
    expect(route.request().method()).toBe("POST");
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

test("detailed experience edits, confirms, becomes read-only, and follows material deletion", async ({ page }) => {
  const material = {
    id: "material-detail", name: "super-lora.pdf", category: "personal", status: "ready",
    parseStatus: "complete", createdAt: 1_767_225_600_000,
  };
  const baseExperience = {
    id: "experience-detail", materialId: material.id, type: "research", title: "Super-LoRa",
    background: "传统 LoRa 吞吐量受限", responsibilities: "负责算法设计",
    methods: "并行干扰消除", results: "吞吐量提升 1.2 倍", awardRole: "第一作者",
    source: material.name, page: 2, evidence: { title: "Super-LoRa" }, confidence: 0.93,
    status: "draft", createdAt: 1_767_225_600_000, updatedAt: 1_767_225_600_000,
  };
  let confirmed = false;
  let deleted = false;
  let releaseDeleteRefresh: (() => void) | undefined;
  const deleteRefreshGate = new Promise<void>((resolve) => { releaseDeleteRefresh = resolve; });
  let confirmBody: Record<string, unknown> | undefined;

  await page.route("**/api/materials", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (deleted) {
      await deleteRefreshGate;
      await route.fulfill({ json: { materials: [], facts: [], experiences: [] } });
      return;
    }
    await route.fulfill({ json: {
      materials: [material], facts: [],
      experiences: [{ ...baseExperience, status: confirmed ? "confirmed" : "draft" }],
    } });
  });
  await page.route("**/api/experiences/experience-detail/confirm", async (route) => {
    expect(route.request().method()).toBe("POST");
    confirmBody = route.request().postDataJSON();
    confirmed = true;
    await route.fulfill({ json: { experience: { ...baseExperience, ...confirmBody, status: "confirmed" } } });
  });
  await page.route("**/api/materials/material-detail", async (route) => {
    deleted = true;
    await route.fulfill({ json: { deletedId: material.id, cleanupPending: false } });
  });

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await page.locator("summary").filter({ hasText: "Super-LoRa" }).click();
  await page.getByLabel("量化成果").fill("吞吐量提升 1.35 倍");
  await page.getByRole("button", { name: "确认整段经历" }).click();

  await expect(page.getByRole("button", { name: "重新编辑" })).toBeVisible();
  await expect(page.getByLabel("量化成果")).toHaveCount(0);
  expect(confirmBody).toMatchObject({ results: "吞吐量提升 1.35 倍" });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `删除 ${material.name}` }).click();
  await expect(page.getByText(material.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Super-LoRa", { exact: true })).toHaveCount(0);
  releaseDeleteRefresh?.();
});
test("re-extracts detailed experiences from a complete personal material", async ({ page }) => {
  const material = {
    id: "material-old", name: "old-resume.pdf", category: "personal", status: "ready",
    parseStatus: "complete", createdAt: 1_735_689_600_000,
  };
  const extractedExperience = {
    id: "experience-old", materialId: material.id, type: "project", title: "旧简历项目",
    background: "历史材料", responsibilities: "负责实现", methods: "原型验证",
    results: "准确率 95%", awardRole: "负责人", source: material.name, page: 1,
    evidence: { title: "旧简历项目" }, confidence: 0.88, status: "draft",
    createdAt: 1_767_225_600_000, updatedAt: 1_767_225_600_000,
  };
  let retried = false;
  let retryMethod = "";

  await page.route("**/api/materials", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: {
      materials: [material], facts: [], experiences: retried ? [extractedExperience] : [],
    } });
  });
  await page.route("**/api/materials/material-old/retry", async (route) => {
    retryMethod = route.request().method();
    retried = true;
    await route.fulfill({ json: { materialId: material.id, parseStatus: "complete", experiencesAdded: 1 } });
  });

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await page.getByRole("button", { name: `重新提取详细经历 ${material.name}` }).click();

  expect(retryMethod).toBe("POST");
  await expect(page.locator("summary").filter({ hasText: "旧简历项目" })).toBeVisible();
});

test("detailed experience save shows a notice when fetch rejects", async ({ page }) => {
  const material = { id: "material-fail", name: "fail.pdf", category: "personal", status: "ready", parseStatus: "complete", createdAt: 1 };
  const experience = { id: "experience-fail", materialId: material.id, type: "research", title: "失败边界项目", background: "背景", responsibilities: "职责", methods: "方法", results: "结果", awardRole: "角色", source: material.name, page: 1, evidence: { title: "失败边界项目" }, confidence: 0.8, status: "draft", createdAt: 1, updatedAt: 1 };
  await page.route("**/api/materials", (route) => route.request().method() === "GET" ? route.fulfill({ json: { materials: [material], facts: [], experiences: [experience] } }) : route.fallback());
  await page.route("**/api/experiences/experience-fail", (route) => route.abort("failed"));

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await page.locator("summary").filter({ hasText: "失败边界项目" }).click();
  await page.getByRole("button", { name: "保存修改" }).click();

  await expect(page.getByRole("status")).toContainText("详细经历保存失败，请检查网络后重试");
  await expect(page.getByLabel("量化成果")).toBeVisible();
});
test("detailed experience confirm handles a non-JSON error response", async ({ page }) => {
  const material = { id: "material-confirm-fail", name: "confirm.pdf", category: "personal", status: "ready", parseStatus: "complete", createdAt: 1 };
  const experience = { id: "experience-confirm-fail", materialId: material.id, type: "project", title: "确认失败项目", background: "背景", responsibilities: "职责", methods: "方法", results: "结果", awardRole: "角色", source: material.name, page: 1, evidence: { title: "确认失败项目" }, confidence: 0.8, status: "draft", createdAt: 1, updatedAt: 1 };
  await page.route("**/api/materials", (route) => route.request().method() === "GET" ? route.fulfill({ json: { materials: [material], facts: [], experiences: [experience] } }) : route.fallback());
  await page.route("**/api/experiences/experience-confirm-fail/confirm", (route) => route.fulfill({ status: 502, contentType: "text/plain", body: "bad gateway" }));

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await page.locator("summary").filter({ hasText: "确认失败项目" }).click();
  await page.getByRole("button", { name: "确认整段经历" }).click();

  await expect(page.getByRole("status")).toContainText("详细经历确认失败，请稍后重试");
  await expect(page.getByLabel("量化成果")).toBeVisible();
});
test("re-extract handles a non-JSON error response", async ({ page }) => {
  const material = { id: "material-retry-fail", name: "retry-fail.pdf", category: "personal", status: "ready", parseStatus: "complete", createdAt: 1 };
  await page.route("**/api/materials", (route) => route.request().method() === "GET" ? route.fulfill({ json: { materials: [material], facts: [], experiences: [] } }) : route.fallback());
  await page.route("**/api/materials/material-retry-fail/retry", (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" }));

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  const retry = page.getByRole("button", { name: `重新提取详细经历 ${material.name}` });
  await retry.click();

  await expect(page.getByRole("status")).toContainText("详细经历重新提取失败，请稍后重试");
  await expect(retry).toBeEnabled();
});
test("re-extract shows a notice when fetch rejects", async ({ page }) => {
  const material = { id: "material-retry-network", name: "offline.pdf", category: "personal", status: "ready", parseStatus: "complete", createdAt: 1 };
  await page.route("**/api/materials", (route) => route.request().method() === "GET" ? route.fulfill({ json: { materials: [material], facts: [], experiences: [] } }) : route.fallback());
  await page.route("**/api/materials/material-retry-network/retry", (route) => route.abort("failed"));
  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await page.getByRole("button", { name: `重新提取详细经历 ${material.name}` }).click();
  await expect(page.getByRole("status")).toContainText("详细经历重新提取失败，请检查网络后重试");
});

test("confirmed detailed experience drives research interview", async ({ page }) => {
  const material = {
    id: "material-resume", name: "resume.pdf", category: "personal", status: "ready",
    parseStatus: "complete", createdAt: 1_767_225_600_000,
  };
  const experience = (id: string, type: "research" | "project" | "competition", title: string) => ({
    id, materialId: material.id, type, title,
    background: `${title} 背景`, responsibilities: `${title} 个人职责`,
    methods: `${title} 技术方法`, results: `${title} 量化成果`, awardRole: `${title} 角色`,
    source: material.name, page: 2, evidence: { title }, confidence: 0.93,
    status: "draft", createdAt: 1_767_225_600_000, updatedAt: 1_767_225_600_000,
  });
  const experiences = [
    experience("experience-lora", "research", "Super-LoRa"),
    experience("experience-fpga", "competition", "嵌入式 FPGA 竞赛"),
    experience("experience-circuit", "project", "电子设计竞赛 G 题"),
  ];
  let selectedMaterialIds: string[] = [];
  let sessionResponse: { roleInstructions?: { research?: string } } | undefined;

  await page.route("**/api/materials", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: { materials: [material], facts: [], experiences } });
  });
  await page.route("**/api/experiences/experience-lora/confirm", async (route) => {
    const editable = route.request().postDataJSON();
    Object.assign(experiences[0], editable, { status: "confirmed" });
    await route.fulfill({ json: { experience: experiences[0] } });
  });
  await page.route("**/api/interviews", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { interviews: [] } });
      return;
    }
    selectedMaterialIds = route.request().postDataJSON().materialIds;
    await route.fulfill({ status: 201, json: {
      interview: { id: "7a65ab08-03a7-4ec7-9359-a2ff4670ddea", status: "ready" }, plan: [],
    } });
  });
  await page.route("**/api/realtime/session", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      interviewId: "7a65ab08-03a7-4ec7-9359-a2ff4670ddea",
    });
    const confirmed = experiences.find((item) => item.status === "confirmed"
      && selectedMaterialIds.includes(item.materialId));
    sessionResponse = {
      roleInstructions: confirmed
        ? { research: `科研项目模块的第一问必须点名 ${confirmed.title} 并询问候选人的个人职责。` }
        : {},
    };
    await route.fulfill({ json: { websocketPath: "/realtime?token=mock", ...sessionResponse } });
  });

  await page.goto("/");
  await page.locator("nav").getByRole("button", { name: /材料库/ }).click();
  await expect(page.locator("summary")).toHaveCount(3);
  await page.locator("summary").filter({ hasText: "Super-LoRa" }).click();
  await page.getByRole("button", { name: "确认整段经历" }).click();
  await expect(page.getByRole("button", { name: "重新编辑" })).toBeVisible();

  await page.locator("nav").getByRole("button", { name: /训练台/ }).click();
  await page.getByRole("button", { name: `引用材料 ${material.name}` }).click();
  await page.getByRole("button", { name: /开始模拟面试/ }).click();

  await expect.poll(() => sessionResponse?.roleInstructions?.research).toContain("Super-LoRa");
  expect(selectedMaterialIds).toEqual([material.id]);
});
