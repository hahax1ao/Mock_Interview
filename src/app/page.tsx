"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InterviewClock, createInterviewPlan } from "@/domain/interview-plan";
import { useRealtimeInterview } from "@/hooks/use-realtime-interview";
import { keepSuccessfulDeletionNotice } from "@/lib/material-page-actions";
import { ExperienceCards } from "@/components/experience-cards";
import type { ExperienceEditable, ProfileExperience } from "@/domain/experiences";

type Material = { id: string; name: string; category: string; status: string; parseStatus: "complete" | "basic_only" | string; createdAt: number };
type ProfileFact = { id: string; materialId: string | null; field: string; value: string; source: string; confidence: number; confirmed: boolean };
type Interview = { id: string; status: string; duration: 10 | 20 | 30; focus: string; pressure: string; createdAt: number };
type TrendPoint = { id: string; createdAt: number; totalScore: number };
type Report = {
  totalScore: number | null; level: string | null; incomplete: boolean; failedReviewers: string[];
  dimensions: Array<{ dimension: string; score: number | null; level: string | null }>;
  priorityIssues: Array<{ title: string; action: string }>;
  sampleAnswers: Array<{ question: string; answer: string }>;
  trainingPlan: Array<{ day: number; task: string; target: string }>;
};

const roleNames = { chair: "主考官", technical: "专业基础老师", research: "科研项目导师", english: "英语老师" };
const dimensionNames: Record<string, string> = {
  technical: "专业基础", research: "项目科研", logic: "逻辑表达",
  english: "英语交流", authenticity: "真实性", pressure: "抗压表现",
};

export default function Home() {
  const [view, setView] = useState<"dashboard" | "materials" | "history">("dashboard");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [experiences, setExperiences] = useState<ProfileExperience[]>([]);
  const [factValues, setFactValues] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Interview[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [duration, setDuration] = useState<10 | 20 | 30>(20);
  const [focus, setFocus] = useState("电子信息综合");
  const [pressure, setPressure] = useState("adaptive");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [textAnswer, setTextAnswer] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [experienceBusyId, setExperienceBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reportInterviewId, setReportInterviewId] = useState<string | null>(null);
  const finishingRef = useRef(false);
  const finishRef = useRef<() => Promise<void>>(async () => undefined);
  const clock = useRef(new InterviewClock(duration, 0));
  const shouldConnect = useRef(false);

  const tick = useCallback((delta: number) => {
    clock.current.tick(delta);
    setElapsed(clock.current.elapsedMs);
    return clock.current.currentRole;
  }, []);
  const realtime = useRealtimeInterview(activeId, tick);

  const refresh = useCallback(async () => {
    const [materialResponse, interviewResponse] = await Promise.all([fetch("/api/materials"), fetch("/api/interviews")]);
    if (materialResponse.ok) {
      const body = await materialResponse.json();
      setMaterials(body.materials);
      setFacts(body.facts ?? []);
      setExperiences(body.experiences ?? []);
      setFactValues((current) => Object.fromEntries((body.facts ?? []).map((fact: ProfileFact) => [fact.id, current[fact.id] ?? fact.value])));
    }
    if (interviewResponse.ok) setHistory((await interviewResponse.json()).interviews);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (view !== "history") return;
    const query = new URLSearchParams({ duration: String(duration), focus, pressure });
    void fetch(`/api/trends?${query}`).then((response) => response.json()).then((body) => setTrend(body.points ?? []));
  }, [view, duration, focus, pressure]);
  useEffect(() => {
    if (activeId && shouldConnect.current) {
      shouldConnect.current = false;
      realtime.connect().catch((error) => {
        setNotice(error instanceof Error ? error.message : "实时面试启动失败");
      });
    }
  }, [activeId, realtime.connect]);
  useEffect(() => {
    if (activeId && elapsed >= duration * 60_000 && !finishingRef.current) void finishRef.current();
  }, [activeId, duration, elapsed]);

  const plan = useMemo(() => createInterviewPlan(duration), [duration]);
  const role = clock.current.currentRole;
  const remaining = Math.max(0, duration * 60 - Math.floor(elapsed / 1000));
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await fetch("/api/materials", { method: "POST", body: new FormData(form) });
    const body = await response.json();
    if (response.status === 409 && body.duplicateMaterial) {
      const duplicate = body.duplicateMaterial as Pick<Material, "name" | "createdAt">;
      setNotice(`已存在相同材料：${duplicate.name}（${new Date(duplicate.createdAt).toLocaleString()}）`);
      return;
    }
    setNotice(response.ok
      ? body.parseStatus === "basic_only"
        ? `已解析 ${body.pages} 页，生成 ${body.chunks} 个可检索片段；智能解析待重试`
        : `已解析 ${body.pages} 页，生成 ${body.chunks} 个可检索片段；智能解析已完成`
      : body.error);
    if (response.ok) { form.reset(); await refresh(); }
  }
  async function deleteMaterial(item: Material) {
    if (deletingId || !window.confirm(`永久删除“${item.name}”及其画像事实？`)) return;
    setDeletingId(item.id);
    try {
      const response = await fetch(`/api/materials/${item.id}`, { method: "DELETE" });
      let body: { error?: string } = {};
      try {
        if (response.headers.get("content-type")?.includes("application/json")) {
          body = await response.json() as { error?: string };
        }
      } catch {
        body = {};
      }
      if (!response.ok) {
        setNotice(body.error ?? "材料删除失败，请稍后重试");
        return;
      }
      const removedFactIds = new Set(facts.filter((fact) => fact.materialId === item.id).map((fact) => fact.id));
      setMaterials((current) => current.filter((material) => material.id !== item.id));
      setFacts((current) => current.filter((fact) => fact.materialId !== item.id));
      setExperiences((current) => current.filter((experience) => experience.materialId !== item.id));
      setSelected((current) => current.filter((id) => id !== item.id));
      setFactValues((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => !removedFactIds.has(id)),
      ));
      await keepSuccessfulDeletionNotice(`已删除材料：${item.name}`, refresh, setNotice);
    } catch {
      setNotice("材料删除失败，请稍后重试");
    } finally {
      setDeletingId(null);
    }
  }

  async function retryMaterial(item: Material) {
    if (retryingId) return;
    const action = item.parseStatus === "basic_only" ? "智能解析重试" : "详细经历重新提取";
    setRetryingId(item.id);
    try {
      const response = await fetch(`/api/materials/${item.id}/retry`, { method: "POST" });
      let body: { error?: string } = {};
      try {
        if (response.headers.get("content-type")?.includes("application/json")) body = await response.json();
      } catch {
        body = {};
      }
      if (!response.ok) {
        setNotice(body.error ?? `${action}失败，请稍后重试`);
        return;
      }
      setNotice(`智能解析已完成：${item.name}`);
      await refresh();
    } catch {
      setNotice(`${action}失败，请检查网络后重试`);
    } finally {
      setRetryingId(null);
    }
  }

  async function updateExperience(
    id: string,
    method: "PATCH" | "POST",
    value: ExperienceEditable,
    suffix = "",
  ) {
    if (experienceBusyId) throw new Error("another experience update is already in progress");
    const action = method === "POST" ? "确认" : "保存";
    let failureNoticeSet = false;
    setExperienceBusyId(id);
    try {
      const response = await fetch(`/api/experiences/${id}${suffix}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      let body: { error?: string } = {};
      try {
        if (response.headers.get("content-type")?.includes("application/json")) body = await response.json();
      } catch {
        body = {};
      }
      if (!response.ok) {
        failureNoticeSet = true;
        setNotice(body.error ?? `详细经历${action}失败，请稍后重试`);
        throw new Error(body.error ?? "experience update failed");
      }
      setNotice(method === "POST" ? "详细经历已确认" : "详细经历已保存");
      await refresh();
    } catch (error) {
      if (!failureNoticeSet) setNotice(`详细经历${action}失败，请检查网络后重试`);
      throw error;
    } finally {
      setExperienceBusyId(null);
    }
  }
  async function saveExperience(id: string, value: ExperienceEditable) {
    return updateExperience(id, "PATCH", value);
  }

  async function confirmExperience(id: string, value: ExperienceEditable) {
    return updateExperience(id, "POST", value, "/confirm");
  }
  async function confirmFact(fact: ProfileFact) {
    if (!fact.materialId) return;
    const response = await fetch("/api/materials/" + fact.materialId + "/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts: [{ id: fact.id, value: factValues[fact.id] ?? fact.value, confirmed: true }] }),
    });
    const body = await response.json();
    setNotice(response.ok ? "画像事实已确认" : body.error);
    if (response.ok) await refresh();
  }
  async function startInterview() {
    clock.current = new InterviewClock(duration, 0);
    setElapsed(0); setReport(null); setNotice("");
    const response = await fetch("/api/interviews", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration, focus, pressure, materialIds: selected }),
    });
    const body = await response.json();
    if (!response.ok) return setNotice(body.error);
    shouldConnect.current = true;
    setActiveId(body.interview.id);
  }

  async function finishInterview() {
    if (!activeId || finishingRef.current) return;
    finishingRef.current = true;
    const interviewId = activeId;
    setReportInterviewId(interviewId);
    try {
      await realtime.disconnect();
    } catch (error) {
      finishingRef.current = false;
      setNotice(error instanceof Error ? error.message : "转写尚未保存，已阻止复盘");
      return;
    }
    setReviewing(true);
    try {
      const response = await fetch(`/api/interviews/${interviewId}/finish`, { method: "POST" });
      const body = await response.json();
      if (response.ok) {
        setReport(body.report);
        if (body.report.incomplete) setNotice(`部分评审未完成：${body.report.failedReviewers.join("、")}。未知维度不计为 0 分，可点击重试。`);
      } else setNotice(`${body.error}。转写已保留，可从复盘记录重试。`);
      setActiveId(null);
      await refresh();
    } catch {
      setNotice("本地服务暂时不可用；转写已保留，可从复盘记录重试。");
    } finally {
      setReviewing(false);
      finishingRef.current = false;
    }
  }
  finishRef.current = finishInterview;

  async function retryReview(interviewId = reportInterviewId) {
    if (!interviewId || reviewing) return;
    setReportInterviewId(interviewId);
    setReviewing(true);
    try {
      const response = await fetch(`/api/interviews/${interviewId}/review`, { method: "POST" });
      const body = await response.json();
      if (response.ok) {
        setReport(body.report);
        setNotice(body.report.incomplete ? `仍有评审未完成：${body.report.failedReviewers.join("、")}` : "复盘已完整生成");
        await refresh();
      } else setNotice(body.error ?? "复盘重试失败");
    } finally {
      setReviewing(false);
    }
  }

  async function openHistoryReport(interviewId: string) {
    setReportInterviewId(interviewId);
    const response = await fetch(`/api/interviews/${interviewId}/review`);
    if (response.ok) {
      const body = await response.json();
      if (body.report) { setReport(body.report); return; }

    }
    await retryReview(interviewId);
  }

  return <main className="shell">
    <aside className="sidebar">
      <div className="mark">研</div>
      <div className="brand"><strong>研面</strong><span>Interview Studio</span></div>
      <nav>
        <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}><i>⌂</i>训练台</button>
        <button className={view === "materials" ? "active" : ""} onClick={() => setView("materials")}><i>▤</i>材料库</button>
        <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><i>◷</i>复盘记录</button>
      </nav>
      <div className="privacy"><span>●</span><div><b>本地隐私模式</b><small>原文件与转写仅存本机</small></div></div>
    </aside>

    <section className="content">
      <header><div><p className="eyebrow">BAOYAN INTERVIEW LAB</p><h1>{view === "dashboard" ? "今天，练一次真正的面试" : view === "materials" ? "材料与个人画像" : "复盘与训练趋势"}</h1></div><div className="status"><span />百炼服务 · 本地中继</div></header>
      {notice && <div className="notice" role="status" aria-live="polite"><span>{notice}</span><button type="button" aria-label="关闭通知" onClick={() => setNotice("")}>×</button></div>}

      {view === "dashboard" && <>
        <section className="hero-grid">
          <div className="setup card">
            <div className="section-title"><div><span>01</span><h2>创建模拟面试</h2></div><p>四位老师 · 统一声线 · 自适应压力</p></div>
            <label>面试时长</label>
            <div className="segmented">{([10, 20, 30] as const).map((item) => <button key={item} className={duration === item ? "selected" : ""} onClick={() => setDuration(item)}>{item}<small>分钟</small></button>)}</div>
            <div className="field-row">
              <div><label>考察重点</label><input value={focus} onChange={(event) => setFocus(event.target.value)} /></div>
              <div><label>压力等级</label><select value={pressure} onChange={(event) => setPressure(event.target.value)}><option value="gentle">温和</option><option value="adaptive">自适应</option><option value="intense">高压</option></select></div>
            </div>
            <label>引用材料 <em>可选</em></label>
            <div className="material-pills">
              {materials.length ? materials.slice(0, 5).map((item) => <button key={item.id} aria-label={`引用材料 ${item.name}`} className={selected.includes(item.id) ? "chosen" : ""} onClick={() => setSelected((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])}>◫ {item.name}</button>) : <button onClick={() => setView("materials")}>＋ 先上传个人材料</button>}
            </div>
            <button className="primary" onClick={startInterview}><span>开始模拟面试</span><b>→</b></button>
          </div>

          <div className="plan card">
            <div className="section-title"><div><span>02</span><h2>本轮流程</h2></div><p>{duration} min</p></div>
            <div className="timeline">{plan.map((segment, index) => <div className="timeline-item" key={index}><div className="dot">{index + 1}</div><div><b>{segment.label}</b><small>{roleNames[segment.role]}</small></div><time>{segment.minutes}′</time></div>)}</div>
            <div className="guardrails"><span>✓ 单主题最多三层追问</span><span>✓ 最后一分钟强制收尾</span><span>✓ 断线自动暂停计时</span></div>
          </div>
        </section>

        <section className="lower-grid">
          <div className="card quick"><div className="section-title"><div><span>03</span><h2>最近训练</h2></div><button onClick={() => setView("history")}>查看全部 →</button></div>
            {history.length ? history.slice(0, 3).map((item) => <div className="history-row" key={item.id}><div className="score-mini">{item.status === "reviewed" ? "✓" : "…"}</div><div><b>{item.focus}</b><small>{new Date(item.createdAt).toLocaleDateString()} · {item.duration} 分钟</small></div><span>{item.status}</span></div>) : <div className="empty">完成第一轮后，这里会出现训练趋势。</div>}
          </div>
          <div className="card promise"><p>本轮结束后你会得到</p><h3>证据化评分，而不是一句“表现不错”</h3><div><span><b>100</b>分<br />六维评分</span><span><b>5</b>个<br />优先问题</span><span><b>7</b>天<br />训练计划</span></div></div>
        </section>
      </>}

      {view === "materials" && <section className="materials-layout">
        <form className="card upload" onSubmit={upload}><div className="section-title"><div><span>01</span><h2>上传材料</h2></div></div><div className="drop"><div>⇧</div><b>选择本地文件</b><p>PDF / DOCX / JPG / PNG / TXT / MD，最大 20MB</p><input required name="file" type="file" accept=".pdf,.docx,.jpg,.jpeg,.png,.txt,.md" /></div><label>材料类别</label><select name="category"><option value="personal">个人材料</option><option value="target">目标院校</option><option value="reference">专业参考资料</option></select><button className="primary" type="submit"><span>本地解析并建立索引</span><b>→</b></button></form>
        <div className="card library"><div className="section-title"><div><span>02</span><h2>本地材料库</h2></div><p>{materials.length} 份</p></div>{materials.length ? materials.map((item) => <div className="file-row" key={item.id}><div className="file-icon">文</div><div className="file-meta"><b>{item.name}</b><small>{item.category} · {new Date(item.createdAt).toLocaleString()}</small></div><div className="file-controls"><span className={item.parseStatus === "basic_only" ? "pending" : ""}>{item.parseStatus === "basic_only" ? "智能解析待重试" : "已索引"}</span>{item.category === "personal" && <button type="button" className="retry-material" aria-label={item.parseStatus === "basic_only" ? `重试智能解析 ${item.name}` : `重新提取详细经历 ${item.name}`} disabled={retryingId === item.id} onClick={() => void retryMaterial(item)}>{retryingId === item.id ? "提取中" : item.parseStatus === "basic_only" ? "重试" : "重新提取"}</button>}<button type="button" className="delete-material" aria-label={`删除 ${item.name}`} disabled={deletingId === item.id} onClick={() => void deleteMaterial(item)}>{deletingId === item.id ? "删除中" : "删除"}</button></div></div>) : <div className="empty">尚未上传材料。</div>}<div className="facts-title"><b>个人画像事实</b><small>低置信度与冲突信息需人工确认</small></div>{facts.length ? facts.map((fact) => <div className={"fact-row " + (fact.confirmed ? "confirmed" : "")} key={fact.id}><label htmlFor={`fact-${fact.id}`}>{fact.field}<small>{Math.round(fact.confidence * 100)}% · {fact.source}</small></label><input id={`fact-${fact.id}`} value={factValues[fact.id] ?? fact.value} disabled={fact.confirmed} onChange={(event) => setFactValues((values) => ({ ...values, [fact.id]: event.target.value }))} />{fact.confirmed ? <span>已确认</span> : <button onClick={() => void confirmFact(fact)}>确认</button>}</div>) : <div className="empty compact">上传简历或成绩单后自动提取课程、成绩、项目、科研、竞赛、技能与英语信息。</div>}<div className="facts-title experience-section-title"><b>详细经历</b><small>展开补充细节，确认后用于面试追问</small></div>{experiences.length ? <ExperienceCards experiences={experiences} busyId={experienceBusyId} onSave={saveExperience} onConfirm={confirmExperience} /> : <div className="empty compact">从个人材料重新提取科研、项目与竞赛经历。</div>}</div>
      </section>}

      {view === "history" && <section className="card history"><div className="section-title"><div><span>01</span><h2>可比场次趋势</h2></div><p>同方向 · 同时长 · 同压力</p></div><div className="trend-chart">{trend.length ? trend.map((point) => <div key={point.id}><b>{point.totalScore}</b><i style={{ height: `${Math.max(8, point.totalScore)}%` }} /><small>{new Date(point.createdAt).toLocaleDateString()}</small></div>) : <div className="empty">完成至少一轮相同配置的复盘后显示趋势。</div>}</div><div className="section-title records-title"><div><span>02</span><h2>全部模拟记录</h2></div></div>{history.map((item) => <div className="history-row" key={item.id}><div className="score-mini">{item.duration}</div><div><b>{item.focus}</b><small>{new Date(item.createdAt).toLocaleString()} · {item.pressure}</small></div><button onClick={() => void openHistoryReport(item.id)}>{item.status === "reviewed" ? "查看 / 重试" : "重试复盘"}</button></div>)}{!history.length && <div className="empty">还没有面试记录。</div>}</section>}
    </section>

    {activeId && <div className="room">
      <div className="room-top"><div><span className="live">● LIVE</span><b>{focus}</b></div><time>{minutes}:{seconds}</time><button onClick={finishInterview}>结束面试</button></div>
      <div className="examiner"><div className="avatar"><span>{role === "chair" ? "主" : role === "technical" ? "专" : role === "research" ? "研" : "EN"}</span><i /></div><p>当前面试官</p><h2>{roleNames[role]}</h2><small>{realtime.state === "connected" ? "正在聆听…" : realtime.state === "text" ? "文字模式" : "正在连接百炼…"}</small></div>
      <div className="wave">{Array.from({ length: 34 }, (_, i) => <i key={i} style={{ height: `${12 + (i * 17) % 42}px` }} />)}</div>
      <div className="room-actions"><button onClick={() => setShowTranscript((value) => !value)}>▤ {showTranscript ? "收起转写" : "展开转写"}</button><button className="hang" onClick={finishInterview}>■</button><span>不保存原始音频</span></div>
      <div className="text-fallback"><input disabled={realtime.state !== "text"} placeholder="麦克风不可用？在这里输入回答" value={textAnswer} onChange={(event) => setTextAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { void realtime.sendText(textAnswer); setTextAnswer(""); } }} /><button disabled={realtime.state !== "text"} onClick={() => { void realtime.sendText(textAnswer); setTextAnswer(""); }}>发送</button></div>
      {showTranscript && <div className="transcript">{realtime.transcripts.map((turn, index) => <p key={index}><b>{turn.role === "candidate" ? "我" : roleNames[turn.role]}</b>{turn.text}</p>)}</div>}
      {realtime.error && <div className="room-error">{realtime.error}</div>}
    </div>}

    {reviewing && <div className="reviewing"><div className="spinner" /><h2>四位评审正在独立复盘</h2><p>转写已经安全保存，请稍候。</p></div>}
    {report && <div className="report-modal"><button className="close" onClick={() => setReport(null)}>×</button><div className="report-score"><small>{report.incomplete ? "部分评审完成（不生成正式总分）" : "本轮总分"}</small><b>{report.totalScore ?? "—"}</b><span>{report.level ?? "评审未完整"}</span></div><div className="dimensions">{report.dimensions.map((item) => <div key={item.dimension}><span>{dimensionNames[item.dimension] ?? item.dimension}</span><b>{item.score ?? "—"}</b><i><em style={{ width: `${item.score ?? 0}%` }} /></i></div>)}</div>{report.incomplete && <button className="primary" onClick={() => void retryReview()}><span>重试未完成评审</span><b>↻</b></button>}<h3>优先改进</h3>{report.priorityIssues.map((item, index) => <p className="issue" key={index}><b>0{index + 1}</b><span><strong>{item.title}</strong><small>{item.action}</small></span></p>)}<h3>示范回答</h3>{report.sampleAnswers.map((item, index) => <details className="sample-answer" key={index}><summary>{item.question}</summary><p>{item.answer}</p></details>)}<h3>七天训练计划</h3><div className="training-plan">{report.trainingPlan.map((item) => <div key={item.day}><b>DAY {item.day}</b><span><strong>{item.task}</strong><small>{item.target}</small></span></div>)}</div><button className="primary" onClick={() => { setReport(null); setView("history"); }}><span>完成并查看长期趋势</span><b>→</b></button></div>}
  </main>;
}
