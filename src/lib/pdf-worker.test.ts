import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { getEmbeddedPdfWorker } from "./pdf-worker";
vi.mock("pdf-parse/worker", () => {
  throw new Error("native canvas bindings must not be loaded to configure the PDF worker");
});


describe("embedded PDF worker", () => {
  it("provides a self-contained worker instead of a build-relative file path", async () => {
    const worker = await getEmbeddedPdfWorker();

    expect(worker.startsWith("data:text/javascript;base64,")).toBe(true);
  });
});
