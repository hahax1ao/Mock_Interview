import { describe, expect, it, vi } from "vitest";
import { keepSuccessfulDeletionNotice } from "./material-page-actions";

describe("material page deletion feedback", () => {
  it("preserves the successful delete notice when the following refresh fails", async () => {
    const notices: string[] = [];
    const refresh = vi.fn(async () => {
      throw new Error("refresh unavailable");
    });

    await keepSuccessfulDeletionNotice("已删除材料：resume.pdf", refresh, (notice) => notices.push(notice));

    expect(refresh).toHaveBeenCalledOnce();
    expect(notices).toEqual(["已删除材料：resume.pdf"]);
  });
});
