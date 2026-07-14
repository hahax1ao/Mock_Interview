import { describe, expect, it } from "vitest";
import { resolveLocalStorageRoot } from "./local-storage";

describe("local runtime storage", () => {
  it("keeps development data outside the watched source tree", () => {
    const root = resolveLocalStorageRoot({ NODE_ENV: "development", LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }, "C:\\workspace\\app");

    expect(root).toBe("C:\\Users\\tester\\AppData\\Local\\BaoyanInterviewAgent");
    expect(root.startsWith("C:\\workspace\\app")).toBe(false);
  });

  it("keeps tests isolated in the workspace", () => {
    expect(resolveLocalStorageRoot({ NODE_ENV: "test" }, "C:\\workspace\\app"))
      .toBe("C:\\workspace\\app\\data");
  });
});
