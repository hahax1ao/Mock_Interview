"use client";

import { useEffect, useRef, useState } from "react";
import type { ExperienceEditable, ExperienceType, ProfileExperience } from "@/domain/experiences";

type ExperienceCardsProps = {
  experiences: ProfileExperience[];
  busyId: string | null;
  onSave: (id: string, value: ExperienceEditable) => Promise<void>;
  onConfirm: (id: string, value: ExperienceEditable) => Promise<void>;
};

const typeNames: Record<ExperienceType, string> = { research: "科研", project: "项目", competition: "竞赛" };

const detailedFields: Array<[keyof ExperienceEditable, string]> = [
  ["title", "标题"],
  ["background", "背景"],
  ["responsibilities", "个人职责"],
  ["methods", "方法与过程"],
  ["results", "量化成果"],
  ["awardRole", "奖项 / 角色"],
];
function editableValue(experience: ProfileExperience): ExperienceEditable {
  return {
    type: experience.type,
    title: experience.title,
    background: experience.background,
    responsibilities: experience.responsibilities,
    methods: experience.methods,
    results: experience.results,
    awardRole: experience.awardRole,
  };
}

export function ExperienceCards({ experiences, busyId, onSave, onConfirm }: ExperienceCardsProps) {
  const [drafts, setDrafts] = useState<Record<string, ExperienceEditable>>(() =>
    Object.fromEntries(experiences.map((experience) => [experience.id, editableValue(experience)])),
  );
  const [editingIds, setEditingIds] = useState<Set<string>>(() =>
    new Set(experiences.filter((experience) => experience.status === "draft").map((experience) => experience.id)),
  );
  const dirtyIds = useRef(new Set<string>());
  const experiencesRef = useRef(experiences);
  const serverStatuses = useRef(new Map(experiences.map((experience) => [experience.id, experience.status])));
  experiencesRef.current = experiences;

  useEffect(() => {
    const newlyConfirmedIds = new Set(experiences.filter((experience) =>
      experience.status === "confirmed" && serverStatuses.current.get(experience.id) === "draft"
    ).map((experience) => experience.id));
    setDrafts((current) => Object.fromEntries(experiences.map((experience) => [
      experience.id,
      dirtyIds.current.has(experience.id) && !newlyConfirmedIds.has(experience.id)
        ? current[experience.id] ?? editableValue(experience)
        : editableValue(experience),
    ])));
    newlyConfirmedIds.forEach((id) => dirtyIds.current.delete(id));
    setEditingIds((current) => new Set([...current].filter((id) => !newlyConfirmedIds.has(id))));
    serverStatuses.current = new Map(experiences.map((experience) => [experience.id, experience.status]));
  }, [experiences]);
  function update(id: string, field: keyof ExperienceEditable, value: string) {
    dirtyIds.current.add(id);
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], [field]: value },
    }));
  }

  async function save(id: string, draft: ExperienceEditable) {
    try {
      await onSave(id, draft);
      dirtyIds.current.delete(id);
      const refreshed = experiencesRef.current.find((experience) => experience.id === id);
      if (refreshed) setDrafts((current) => ({ ...current, [id]: editableValue(refreshed) }));
    } catch {
      // The page action owns the visible failure notice; keep the card editable.
    }
  }
  async function confirm(id: string, draft: ExperienceEditable) {
    try {
      await onConfirm(id, draft);
      dirtyIds.current.delete(id);
      setEditingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch {
      // The page action owns the visible failure notice; keep the card editable.
    }
  }
  return <div className="experience-cards">
    {experiences.map((experience) => {
      const draft = drafts[experience.id] ?? editableValue(experience);
      const editing = experience.status === "draft" || editingIds.has(experience.id);
      const missing = detailedFields.filter(([field]) => !draft[field]).map(([, label]) => label);
      return <details className="experience-card" key={experience.id}>
        <summary><span>{experience.title}</span><small className={missing.length ? "summary-missing" : "summary-complete"}>{missing.length ? `待补 ${missing.length} 项` : experience.status === "confirmed" ? "已确认" : "字段完整"}</small></summary>
        <div className="experience-meta">
          <span>{experience.source} · 第 {experience.page} 页</span>
          <span>置信度 {Math.round(experience.confidence * 100)}%</span>
          <span>{experience.status === "confirmed" ? "已确认" : "待确认"}</span>
        </div>
        <p className={missing.length ? "experience-missing" : "experience-complete"}>{missing.length ? `待补充：${missing.join("、")}` : "字段完整"}</p>
        {!editing ? <div className="experience-readonly">
          <p><b>经历类型</b>{typeNames[draft.type]}</p>
          <p><b>标题</b>{draft.title}</p>
          <p><b>背景</b>{draft.background}</p>
          <p><b>个人职责</b>{draft.responsibilities}</p>
          <p><b>方法与过程</b>{draft.methods}</p>
          <p><b>量化成果</b>{draft.results}</p>
          <p><b>奖项 / 角色</b>{draft.awardRole}</p>
          <button type="button" disabled={busyId !== null} onClick={() => setEditingIds((current) => new Set(current).add(experience.id))}>重新编辑</button>
        </div> : <div className="experience-fields">
          <label htmlFor={`experience-${experience.id}-type`}>经历类型</label>
          <select id={`experience-${experience.id}-type`} value={draft.type} onChange={(event) => update(experience.id, "type", event.target.value as ExperienceType)}>
            <option value="research">科研</option>
            <option value="project">项目</option>
            <option value="competition">竞赛</option>
          </select>
          <label htmlFor={`experience-${experience.id}-title`}>标题</label>
          <input id={`experience-${experience.id}-title`} value={draft.title} onChange={(event) => update(experience.id, "title", event.target.value)} />
          <label htmlFor={`experience-${experience.id}-background`}>背景</label>
          <textarea id={`experience-${experience.id}-background`} value={draft.background} onChange={(event) => update(experience.id, "background", event.target.value)} />
          <label htmlFor={`experience-${experience.id}-responsibilities`}>个人职责</label>
          <textarea id={`experience-${experience.id}-responsibilities`} value={draft.responsibilities} onChange={(event) => update(experience.id, "responsibilities", event.target.value)} />
          <label htmlFor={`experience-${experience.id}-methods`}>方法与过程</label>
          <textarea id={`experience-${experience.id}-methods`} value={draft.methods} onChange={(event) => update(experience.id, "methods", event.target.value)} />
          <label htmlFor={`experience-${experience.id}-results`}>量化成果</label>
          <textarea id={`experience-${experience.id}-results`} value={draft.results} onChange={(event) => update(experience.id, "results", event.target.value)} />
          <label htmlFor={`experience-${experience.id}-award-role`}>奖项 / 角色</label>
          <textarea id={`experience-${experience.id}-award-role`} value={draft.awardRole} onChange={(event) => update(experience.id, "awardRole", event.target.value)} />
          <div className="experience-actions">
            <button type="button" disabled={busyId !== null} onClick={() => void save(experience.id, draft)}>保存修改</button>
            <button type="button" disabled={busyId !== null} onClick={() => void confirm(experience.id, draft)}>确认整段经历</button>
          </div>
        </div>}
      </details>;
    })}
  </div>;
}
