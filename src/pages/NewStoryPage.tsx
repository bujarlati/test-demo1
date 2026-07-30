import { ArrowLeft, ArrowRight, Check, CircleAlert, Dices, LoaderCircle, ServerCog, Sparkles } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { BookCover } from "../components/BookCover";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import {
  createInitialOpeningJobState,
  openingJobReducer,
  openingJobSecondsRemaining,
  openingProgressPresentation,
  recoverOpeningJobId,
} from "../openingJobState";
import { composeCustomTone, CUSTOM_TONE_WORD_MAX_LENGTH, DEFAULT_STORY_LENGTH, getGenreOption, STORY_GENRES, STORY_LENGTH_OPTIONS, STORY_TONES, type StoryGenre, type StoryLengthPlanId } from "../storyConfig";
import type { GenerationModelOption, ModelConnectionStatus, PendingNarrationReviewView } from "../types";

const connectionStatusLabel: Record<ModelConnectionStatus, string> = {
  draft: "待测试",
  validating: "测试中",
  active: "可用",
  degraded: "能力降级",
  disabled: "已停用",
  revoked: "凭据失效",
};

function canGenerateWith(connection: GenerationModelOption) {
  return connection.status === "active" && !connection.managedLocal;
}

function generationAvailability(connection: GenerationModelOption) {
  if (connection.managedLocal) {
    return {
      selectable: false,
      label: "托管占位 · 禁用",
      reason: "本地托管占位不可用于高质量故事生成。",
    };
  }
  if (connection.status !== "active") {
    return {
      selectable: false,
      label: connectionStatusLabel[connection.status],
      reason: "连接尚未通过测试，当前不能用于生成。",
    };
  }
  return { selectable: true, label: null, reason: null };
}

function preferredConnection(connections: GenerationModelOption[]) {
  return connections.find((connection) => canGenerateWith(connection) && connection.isDefault)
    ?? connections.find(canGenerateWith);
}
type ReviewCandidate = PendingNarrationReviewView["candidates"][number];

function HighlightedReviewSentence({ candidate }: { candidate: ReviewCandidate }) {
  const start = Math.max(0, Math.min(candidate.sentence.length, candidate.highlightStart));
  const end = Math.max(start, Math.min(candidate.sentence.length, candidate.highlightEnd));
  return (
    <>
      {candidate.sentence.slice(0, start)}
      <mark>{candidate.sentence.slice(start, end)}</mark>
      {candidate.sentence.slice(end)}
    </>
  );
}

export function NewStoryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const { data, refresh, reconcileOpeningJobStatus } = useApp();
  const [genre, setGenre] = useState<StoryGenre>("悬疑");
  const [presetTone, setPresetTone] = useState<string>(STORY_TONES[0]);
  const [toneMode, setToneMode] = useState<"preset" | "custom">("preset");
  const [customToneWords, setCustomToneWords] = useState<[string, string]>(["", ""]);
  const [lengthPlan, setLengthPlan] = useState<StoryLengthPlanId>(DEFAULT_STORY_LENGTH.id);
  const [inspiration, setInspiration] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [openingJob, dispatchOpeningJob] = useReducer(
    openingJobReducer,
    undefined,
    () => createInitialOpeningJobState(crypto.randomUUID()),
  );
  const [modelConnectionId, setModelConnectionId] = useState(
    () => preferredConnection(data?.modelConnections ?? [])?.id ?? "",
  );
  const pollRequestId = useRef(0);
  const mounted = useRef(true);
  const completedStoryId = useRef<string | null>(null);

  const preview = useMemo(() => getGenreOption(genre), [genre]);
  const selectedLength = useMemo(
    () => STORY_LENGTH_OPTIONS.find((option) => option.id === lengthPlan) ?? DEFAULT_STORY_LENGTH,
    [lengthPlan],
  );
  const customTone = useMemo(
    () => composeCustomTone(customToneWords[0], customToneWords[1]),
    [customToneWords],
  );
  const tone = toneMode === "custom" ? customTone : presetTone;
  const modelConnections = useMemo(() => data?.modelConnections ?? [], [data?.modelConnections]);
  const selectedConnection = useMemo(
    () => modelConnections.find((connection) => connection.id === modelConnectionId && canGenerateWith(connection)),
    [modelConnectionId, modelConnections],
  );
  const requestedJobId = searchParams.get("job");
  const isGenerating = openingJob.phase === "starting" || openingJob.phase === "polling";
  const isAwaitingReview = openingJob.phase === "awaiting_user_review" || openingJob.phase === "submitting_decision";
  const isBusy = isGenerating || isAwaitingReview || openingJob.phase === "completed";
  const progressView = openingProgressPresentation(openingJob.progress);
  const secondsRemaining = openingJob.review
    ? openingJobSecondsRemaining(openingJob.review.deadlineAt, nowMs)
    : 0;

  useEffect(() => {
    setModelConnectionId((currentId) => {
      if (modelConnections.some((connection) => connection.id === currentId && canGenerateWith(connection))) {
        return currentId;
      }
      return preferredConnection(modelConnections)?.id ?? "";
    });
  }, [modelConnections]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isAwaitingReview) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isAwaitingReview, openingJob.review?.id]);

  useEffect(() => {
    if (openingJob.phase !== "idle" || openingJob.jobId) return;
    const pendingJobs = data?.pendingJobs ?? [];
    const recoveredJobId = recoverOpeningJobId(pendingJobs, requestedJobId);
    if (!recoveredJobId) return;
    const recoveredJob = pendingJobs.find((job) => job.id === recoveredJobId);
    dispatchOpeningJob({
      type: "recover_job",
      jobId: recoveredJobId,
      progress: recoveredJob?.openingProgress ?? null,
    });
    if (!requestedJobId) navigate(`/new?job=${encodeURIComponent(recoveredJobId)}`, { replace: true });
  }, [data?.pendingJobs, navigate, openingJob.jobId, openingJob.phase, requestedJobId]);

  useEffect(() => {
    const jobId = openingJob.jobId;
    if (!jobId || (openingJob.phase !== "polling" && openingJob.phase !== "awaiting_user_review")) return;
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    const poll = async () => {
      const requestId = ++pollRequestId.current;
      controller = new AbortController();
      dispatchOpeningJob({ type: "poll_started", requestId });
      try {
        const status = await api.generationJob(jobId, controller.signal);
        if (disposed) return;
        dispatchOpeningJob({ type: "status_received", requestId, status });
        reconcileOpeningJobStatus(status);
        if (status.status === "completed" || status.status === "failed") void refresh();
      } catch (error) {
        if (disposed || (error instanceof Error && error.name === "AbortError")) return;
        dispatchOpeningJob({
          type: "poll_error",
          requestId,
          message: "暂时无法刷新最新进度，后台任务仍会继续；正在重新连接……",
        });
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), 2_000);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [openingJob.jobId, openingJob.phase, reconcileOpeningJobStatus, refresh]);

  useEffect(() => {
    if (openingJob.phase !== "completed" || !openingJob.storyId) return;
    if (completedStoryId.current === openingJob.storyId) return;
    completedStoryId.current = openingJob.storyId;
    const storyId = openingJob.storyId;
    void (async () => {
      await refresh();
      if (!mounted.current) return;
      toast("第一章已经写好，故事开始了。");
      navigate(`/story/${storyId}`);
    })();
  }, [navigate, openingJob.phase, openingJob.storyId, refresh, toast]);

  const randomize = () => {
    setGenre(STORY_GENRES[Math.floor(Math.random() * STORY_GENRES.length)].label);
    setPresetTone(STORY_TONES[Math.floor(Math.random() * STORY_TONES.length)]);
    setToneMode("preset");
    setCustomToneWords(["", ""]);
    setLengthPlan(STORY_LENGTH_OPTIONS[Math.floor(Math.random() * STORY_LENGTH_OPTIONS.length)].id);
    setInspiration("");
  };

  const submit = async () => {
    if (isBusy) return;
    if (!tone) {
      toast(`请分别输入两个不超过 ${CUSTOM_TONE_WORD_MAX_LENGTH} 个字的基调词语。`, "error");
      return;
    }
    if (!selectedConnection) {
      toast("请先选择一个已通过测试的模型连接；系统不会静默切换模型。", "error");
      return;
    }
    const idempotencyKey = openingJob.phase === "failed"
      ? crypto.randomUUID()
      : openingJob.idempotencyKey;
    if (openingJob.phase === "failed") {
      dispatchOpeningJob({ type: "reset_after_failure", idempotencyKey });
    }
    dispatchOpeningJob({ type: "start" });
    try {
      const result = await api.createStory({
        genre,
        tone,
        lengthPlan,
        inspiration,
        modelConnectionId: selectedConnection.id,
      }, idempotencyKey);
      if (!mounted.current) return;
      dispatchOpeningJob({ type: "create_result", result });
      if (result.kind === "job") {
        reconcileOpeningJobStatus(result.job);
        navigate(`/new?job=${encodeURIComponent(result.job.jobId)}`, { replace: true });
        void refresh();
      }
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : "开书失败，请稍后重试。";
      dispatchOpeningJob({ type: "start_error", message });
      toast(message, "error");
    }
  };

  const decideNarration = async (decision: "keep" | "rewrite") => {
    const review = openingJob.review;
    const jobId = openingJob.jobId;
    if (!review || !jobId || openingJob.phase !== "awaiting_user_review" || secondsRemaining <= 0) return;
    dispatchOpeningJob({ type: "decision_started" });
    try {
      const status = await api.decideNarrationReview(jobId, {
        caseId: review.id,
        caseVersion: review.version,
        contentHash: review.contentHash,
        candidateIds: review.candidates.map((candidate) => candidate.id),
        decision,
        shareRedactedContext: openingJob.shareRedactedContext,
      });
      if (!mounted.current) return;
      dispatchOpeningJob({ type: "decision_result", status });
      reconcileOpeningJobStatus(status);
      if (status.status === "completed" || status.status === "failed") void refresh();
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 409) {
        dispatchOpeningJob({ type: "decision_conflict" });
        return;
      }
      dispatchOpeningJob({
        type: "decision_error",
        message: error instanceof Error ? error.message : "暂时无法提交选择，请稍后再试。",
      });
    }
  };

  return (
    <div className="page page--new-story">
      <header className="page-heading page-heading--compact">
        <div>
          <Link className="back-link" to="/"><ArrowLeft size={16} /> 返回书架</Link>
          <span className="eyebrow">一键开书</span>
          <h1>选一个世界，开始一部长篇连载。</h1>
          <p>覆盖 21 种主流网文题材，默认从 200 章起步。你无需写大纲，也不会被追问情节。</p>
        </div>
        <button className="button button--ghost" type="button" onClick={randomize}>
          <Dices size={18} /> 完全随机
        </button>
      </header>

      <div className="story-builder">
        <form className="story-builder__form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <fieldset>
            <legend><span>01</span> 你想先走进哪种故事？ <em>必选</em></legend>
            <div className="choice-grid choice-grid--genres">
              {STORY_GENRES.map((item) => (
                <label key={item.label} className={genre === item.label ? "selected" : ""}>
                  <input type="radio" name="genre" value={item.label} checked={genre === item.label} onChange={() => setGenre(item.label)} />
                  <span><strong>{item.label}</strong><small>{item.note}</small></span>
                  {genre === item.label && <Check size={16} />}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend><span>02</span> 阅读时希望是什么感觉？ <small>选择预设，或自定义两个词语</small></legend>
            <div className="pill-options">
              {STORY_TONES.map((item) => (
                <button type="button" key={item} className={toneMode === "preset" && presetTone === item ? "selected" : ""} onClick={() => { setPresetTone(item); setToneMode("preset"); }}>{item}</button>
              ))}
            </div>
            <div className={`custom-tone ${toneMode === "custom" ? "selected" : ""}`}>
              <div className="custom-tone__heading">
                <strong>自定义基调</strong>
                <small>每个词语最多 {CUSTOM_TONE_WORD_MAX_LENGTH} 个字</small>
              </div>
              <div className="custom-tone__fields">
                <label>
                  <span>第一个词语</span>
                  <input
                    aria-label="第一个基调词语"
                    value={customToneWords[0]}
                    maxLength={CUSTOM_TONE_WORD_MAX_LENGTH}
                    placeholder="例如：清冷"
                    onFocus={() => setToneMode("custom")}
                    onChange={(event) => { setToneMode("custom"); setCustomToneWords([event.target.value, customToneWords[1]]); }}
                  />
                </label>
                <span className="custom-tone__separator" aria-hidden="true">·</span>
                <label>
                  <span>第二个词语</span>
                  <input
                    aria-label="第二个基调词语"
                    value={customToneWords[1]}
                    maxLength={CUSTOM_TONE_WORD_MAX_LENGTH}
                    placeholder="例如：浪漫"
                    onFocus={() => setToneMode("custom")}
                    onChange={(event) => { setToneMode("custom"); setCustomToneWords([customToneWords[0], event.target.value]); }}
                  />
                </label>
                <div className="custom-tone__result" aria-live="polite">
                  <small>组合效果</small>
                  <strong>{customTone ?? "等待两个词语"}</strong>
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend><span>03</span> 规划多长的连载？ <small>后续可自然收束</small></legend>
            <div className="choice-grid choice-grid--lengths">
              {STORY_LENGTH_OPTIONS.map((item) => (
                <label key={item.id} className={lengthPlan === item.id ? "selected" : ""}>
                  <input type="radio" name="length" value={item.id} checked={lengthPlan === item.id} onChange={() => setLengthPlan(item.id)} />
                  <span><strong>{item.name}</strong><small>{item.chapterCount} 章 · {item.note}</small></span>
                  {lengthPlan === item.id && <Check size={16} />}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend><span>04</span> 有没有一个模糊的念头？ <small>可选 · 180 字以内</small></legend>
            <textarea
              value={inspiration}
              maxLength={180}
              onChange={(event) => setInspiration(event.target.value)}
              placeholder="例如：发生在海底城市；主角收到一封来自未来的信……"
              rows={4}
            />
            <div className="textarea-meta"><span>不用解释如何写</span><span>{inspiration.length}/180</span></div>
          </fieldset>

          <fieldset>
            <legend><span>05</span> 选择本次生成模型 <em>必选</em></legend>
            {modelConnections.length > 0 && (
              <div className="choice-grid choice-grid--models" role="radiogroup" aria-label="本次生成模型">
                {modelConnections.map((connection) => {
                  const availability = generationAvailability(connection);
                  const selectable = availability.selectable;
                  const selected = modelConnectionId === connection.id;
                  return (
                    <label
                      key={connection.id}
                      className={`${selected ? "selected" : ""}${selectable ? "" : " disabled"}`.trim()}
                    >
                      <input
                        type="radio"
                        name="model-connection"
                        value={connection.id}
                        checked={selected}
                        disabled={!selectable}
                        onChange={() => setModelConnectionId(connection.id)}
                      />
                      <span className="model-choice__icon"><ServerCog size={18} /></span>
                      <span className="model-choice__body">
                        <span className="model-choice__heading">
                          <strong>{connection.name}</strong>
                          {connection.isDefault && <small className="model-choice__tag">账号默认</small>}
                          {!selectable && (
                            <small className="model-choice__tag model-choice__tag--disabled">
                              {availability.label}
                            </small>
                          )}
                        </span>
                        <span className="model-choice__routes">
                          <span><small>Planner · 规划</small><strong>{connection.plannerModel}</strong></span>
                          <span><small>Writer · 正文</small><strong>{connection.writerModel}</strong></span>
                        </span>
                        {!selectable && (
                          <small className="model-choice__reason">{availability.reason}</small>
                        )}
                      </span>
                      {selected && <Check className="model-choice__check" size={16} />}
                    </label>
                  );
                })}
              </div>
            )}
            {!selectedConnection && (
              <div className="model-choice-empty" role="alert">
                <CircleAlert size={18} />
                <span>
                  <strong>暂无可用于高质量生成的模型连接</strong>
                  <small>请先新增并测试一个自定义连接，再回来开始故事。</small>
                </span>
                <Link className="text-link" to="/settings/models">前往模型连接</Link>
              </div>
            )}
            <p className="model-choice-note">第一章固定使用所选 Planner 与 Writer；开篇失败时会停止并明确报错，不会静默切换。后续章节按该连接已配置的回退策略执行。</p>
          </fieldset>

          {openingJob.error && !isBusy && (
            <div className="opening-job-error" role="alert">
              <CircleAlert size={18} />
              <span>
                <strong>第一章还没有生成完成</strong>
                <small>{openingJob.error}</small>
              </span>
            </div>
          )}
          <button className="button button--primary button--large story-builder__submit" type="submit" disabled={isBusy || !tone || !selectedConnection}>
            {isBusy
              ? <><LoaderCircle className="spin" size={19} /> 正在让故事醒来</>
              : <><Sparkles size={18} /> {openingJob.phase === "failed" ? "重新生成第一章" : "生成第一章"} <ArrowRight size={18} /></>}
          </button>
          <p className="form-footnote">系统会在后台生成故事基因、人物与暂定结局，但不会提前剧透。</p>
        </form>

        <aside className="story-builder__preview" aria-label="新故事预览">
          <span className="eyebrow">你的下一本书</span>
          <BookCover
            title={preview.previewTitle}
            subtitle={inspiration || "标题与故事仍会在生成时变化"}
            theme={preview.coverTheme}
            size="large"
          />
          <dl>
            <div><dt>题材</dt><dd>{genre}</dd></div>
            <div><dt>氛围</dt><dd>{tone ?? "等待两个词语"}</dd></div>
            <div><dt>规模</dt><dd>{selectedLength.chapterCount} 章</dd></div>
          </dl>
          <p>第一章生成后直接进入阅读，不展示大纲确认页。</p>
        </aside>
      </div>

      {isGenerating && (
        <div className="creation-overlay">
          <div className="creation-dialog" role="dialog" aria-modal="true" aria-labelledby="opening-progress-title">
            <span className="creation-orbit" aria-hidden="true"><Sparkles size={22} /></span>
            <div className="creation-dialog__live" role="status" aria-live="polite">
              <h2 id="opening-progress-title">{progressView.title}</h2>
              <p className="creation-dialog__detail">{progressView.detail}</p>
            </div>
            <ol>
              {["构思故事蓝图", "写作第一稿", "审校与修订", "保存到书架"].map((item, index) => (
                <li key={item} className={index < progressView.stepIndex ? "done" : index === progressView.stepIndex ? "active" : ""}>
                  <span>{index < progressView.stepIndex ? <Check size={14} /> : index + 1}</span>{item}
                </li>
              ))}
            </ol>
            <p className="creation-dialog__background-note">
              复杂稿件可能需要一次修订，因此会多花几分钟。你可以先回书架，生成会在后台继续。
            </p>
            <Link className="button button--ghost creation-dialog__leave" to="/">先回书架</Link>
            {openingJob.error && <p className="creation-dialog__connection-note" role="status">{openingJob.error}</p>}
          </div>
        </div>
      )}

      {isAwaitingReview && openingJob.review && (
        <div className="creation-overlay creation-overlay--review">
          <section className="narration-review-card" role="dialog" aria-modal="true" aria-labelledby="narration-review-title">
            <header>
              <span className="creation-orbit" aria-hidden="true"><CircleAlert size={22} /></span>
              <div>
                <span className="eyebrow">需要你的判断</span>
                <h2 id="narration-review-title">这句话属于故事吗？</h2>
              </div>
            </header>
            <p className="narration-review-card__explanation">系统无法确定这是故事内描述还是写作安排。请阅读上下文后，为整篇草稿选择一次处理方式。</p>

            <div className="narration-review-list">
              {openingJob.review.candidates.map((candidate, index) => (
                <article key={candidate.id}>
                  <span className="narration-review-list__label">
                    {openingJob.review!.candidates.length > 1 ? `待判断句 ${index + 1}` : "待判断句"}
                    <small>{candidate.location === "title" ? "章节标题" : "正文"}</small>
                  </span>
                  {candidate.previousSentence && <p className="narration-review-list__context">{candidate.previousSentence}</p>}
                  <p className="narration-review-list__sentence"><HighlightedReviewSentence candidate={candidate} /></p>
                  {candidate.nextSentence && <p className="narration-review-list__context">{candidate.nextSentence}</p>}
                </article>
              ))}
            </div>

            <div className={`narration-review-countdown ${secondsRemaining === 0 ? "expired" : ""}`} aria-live="polite">
              <strong>{secondsRemaining > 0 ? `${secondsRemaining} 秒` : "正在自动重写"}</strong>
              <span>{secondsRemaining > 0 ? "超时后将自动重写，无需一直停留在这里。" : "判断期限已到，系统正在接管并继续生成。"}</span>
            </div>

            <label className="narration-review-consent">
              <input
                type="checkbox"
                checked={openingJob.shareRedactedContext}
                disabled={openingJob.phase === "submitting_decision" || secondsRemaining === 0}
                onChange={(event) => dispatchOpeningJob({ type: "set_context_consent", value: event.target.checked })}
              />
              <span>
                匿名提交这三句话的脱敏版本，用于改进检测。
                <small>默认不提交；不勾选不会影响这次生成结果。</small>
              </span>
            </label>

            {openingJob.error && <p className="narration-review-card__error" role="alert">{openingJob.error}</p>}
            <div className="narration-review-actions">
              <button
                className="button button--soft"
                type="button"
                disabled={openingJob.phase === "submitting_decision" || secondsRemaining === 0}
                onClick={() => void decideNarration("keep")}
              >
                保留原文并继续
              </button>
              <button
                className="button button--primary"
                type="button"
                disabled={openingJob.phase === "submitting_decision" || secondsRemaining === 0}
                onClick={() => void decideNarration("rewrite")}
              >
                {openingJob.phase === "submitting_decision" && <LoaderCircle className="spin" size={16} />}
                让 AI 重写
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
