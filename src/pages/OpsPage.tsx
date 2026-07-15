import { Activity, AlertTriangle, CheckCircle2, CircleDollarSign, Clock3, Gauge, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/States";
import type { AuditEvent, ContentReport, GenerationJob, OpsMetrics, OpsQualityBucket, SafetyDecision } from "../types";
import { formatDateTime, money, percent } from "../utils";

export function OpsPage() {
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [safetyDecisions, setSafetyDecisions] = useState<SafetyDecision[]>([]);
  const [qualityBreakdown, setQualityBreakdown] = useState<OpsQualityBucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const payload = await api.ops();
      setMetrics(payload.metrics); setJobs(payload.jobs); setAuditEvents(payload.auditEvents); setReports(payload.reports); setSafetyDecisions(payload.safetyDecisions); setQualityBreakdown(payload.qualityBreakdown); setError(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "观察台加载失败。" ); }
  };
  useEffect(() => { void load(); }, []);
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!metrics) return <LoadingState label="正在汇总生成质量与成本…" />;

  const cards = [
    { label: "章节直接接受率", value: percent(metrics.acceptedChapterRate), hint: "目标 ≥ 70%", icon: CheckCircle2, tone: "jade" },
    { label: "修史一次成功率", value: percent(metrics.retconSuccessRate), hint: "目标 ≥ 60%", icon: Sparkles, tone: "gold" },
    { label: "正史硬冲突率", value: percent(metrics.canonConflictRate, 1), hint: "护栏 < 1%", icon: ShieldCheck, tone: "blue" },
    { label: "首字延迟 P95", value: metrics.firstTokenSampleCount ? `${metrics.firstTokenP95}s` : "暂无样本", hint: `${metrics.firstTokenSampleCount} 个实测样本 · 目标 ≤ 8s`, icon: Clock3, tone: "rust" },
    { label: "被接受章节成本", value: `${metrics.acceptedChapterCostEstimated ? "≈" : ""}${money(metrics.acceptedChapterCost)}`, hint: metrics.acceptedChapterCostEstimated ? "按 Token 估算" : "实测费用", icon: CircleDollarSign, tone: "jade" },
    { label: "活动故事", value: metrics.activeStories.toLocaleString("zh-CN"), hint: "私有正史", icon: Activity, tone: "blue" },
  ];
  const blockedCandidates = jobs.flatMap((job) => job.candidateTrace ?? []).filter((candidate) => candidate.score === 0).length;
  const reviewReport = async (report: ContentReport, status: "reviewing" | "resolved") => {
    const updated = await api.reviewReport(report.id, status, status === "resolved" ? "已完成人工复核；决定与生成模型解耦保存。" : undefined);
    setReports((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  return (
    <div className="page page--ops">
      <header className="page-heading"><div><span className="eyebrow">运营与治理</span><h1>生成观察台</h1><p>围绕“被接受章节”观察质量、延迟、成本与正史安全。</p></div><span className="health-pill"><span /> 服务正常</span></header>
      <section className="metric-grid" aria-label="核心指标">
        {cards.map(({ label, value, hint, icon: Icon, tone }) => <article key={label} className={`metric-card metric-card--${tone}`}><Icon size={19} /><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>)}
      </section>

      <div className="ops-grid">
        <section className="jobs-panel">
          <div className="section-heading"><div><span className="eyebrow">最近作业</span><h2>生成与修史</h2></div><button type="button" className="text-link" onClick={() => void load()}>刷新</button></div>
          <div className="table-wrap">
            <table><thead><tr><th>故事 / 章节</th><th>任务</th><th>模型</th><th>Token</th><th>延迟</th><th>成本</th><th>状态</th></tr></thead>
              <tbody>{jobs.map((job) => <tr key={job.id}><td><strong>{job.storyTitle}</strong><small>第 {job.chapterNumber} 章 · {formatDateTime(job.createdAt)}</small></td><td>{job.task === "opening" ? "开篇" : job.task === "chapter" ? "续章" : job.task === "retcon" ? "修史" : "状态提取"}{job.filterSummary && <small title={job.filterSummary}>{job.candidateTrace ? `${job.candidateTrace.length} 个候选 · ${job.candidateTrace.filter((item) => item.status === "selected")[0]?.creativeAxis ?? "已过滤"}` : job.filterSummary}</small>}</td><td>{job.model}<small>{job.connectionId} · {job.promptVersion}</small></td><td>{job.tokens.toLocaleString("zh-CN")}</td><td>{(job.latencyMs / 1000).toFixed(1)}s</td><td>{job.costEstimated ? "≈" : ""}{money(job.cost)}</td><td><span className={`job-status job-status--${job.status}`}>{job.status === "completed" ? "完成" : job.status === "running" ? "运行中" : "失败"}</span></td></tr>)}</tbody>
            </table>
          </div>
        </section>
        <aside className="guardrail-panel">
          <div><Gauge size={20} /><span><strong>预算降级</strong><small>{jobs.filter((job) => job.budgetDegraded).length} 个近期作业</small></span></div>
          <div><ShieldCheck size={20} /><span><strong>硬正史门禁</strong><small>近期作业阻断 {blockedCandidates} 个候选</small></span></div>
          <div><AlertTriangle size={20} /><span><strong>内容治理</strong><small>{reports.filter((report) => report.status !== "resolved").length} 个待处理 · {safetyDecisions.filter((decision) => decision.decision === "blocked").length} 次阻断</small></span></div>
          <p>敏感正文需额外权限。此视图仅展示故事 ID、作业与统计特征。</p>
        </aside>
      </div>

      <section className="jobs-panel quality-panel">
        <div className="section-heading"><div><span className="eyebrow">质量抽检聚合</span><h2>按模型、题材与提示词版本</h2></div><span>{qualityBreakdown.length} 组</span></div>
        <div className="table-wrap"><table><thead><tr><th>模型</th><th>题材</th><th>提示词</th><th>完成 / 作业</th><th>硬阻断</th><th>举报</th></tr></thead><tbody>
          {qualityBreakdown.map((bucket) => <tr key={bucket.key}><td>{bucket.model}</td><td>{bucket.genre}</td><td>{bucket.promptVersion}</td><td>{bucket.completed} / {bucket.jobs}</td><td>{bucket.blockedCandidates}</td><td>{bucket.reports}</td></tr>)}
        </tbody></table></div>
      </section>

      <section className="governance-panel">
        <div className="section-heading"><div><span className="eyebrow">内容治理</span><h2>举报、复核与申诉</h2></div><span>{reports.length} 条</span></div>
        <div className="governance-list">
          {reports.map((report) => <article key={report.id}><div><strong>{report.reason}</strong><small>{report.storyId} · {report.chapterId} · {report.status}</small></div><div>{report.status === "submitted" || report.status === "appealed" ? <button type="button" className="text-link" onClick={() => void reviewReport(report, "reviewing")}>开始复核</button> : null}{report.status === "reviewing" ? <button type="button" className="text-link" onClick={() => void reviewReport(report, "resolved")}>完成处理</button> : null}</div></article>)}
          {reports.length === 0 && <p>暂无用户举报。输入、候选与输出仍会经过独立安全决策并只记录哈希。</p>}
        </div>
      </section>

      <section className="audit-panel">
        <div className="section-heading"><div><span className="eyebrow">权限与密钥治理</span><h2>最近审计事件</h2></div><span>{auditEvents.length} 条</span></div>
        <div className="audit-list">
          {auditEvents.map((event) => <article key={event.id}><ShieldCheck size={16} /><div><strong>{event.action}</strong><small>{event.targetType} · {event.targetId}</small></div><time>{formatDateTime(event.createdAt)}</time></article>)}
          {auditEvents.length === 0 && <p>暂无审计事件。登录、连接测试、续章与修史提交后会在此出现。</p>}
        </div>
      </section>
    </div>
  );
}
