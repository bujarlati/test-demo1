import { Activity, AlertTriangle, CheckCircle2, CircleDollarSign, Clock3, Gauge, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/States";
import type { AuditEvent, ContentReport, GenerationFailureSummaryBucket, GenerationJob, NarrationReviewMetricBucket, OpsMetrics, OpsPublicationModeration, OpsQualityBucket, SafetyDecision } from "../types";
import { formatDateTime, money, percent } from "../utils";

const emptyPublicationModeration: OpsPublicationModeration = {
  enabled: false,
  counts: {
    total: 0,
    active: 0,
    authorUnpublished: 0,
    adminSuspended: 0,
  },
  recent: [],
};

export function OpsPage() {
  const [metrics, setMetrics] = useState<OpsMetrics | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [safetyDecisions, setSafetyDecisions] = useState<SafetyDecision[]>([]);
  const [qualityBreakdown, setQualityBreakdown] = useState<OpsQualityBucket[]>([]);
  const [failurePatterns, setFailurePatterns] = useState<GenerationFailureSummaryBucket[]>([]);
  const [narrationReviewMetrics, setNarrationReviewMetrics] = useState<NarrationReviewMetricBucket[]>([]);
  const [publicationModeration, setPublicationModeration] = useState(emptyPublicationModeration);
  const [moderationReasons, setModerationReasons] = useState<Record<string, string>>({});
  const [moderationActionStoryId, setModerationActionStoryId] = useState<string | null>(null);
  const [moderationActionError, setModerationActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const payload = await api.ops();
      setMetrics(payload.metrics);
      setJobs(payload.jobs);
      setAuditEvents(payload.auditEvents);
      setReports(payload.reports);
      setSafetyDecisions(payload.safetyDecisions);
      setQualityBreakdown(payload.qualityBreakdown);
      setFailurePatterns(payload.failurePatterns);
      setNarrationReviewMetrics(payload.narrationReviewMetrics);
      setPublicationModeration(payload.publicationModeration);
      setError(null);
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
  const updateModerationReason = (storyId: string, reason: string) => {
    setModerationReasons((current) => ({ ...current, [storyId]: reason }));
  };
  const moderatePublication = async (
    storyId: string,
    action: "suspend" | "restore",
    fallbackReason?: string,
  ) => {
    const reason = (moderationReasons[storyId] ?? fallbackReason ?? "").trim();
    if (action === "suspend" && !reason) {
      setModerationActionError("请输入下架原因后再提交。");
      return;
    }
    if (Array.from(reason).length > 120) {
      setModerationActionError("下架原因不能超过 120 个字符。");
      return;
    }
    setModerationActionStoryId(storyId);
    setModerationActionError(null);
    try {
      if (action === "suspend") {
        await api.suspendPublicStory(storyId, reason);
      } else {
        await api.restorePublicStory(storyId);
      }
      setModerationReasons((current) => {
        const next = { ...current };
        delete next[storyId];
        return next;
      });
      await load();
    } catch (requestError) {
      setModerationActionError(requestError instanceof Error ? requestError.message : "发布状态操作失败。");
    } finally {
      setModerationActionStoryId(null);
    }
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
              <tbody>{jobs.map((job) => <tr key={job.id}><td><strong>{job.storyTitle}</strong><small>第 {job.chapterNumber} 章 · {formatDateTime(job.createdAt)}</small></td><td>{job.task === "opening" ? "开篇" : job.task === "chapter" ? "续章" : job.task === "retcon" ? "修史" : "状态提取"}{job.filterSummary && <small title={job.filterSummary}>{job.candidateTrace ? `${job.candidateTrace.length} 个候选 · ${job.candidateTrace.filter((item) => item.status === "selected")[0]?.creativeAxis ?? "已过滤"}` : job.filterSummary}</small>}</td><td>{job.model}<small>{job.connectionId} · {job.promptVersion}</small></td><td>{job.tokens.toLocaleString("zh-CN")}</td><td>{(job.latencyMs / 1000).toFixed(1)}s</td><td>{job.costEstimated ? "≈" : ""}{money(job.cost)}</td><td><span className={`job-status job-status--${job.status}`}>{job.status === "completed" ? "完成" : job.status === "running" ? "运行中" : job.status === "awaiting_user_review" ? "等待用户判断" : "失败"}</span></td></tr>)}</tbody>
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


      <section className="jobs-panel quality-panel">
        <div className="section-heading"><div><span className="eyebrow">上下文语义规则</span><h2>规则质量与用户选择</h2></div><span>{narrationReviewMetrics.length} 组</span></div>
        <p className="ops-privacy-note">仅展示按规则版本聚合的结构化计数；用户保留率是误报率的近似信号，不提供原句或跨用户明细。</p>
        <div className="table-wrap"><table><thead><tr><th>规则 / 版本</th><th>候选</th><th>模型放行</th><th>模型重写</th><th>模型询问</th><th>用户保留</th><th>用户重写</th><th>超时重写</th><th>重写成功</th><th>最终成功</th><th>最近发生</th></tr></thead><tbody>
          {narrationReviewMetrics.map((bucket) => <tr key={bucket.key}><td><strong>{bucket.ruleId}</strong><small>{bucket.ruleVersion}</small></td><td>{bucket.candidates}</td><td>{bucket.modelAllow}</td><td>{bucket.modelRewrite}</td><td>{bucket.modelAskUser}</td><td><strong>{bucket.userKeep}</strong><small>{bucket.userKeep + bucket.userRewrite ? percent(bucket.userKeep / (bucket.userKeep + bucket.userRewrite), 1) : "0.0%"} · 误报近似</small></td><td>{bucket.userRewrite}</td><td>{bucket.timeoutRewrite}</td><td>{bucket.rewriteSucceeded}</td><td>{bucket.finalJobsCompleted}</td><td>{formatDateTime(bucket.lastSeenAt)}</td></tr>)}
          {narrationReviewMetrics.length === 0 && <tr><td colSpan={11}>暂无上下文语义规则反馈；产生候选后会自动汇总结构化决定。</td></tr>}
        </tbody></table></div>
      </section>
      <section className="jobs-panel quality-panel">
        <div className="section-heading"><div><span className="eyebrow">可靠性纠错数据</span><h2>按原因、阶段与模型聚合的失败模式</h2></div><span>{failurePatterns.length} 组</span></div>
        <div className="table-wrap"><table><thead><tr><th>原因码</th><th>阶段</th><th>模型</th><th>发生次数</th><th>影响作业</th><th>终止</th><th>重写后恢复</th><th>最近发生</th></tr></thead><tbody>
          {failurePatterns.map((pattern) => <tr key={pattern.key}><td><strong>{pattern.reasonCode}</strong><small>{pattern.category}</small></td><td>{pattern.stage}</td><td>{pattern.model}</td><td>{pattern.occurrences}</td><td>{pattern.affectedJobs}</td><td>{pattern.terminalFailures}</td><td>{pattern.recoveredJobs}</td><td>{formatDateTime(pattern.lastSeenAt)}</td></tr>)}
          {failurePatterns.length === 0 && <tr><td colSpan={8}>暂无结构化失败观测；后续生成重写、终止与服务中断会自动记录。</td></tr>}
        </tbody></table></div>
      </section>

      <section className="jobs-panel quality-panel publication-ops-panel">
        <div className="section-heading"><div><span className="eyebrow">公共书库治理</span><h2>最近发布状态</h2></div><span>{publicationModeration.counts.total} 本</span></div>
        <p className="ops-privacy-note">仅返回发布状态、笔名、标题、短原因和时间；运营响应与审计事件不包含任何章节正文。</p>
        <div className="publication-counts" aria-label="发布状态计数">
          <article><span>正在公开</span><strong>{publicationModeration.counts.active.toLocaleString("zh-CN")}</strong></article>
          <article><span>作者取消</span><strong>{publicationModeration.counts.authorUnpublished.toLocaleString("zh-CN")}</strong></article>
          <article><span>管理员下架</span><strong>{publicationModeration.counts.adminSuspended.toLocaleString("zh-CN")}</strong></article>
          <article><span>发布记录</span><strong>{publicationModeration.counts.total.toLocaleString("zh-CN")}</strong></article>
        </div>
        {moderationActionError && <p className="publication-action-error" role="alert">{moderationActionError}</p>}
        {!publicationModeration.enabled ? (
          <p className="publication-empty">公共书库功能当前关闭，发布数据不会被读取。</p>
        ) : (
          <div className="table-wrap"><table><thead><tr><th>作品 / 笔名</th><th>状态</th><th>状态时间</th><th>运营操作</th></tr></thead><tbody>
            {publicationModeration.recent.map((publication) => <tr key={publication.storyId}>
              <td><strong>{publication.title}</strong><small>{publication.authorPenName}</small></td>
              <td><span className={`publication-status publication-status--${publication.status}`}>{publication.status === "active" ? "正在公开" : publication.status === "admin_suspended" ? "管理员下架" : "作者取消"}</span></td>
              <td>{formatDateTime(publication.statusUpdatedAt)}</td>
              <td className="publication-actions-cell">
                {publication.status === "active" ? <>
                  <input
                    value={moderationReasons[publication.storyId] ?? ""}
                    onChange={(event) => updateModerationReason(publication.storyId, event.target.value)}
                    maxLength={120}
                    placeholder="下架原因（必填）"
                    aria-label={`下架《${publication.title}》的原因`}
                  />
                  <button type="button" className="text-link text-link--danger" disabled={moderationActionStoryId === publication.storyId} onClick={() => void moderatePublication(publication.storyId, "suspend")}>下架</button>
                </> : publication.status === "admin_suspended" ? <>
                  <small>{publication.adminReason ?? "未记录原因"}</small>
                  <button type="button" className="text-link" disabled={moderationActionStoryId === publication.storyId} onClick={() => void moderatePublication(publication.storyId, "restore")}>恢复公开</button>
                </> : <small>由作者自行重新公开</small>}
              </td>
            </tr>)}
            {publicationModeration.recent.length === 0 && <tr><td colSpan={4}>暂无发布记录。</td></tr>}
          </tbody></table></div>
        )}
      </section>

      <section className="governance-panel">
        <div className="section-heading"><div><span className="eyebrow">内容治理</span><h2>举报、复核与申诉</h2></div><span>{reports.length} 条</span></div>
        <div className="governance-list">
          {reports.map((report) => {
            const reportStoryId = report.storyId;
            return <article key={report.id}>
              <div><strong>{report.reason}</strong><small>{reportStoryId} · {report.chapterId} · {report.status}</small></div>
              <div className="governance-item-actions">
                <div>{report.status === "submitted" || report.status === "appealed" ? <button type="button" className="text-link" onClick={() => void reviewReport(report, "reviewing")}>开始复核</button> : null}{report.status === "reviewing" ? <button type="button" className="text-link" onClick={() => void reviewReport(report, "resolved")}>完成处理</button> : null}</div>
                {publicationModeration.enabled && report.status !== "resolved" && reportStoryId ? <div className="report-suspend-action">
                  <input
                    value={moderationReasons[reportStoryId] ?? ""}
                    onChange={(event) => updateModerationReason(reportStoryId, event.target.value)}
                    maxLength={120}
                    placeholder="默认：举报待复核"
                    aria-label={`从举报下架故事 ${reportStoryId} 的原因`}
                  />
                  <button type="button" className="text-link text-link--danger" disabled={moderationActionStoryId === reportStoryId} onClick={() => void moderatePublication(reportStoryId, "suspend", "举报待复核")}>下架公开版</button>
                </div> : null}
              </div>
            </article>;
          })}
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
