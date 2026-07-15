// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileExperience } from "@/domain/experiences";
import { ExperienceCards } from "./experience-cards";

afterEach(cleanup);

const experience: ProfileExperience = {
  id: "experience-1",
  materialId: "material-1",
  type: "research",
  title: "Super-LoRa",
  background: "传统方案吞吐量受限",
  responsibilities: "负责算法设计与实验",
  methods: "设计并行干扰消除算法",
  results: "吞吐量提升 1.2 倍",
  awardRole: "第一作者",
  source: "resume.pdf",
  page: 2,
  evidence: { title: "Super-LoRa" },
  confidence: 0.91,
  status: "draft",
  createdAt: 1_767_225_600_000,
  updatedAt: 1_767_225_600_000,
};

describe("ExperienceCards", () => {
  it("edits and confirms a draft experience", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ExperienceCards
        experiences={[experience]}
        busyId={null}
        onSave={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /展开.*Super-LoRa/ }));
    fireEvent.change(screen.getByLabelText("量化成果"), { target: { value: "吞吐量提升 1.35 倍" } });
    fireEvent.click(screen.getByRole("button", { name: "确认整段经历" }));

    expect(onConfirm).toHaveBeenCalledWith(
      "experience-1",
      expect.objectContaining({ results: "吞吐量提升 1.35 倍" }),
    );
  });

  it("keeps confirmed experiences read-only until re-editing", () => {
    render(
      <ExperienceCards
        experiences={[{ ...experience, status: "confirmed" }]}
        busyId={null}
        onSave={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /展开.*Super-LoRa/ }));
    expect(screen.queryByLabelText("量化成果")).not.toBeInTheDocument();
    expect(screen.getByText("科研")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新编辑" }));
    expect(screen.getByLabelText("量化成果")).toHaveValue("吞吐量提升 1.2 倍");
  });
  it("shows which detailed fields are incomplete", () => {
    render(
      <ExperienceCards
        experiences={[{ ...experience, results: "", awardRole: "" }]}
        busyId={null}
        onSave={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("待补充：量化成果、奖项 / 角色")).toBeInTheDocument();
    expect(screen.getByText("待补 2 项")).toBeVisible();
  });
  it("saves every editable field in one draft update", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ExperienceCards
        experiences={[experience]}
        busyId={null}
        onSave={onSave}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith("experience-1", {
      type: "research",
      title: "Super-LoRa",
      background: "传统方案吞吐量受限",
      responsibilities: "负责算法设计与实验",
      methods: "设计并行干扰消除算法",
      results: "吞吐量提升 1.2 倍",
      awardRole: "第一作者",
    });
  });
  it("opens a draft added by a later refresh for editing", () => {
    const props = { busyId: null, onSave: vi.fn(), onConfirm: vi.fn() };
    const { rerender } = render(
      <ExperienceCards experiences={[{ ...experience, status: "confirmed" }]} {...props} />,
    );

    rerender(
      <ExperienceCards
        experiences={[
          { ...experience, status: "confirmed" },
          { ...experience, id: "experience-2", title: "New Draft" },
        ]}
        {...props}
      />,
    );

    expect(screen.getByLabelText("量化成果")).toBeInTheDocument();
  });
});
