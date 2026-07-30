import {
  BookOpenText,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Flag,
  LoaderCircle,
  PenLine,
  Settings2,
  UserRound,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { Logo } from "../components/Logo";
import { ReaderSettingsControls } from "../components/ReaderSettingsControls";
import { ErrorState, LoadingState } from "../components/States";
import { useToast } from "../context/ToastContext";
import {
  canSavePublicReadingProgress,
  createPublicProgressDebouncer,
  createPublicReadingProgressState,
  progressFromConflictDetails,
  publicReadingProgressReducer,
  restorePublicReadingProgress,
  type PublicProgressDebouncer,
  type PublicProgressDraft,
} from "../publicReadingProgress";
import {
  DEFAULT_READER_SETTINGS,
  loadReaderSettings,
  saveReaderSettings,
  type ReaderSettings,
} from "../readerSettings";
import { buildStoryChapterSections } from "../storyStructure";
import type {
  PublicReadingProgress,
  PublicStoryChapter,
  PublicStoryDetail,
} from "../types";
import "../publicReader.css";

type PublicReaderPanel = "contents" | "settings" | null;

interface RestoreRequest {
  key: number;
  chapterId: string;
  scrollProgress: number;
}

interface QueuedProgressDraft extends PublicProgressDraft {
  storyId: string;
  epoch: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 404
      || error.code === "public_story_unavailable"
      || error.code === "public_story_sharing_disabled");
}

function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function saveStatusLabel(
  availability: "loading" | "available" | "unavailable",
  status: "idle" | "saving" | "saved" | "conflict" | "error",
): string {
  if (availability === "unavailable") return "进度同步已停止";
  if (status === "saving") return "正在保存进度";
  if (status === "saved") return "阅读进度已保存";
  if (status === "conflict") return "已同步较新的进度";
  if (status === "error") return "进度暂未保存";
  return "独立阅读进度";
}

export function PublicReaderPage() {
  const { storyId = "" } = useParams();
  const toast = useToast();
  const [detail, setDetail] = useState<PublicStoryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [panel, setPanel] = useState<PublicReaderPanel>(null);
  const [settings, setSettings] = useState<ReaderSettings>(loadReaderSettings);
  const [reporting, setReporting] = useState(false);
  const [reportedChapterIds, setReportedChapterIds] = useState<ReadonlySet<string>>(new Set());
  const [restoreRequest, setRestoreRequest] = useState<RestoreRequest | null>(null);
  const [progressState, dispatchProgress] = useReducer(
    publicReadingProgressReducer,
    storyId,
    createPublicReadingProgressState,
  );
  const mountedRef = useRef(false);
  const activeStoryIdRef = useRef(storyId);
  const progressVersionRef = useRef(0);
  const saveEpochRef = useRef(0);
  const saveStoppedRef = useRef(false);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const restoreKeyRef = useRef(0);
  const suppressScrollSaveRef = useRef(false);
  const suppressScrollTimerRef = useRef<number | null>(null);
  const panelCloseButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const commitProgressRef = useRef<(draft: QueuedProgressDraft) => void>(() => undefined);
  const progressDebouncerRef = useRef<PublicProgressDebouncer<QueuedProgressDraft> | null>(null);
  if (!progressDebouncerRef.current) {
    progressDebouncerRef.current = createPublicProgressDebouncer((draft) => {
      commitProgressRef.current(draft);
    });
  }
  const progressDebouncer = progressDebouncerRef.current;

  const markUnavailable = () => {
    if (saveStoppedRef.current) return;
    saveStoppedRef.current = true;
    saveEpochRef.current += 1;
    progressDebouncer.stop();
    dispatchProgress({ type: "story_unavailable" });
  };

  commitProgressRef.current = (draft) => {
    const save = async () => {
      if (
        !mountedRef.current
        || saveStoppedRef.current
        || draft.storyId !== activeStoryIdRef.current
        || draft.epoch !== saveEpochRef.current
      ) return;

      dispatchProgress({
        type: "position_changed",
        chapterId: draft.chapterId,
        scrollProgress: draft.scrollProgress,
      });
      dispatchProgress({ type: "save_started" });
      try {
        const saved = await api.savePublicStoryProgress(draft.storyId, {
          chapterId: draft.chapterId,
          scrollProgress: draft.scrollProgress,
          expectedVersion: progressVersionRef.current,
        });
        if (
          !mountedRef.current
          || draft.storyId !== activeStoryIdRef.current
          || draft.epoch !== saveEpochRef.current
        ) return;
        progressVersionRef.current = saved.progressVersion;
        dispatchProgress({ type: "save_succeeded", progress: saved });
      } catch (error) {
        if (
          !mountedRef.current
          || draft.storyId !== activeStoryIdRef.current
          || draft.epoch !== saveEpochRef.current
        ) return;
        if (isUnavailableError(error)) {
          markUnavailable();
          return;
        }
        if (error instanceof ApiError && error.status === 409 && error.code === "progress_conflict") {
          const latest = progressFromConflictDetails(error.details);
          if (latest !== undefined && (!latest || latest.storyId === draft.storyId)) {
            saveEpochRef.current += 1;
            progressDebouncer.cancel();
            if (latest && detail) {
              const restored = restorePublicReadingProgress({ ...detail, readingProgress: latest });
              const resolvedChapter = detail.chapters.find((chapter) => chapter.id === restored.chapterId);
              if (resolvedChapter) {
                const resolvedProgress: PublicReadingProgress = {
                  ...latest,
                  chapterId: resolvedChapter.id,
                  chapterNumber: resolvedChapter.number,
                  scrollProgress: restored.scrollProgress,
                };
                progressVersionRef.current = resolvedProgress.progressVersion;
                dispatchProgress({ type: "server_progress_received", progress: resolvedProgress });
                setRestoreRequest({
                  key: ++restoreKeyRef.current,
                  chapterId: resolvedProgress.chapterId,
                  scrollProgress: resolvedProgress.scrollProgress,
                });
              }
            } else {
              progressVersionRef.current = 0;
              dispatchProgress({ type: "server_progress_received", progress: null });
            }
            toast("另一页面保存了更近的阅读位置，已同步服务器进度。");
            return;
          }
        }
        dispatchProgress({
          type: "save_failed",
          message: requestErrorMessage(error, "阅读进度暂时保存失败。"),
        });
      }
    };
    saveChainRef.current = saveChainRef.current.then(save, save);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveEpochRef.current += 1;
      progressDebouncer.cancel();
      if (suppressScrollTimerRef.current !== null) {
        window.clearTimeout(suppressScrollTimerRef.current);
      }
    };
  }, [progressDebouncer]);

  useEffect(() => {
    saveReaderSettings(settings);
  }, [settings]);

  useEffect(() => {
    const controller = new AbortController();
    activeStoryIdRef.current = storyId;
    saveEpochRef.current += 1;
    saveStoppedRef.current = false;
    progressDebouncer.cancel();
    progressDebouncer.resume();
    dispatchProgress({ type: "reset", storyId });
    setDetail(null);
    setLoadError(null);
    setPanel(null);
    setRestoreRequest(null);
    setReportedChapterIds(new Set());

    void api.publicStory(storyId, controller.signal).then(
      (value) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (value.chapters.length === 0) {
          setLoadError("这部作品还没有可阅读的章节。");
          return;
        }
        const restored = restorePublicReadingProgress(value);
        setDetail(value);
        progressVersionRef.current = restored.progressVersion;
        dispatchProgress({ type: "detail_loaded", detail: value });
        if (restored.chapterId) {
          setRestoreRequest({
            key: ++restoreKeyRef.current,
            chapterId: restored.chapterId,
            scrollProgress: restored.scrollProgress,
          });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || !mountedRef.current) return;
        if (isUnavailableError(error)) {
          markUnavailable();
          return;
        }
        setLoadError(requestErrorMessage(error, "公开作品加载失败。"));
      },
    );

    return () => {
      controller.abort();
      saveEpochRef.current += 1;
      progressDebouncer.cancel();
    };
  }, [progressDebouncer, retryVersion, storyId]);

  const currentIndex = detail?.chapters.findIndex((chapter) => chapter.id === progressState.chapterId) ?? -1;
  const chapter = currentIndex >= 0 ? detail?.chapters[currentIndex] ?? null : null;
  const hasPrevious = currentIndex > 0;
  const hasNext = Boolean(detail && currentIndex >= 0 && currentIndex < detail.chapters.length - 1);

  useEffect(() => {
    if (!detail || !chapter || !restoreRequest || restoreRequest.chapterId !== chapter.id) return;
    const frame = window.requestAnimationFrame(() => {
      suppressScrollSaveRef.current = true;
      const scrollable = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: scrollable * restoreRequest.scrollProgress, behavior: "auto" });
      if (suppressScrollTimerRef.current !== null) {
        window.clearTimeout(suppressScrollTimerRef.current);
      }
      suppressScrollTimerRef.current = window.setTimeout(() => {
        suppressScrollSaveRef.current = false;
        suppressScrollTimerRef.current = null;
      }, 180);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chapter?.id, detail?.id, restoreRequest]);

  useEffect(() => {
    if (!detail || !chapter || progressState.availability !== "available") return;
    const onScroll = () => {
      if (suppressScrollSaveRef.current || saveStoppedRef.current) return;
      const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const scrollProgress = Math.min(1, Math.max(0, window.scrollY / scrollable));
      progressDebouncer.schedule({
        storyId: detail.id,
        chapterId: chapter.id,
        scrollProgress,
        epoch: saveEpochRef.current,
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [chapter?.id, detail?.id, progressDebouncer, progressState.availability]);

  useEffect(() => {
    if (!panel) return;
    panelCloseButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPanel(null);
        previousFocusRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel]);

  const articleStyle = {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": settings.lineHeight,
    "--reader-width": `${settings.width}px`,
  } as CSSProperties;

  const chapterSections = useMemo(
    () => detail ? buildStoryChapterSections(detail.chapters, detail.targetChapterCount) : [],
    [detail],
  );

  const closePanel = () => {
    setPanel(null);
    window.requestAnimationFrame(() => previousFocusRef.current?.focus());
  };

  const togglePanel = (nextPanel: Exclude<PublicReaderPanel, null>) => {
    if (panel === nextPanel) {
      closePanel();
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setPanel(nextPanel);
  };

  const queueChapterProgress = (nextChapter: PublicStoryChapter) => {
    if (!detail || progressState.availability !== "available") return;
    dispatchProgress({ type: "position_changed", chapterId: nextChapter.id, scrollProgress: 0 });
    setRestoreRequest({
      key: ++restoreKeyRef.current,
      chapterId: nextChapter.id,
      scrollProgress: 0,
    });
    progressDebouncer.schedule({
      storyId: detail.id,
      chapterId: nextChapter.id,
      scrollProgress: 0,
      epoch: saveEpochRef.current,
    });
    closePanel();
  };

  const reportCurrentChapter = async () => {
    if (!detail || !chapter || reporting || progressState.availability !== "available") return;
    setReporting(true);
    try {
      await api.reportPublicStory(
        detail.id,
        chapter.id,
        "读者请求对公开作品当前章节进行内容安全与合规复核",
      );
      setReportedChapterIds((current) => new Set(current).add(chapter.id));
      toast("举报已提交，管理员会按当前公开修订进行复核。");
    } catch (error) {
      if (isUnavailableError(error)) {
        markUnavailable();
      } else {
        toast(requestErrorMessage(error, "举报提交失败。"), "error");
      }
    } finally {
      if (mountedRef.current) setReporting(false);
    }
  };

  if (progressState.availability === "unavailable" && !detail) {
    return (
      <main className="reader-state public-reader-state">
        <CircleAlert size={34} />
        <span className="eyebrow">公开阅读</span>
        <h1>作品暂不可读</h1>
        <p>作品可能已取消公开、被下架或归档。原分享链接和你的阅读进度仍会保留。</p>
        <Link
          className="button button--primary"
          to="/discover"
          state={{ unavailablePublicStoryId: storyId }}
        >
          返回大家的故事
        </Link>
      </main>
    );
  }
  if (loadError) {
    return (
      <main className="reader-state">
        <ErrorState message={loadError} onRetry={() => setRetryVersion((value) => value + 1)} />
      </main>
    );
  }
  if (!detail || !chapter) {
    return <main className="reader-state"><LoadingState label="正在恢复公开正史与独立阅读位置…" /></main>;
  }

  const progressPercent = ((currentIndex + 1) / detail.chapters.length) * 100;
  const alreadyReported = reportedChapterIds.has(chapter.id);
  const progressLabel = saveStatusLabel(progressState.availability, progressState.saveStatus);

  return (
    <div className={`reader reader--${settings.theme} public-reader`} style={articleStyle}>
      <a className="skip-link" href="#public-chapter-content">跳到章节正文</a>
      <header className="reader-header">
        <div className="reader-header__left">
          <Link className="reader-back" to="/discover"><ChevronLeft size={18} /> <span>大家的故事</span></Link>
          <Logo compact />
          <button
            type="button"
            className="chapter-trigger"
            aria-expanded={panel === "contents"}
            onClick={() => togglePanel("contents")}
          >
            <span>{detail.title}</span>
            <small>第 {chapter.number} 章</small>
            <ChevronDown size={15} />
          </button>
        </div>
        <div className="public-reader-save-state" aria-live="polite">
          <span className={`public-reader-save-state__dot public-reader-save-state__dot--${progressState.saveStatus}`} />
          {progressLabel}
        </div>
        <div className="reader-header__progress"><span style={{ width: `${progressPercent}%` }} /></div>
        <nav className="reader-header__actions" aria-label="公开阅读工具">
          {detail.viewerIsOwner && (
            <Link to={`/story/${detail.id}`} aria-label="返回创作版">
              <PenLine size={18} /><span>创作版</span>
            </Link>
          )}
          <button
            type="button"
            disabled={reporting || alreadyReported || progressState.availability !== "available"}
            onClick={() => void reportCurrentChapter()}
            aria-label={alreadyReported ? "当前章节已举报" : "举报当前章节"}
          >
            {reporting ? <LoaderCircle className="spin" size={18} /> : <Flag size={18} />}
            <span>{alreadyReported ? "已举报" : "举报"}</span>
          </button>
          <button
            type="button"
            className={panel === "settings" ? "active" : ""}
            aria-expanded={panel === "settings"}
            onClick={() => togglePanel("settings")}
            aria-label="阅读设置"
          >
            <Settings2 size={18} /><span>阅读</span>
          </button>
        </nav>
      </header>

      {progressState.availability === "unavailable" && (
        <div className="public-reader-unavailable-banner" role="alert">
          <CircleAlert size={19} />
          <span>
            <strong>作品暂不可读</strong>
            <small>已加载的文字会保留在本页，但后续章节和阅读进度已停止请求。</small>
          </span>
          <Link to="/discover" state={{ unavailablePublicStoryId: detail.id }}>返回书库</Link>
        </div>
      )}

      <main className="reader-main" id="public-chapter-content">
        <article className="chapter-article">
          <header className="chapter-heading">
            <span className="chapter-number">CHAPTER {String(chapter.number).padStart(2, "0")}</span>
            <h1>{chapter.currentRevision.title}</h1>
            <div>
              <span><Clock3 size={14} /> 约 {chapter.estimatedMinutes} 分钟</span>
              <span><UserRound size={14} /> {detail.authorPenName}</span>
              <span><BookOpenText size={14} /> 公开正史</span>
            </div>
          </header>

          <div className="chapter-body">
            {chapter.currentRevision.paragraphs.map((paragraph, index) => (
              <p
                key={`${chapter.currentRevision.id}-${index}`}
                className={index === 0 ? "dropcap" : ""}
              >
                {paragraph}
              </p>
            ))}
          </div>

          <footer className="chapter-footer">
            <div className="chapter-end-mark" aria-hidden="true"><span /><i>阅</i><span /></div>
            <p>{hasNext ? "这一章之后，故事仍在继续。" : "已读到作者当前公开正史的末尾。"}</p>
            <div className="chapter-actions chapter-actions--public">
              <button
                type="button"
                className="button button--secondary"
                disabled={!hasPrevious || progressState.availability !== "available"}
                onClick={() => hasPrevious && queueChapterProgress(detail.chapters[currentIndex - 1])}
              >
                <ChevronLeft size={17} /> 上一章
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={!hasNext || progressState.availability !== "available"}
                onClick={() => hasNext && queueChapterProgress(detail.chapters[currentIndex + 1])}
              >
                {hasNext ? "下一章" : "已到最新"} <ChevronRight size={17} />
              </button>
            </div>
          </footer>
        </article>
      </main>

      <div
        className={`reader-panel-backdrop${panel ? " visible" : ""}`}
        onClick={closePanel}
        aria-hidden="true"
      />

      {panel === "contents" && (
        <aside className="reader-side-panel contents-panel open" role="dialog" aria-modal="true" aria-label="章节目录">
          <header>
            <div><span className="eyebrow">公开目录</span><h2>{detail.title}</h2></div>
            <button ref={panelCloseButtonRef} type="button" aria-label="关闭目录" onClick={closePanel}><X size={19} /></button>
          </header>
          <div className="contents-scroll">
            {chapterSections.map((section) => (
              <section key={section.key}>
                <h3>{section.label}</h3>
                {section.chapters.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={item.id === chapter.id ? "active" : ""}
                    aria-current={item.id === chapter.id ? "page" : undefined}
                    onClick={() => queueChapterProgress(item)}
                  >
                    <span>{String(item.number).padStart(2, "0")}</span>
                    <strong>{item.currentRevision.title}</strong>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </aside>
      )}

      {panel === "settings" && (
        <aside className="reader-side-panel settings-panel open" role="dialog" aria-modal="true" aria-label="阅读设置">
          <header>
            <div><span className="eyebrow">阅读偏好</span><h2>让文字更合眼</h2></div>
            <button ref={panelCloseButtonRef} type="button" aria-label="关闭设置" onClick={closePanel}><X size={19} /></button>
          </header>
          <div className="settings-scroll">
            <ReaderSettingsControls
              settings={settings}
              onChange={setSettings}
              onReset={() => setSettings({ ...DEFAULT_READER_SETTINGS })}
            />
          </div>
        </aside>
      )}
    </div>
  );
}
