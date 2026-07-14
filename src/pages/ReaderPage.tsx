import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  History,
  Library,
  List,
  LoaderCircle,
  MessageCircle,
  Minus,
  Moon,
  MoreHorizontal,
  Plus,
  ScrollText,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  TextCursorInput,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/States";
import { Logo } from "../components/Logo";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import { currentRevision } from "../storyDomain";
import type { Chapter, ConversationMessage, Story } from "../types";
import { formatDateTime } from "../utils";

type ReaderTheme = "paper" | "mist" | "night";
type ReaderPanel = "contents" | "settings" | "chat" | null;

interface ReaderSettings {
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  width: number;
}

const defaultSettings: ReaderSettings = { theme: "paper", fontSize: 20, lineHeight: 1.95, width: 720 };

function loadSettings(): ReaderSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem("xumo-reader-settings") ?? "{}") } as ReaderSettings;
  } catch {
    return defaultSettings;
  }
}

function ConversationCard({ message, story }: { message: ConversationMessage; story: Story }) {
  const retcon = message.retconId ? story.retcons.find((item) => item.id === message.retconId) : null;
  if (message.type === "retcon_result" && retcon) {
    return (
      <article className="chat-retcon-card">
        <div className="chat-retcon-card__status"><Check size={14} /> 修史已提交 · v{retcon.canonVersionAfter}</div>
        <h4>{retcon.title}</h4>
        <p>{retcon.summary}</p>
        <ul>{retcon.changes.slice(0, 3).map((change) => <li key={`${change.chapterNumber}-${change.kind}`}><span>{change.kind === "required" ? "必须" : change.kind === "supporting" ? "补丁" : "规划"}</span><div><strong>{change.chapterNumber <= story.chapters.length ? `第 ${change.chapterNumber} 章` : "后续"}</strong><small>{change.summary}</small></div></li>)}</ul>
        <div><Link to={`/story/${story.id}/history`}>查看全部修改 <ArrowRight size={14} /></Link></div>
      </article>
    );
  }
  return (
    <div className={`chat-message chat-message--${message.role} chat-message--${message.type}${message.oldCanon ? " chat-message--old" : ""}`}>
      {message.oldCanon && <span className="old-canon-label">发生于旧正史 v{message.observedCanonVersion}</span>}
      <p>{message.content}</p>
      <time>{formatDateTime(message.createdAt)}</time>
    </div>
  );
}

export function ReaderPage() {
  const { storyId = "" } = useParams();
  const toast = useToast();
  const { refresh } = useApp();
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [panel, setPanel] = useState<ReaderPanel>(null);
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState(0);
  const [streamedTitle, setStreamedTitle] = useState("");
  const [streamedParagraphs, setStreamedParagraphs] = useState<string[]>([]);
  const [generationFailure, setGenerationFailure] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [feedbackContext, setFeedbackContext] = useState("");
  const progressTimer = useRef<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const restorePosition = useRef(true);

  const load = async () => {
    try {
      const value = await api.story(storyId);
      setStory(value);
      setChapterId((current) => current ?? value.readingProgress.chapterId ?? value.chapters.at(-1)?.id ?? null);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "章节加载失败。" );
    }
  };
  useEffect(() => { void load(); }, [storyId]);

  useEffect(() => {
    localStorage.setItem("xumo-reader-settings", JSON.stringify(settings));
  }, [settings]);

  const currentIndex = story?.chapters.findIndex((chapter) => chapter.id === chapterId) ?? -1;
  const chapter = currentIndex >= 0 ? story?.chapters[currentIndex] ?? null : story?.chapters.at(-1) ?? null;
  const revision = chapter ? currentRevision(chapter) : null;

  useEffect(() => {
    if (!story || !chapter) return;
    if (restorePosition.current && chapter.id === story.readingProgress.chapterId) {
      restorePosition.current = false;
      window.requestAnimationFrame(() => {
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: scrollable * story.readingProgress.scrollProgress });
      });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [chapter?.id, story?.id]);

  useEffect(() => {
    if (!story || !chapter) return;
    const save = () => {
      const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const progress = Math.min(1, Math.max(0, window.scrollY / scrollable));
      if (progressTimer.current) window.clearTimeout(progressTimer.current);
      progressTimer.current = window.setTimeout(() => {
        void api.saveProgress(story.id, chapter.id, progress);
      }, 900);
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      if (progressTimer.current) window.clearTimeout(progressTimer.current);
    };
  }, [chapter?.id, story?.id]);

  useEffect(() => {
    if (panel === "chat") chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [panel, story?.conversation.length]);

  const articleStyle = {
    "--reader-font-size": `${settings.fontSize}px`,
    "--reader-line-height": settings.lineHeight,
    "--reader-width": `${settings.width}px`,
  } as CSSProperties;

  const chaptersByAct = useMemo(() => {
    if (!story) return [];
    const groupSize = Math.max(6, Math.ceil(story.chapters.length / 3));
    return Array.from({ length: Math.ceil(story.chapters.length / groupSize) }, (_, index) => ({
      label: index === 0 ? "第一部 · 潮线初现" : index === 1 ? "第二部 · 旧城回声" : "第三部 · 黑潮将至",
      chapters: story.chapters.slice(index * groupSize, (index + 1) * groupSize),
    }));
  }, [story]);

  const changeChapter = (nextChapter: Chapter) => {
    restorePosition.current = false;
    setChapterId(nextChapter.id);
    setPanel(null);
  };

  const generateNext = async () => {
    if (!story || generating) return;
    setGenerating(true); setGenerationStage(0); setStreamedTitle(""); setStreamedParagraphs([]); setGenerationFailure(null);
    try {
      const result = await api.generateChapter(story, (update) => {
        if (update.event === "stage" && typeof update.stage === "number") setGenerationStage(update.stage);
        if (update.event === "reset_draft") { setStreamedTitle(""); setStreamedParagraphs([]); }
        if (update.event === "paragraph" && update.paragraph) {
          if (update.title) setStreamedTitle(update.title);
          setStreamedParagraphs((paragraphs) => [...paragraphs, update.paragraph!]);
        }
      });
      setStory(result.story);
      const next = result.story.chapters.at(-1);
      if (next) { restorePosition.current = false; setChapterId(next.id); }
      await refresh();
      setStreamedParagraphs([]);
      toast(`第 ${next?.number ?? "下一"} 章已经成为正史。`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "续章失败。";
      setGenerationFailure(message);
      toast(message, "error");
    } finally {
      setGenerating(false);
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!story || !chapter || !revision || !draft.trim() || sending) return;
    const text = draft.trim(); setDraft(""); setSending(true);
    try {
      const result = await api.sendMessage(story, text, {
        chapterId: chapter.id,
        revisionId: revision.id,
        selection: feedbackContext || undefined,
        eventId: story.events
          .filter((event) => event.active && event.chapterNumber === chapter.number)
          .at(-1)?.id,
      });
      setStory(result.story);
      setFeedbackContext("");
      await refresh();
      if (/不希望.*死|不要.*死|别让.*死/.test(text)) toast("正史修订完成：没有追问写法，也没有覆盖旧版本。" );
    } catch (requestError) {
      setDraft(text);
      toast(requestError instanceof Error ? requestError.message : "消息处理失败。", "error");
    } finally { setSending(false); }
  };

  const feedbackSelection = () => {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (selected.length >= 4) setSelection(selected.slice(0, 90));
    else setSelection("");
  };

  const openSelectionFeedback = () => {
    setFeedbackContext(selection);
    setDraft(`关于“${selection}${selection.length >= 90 ? "…" : ""}”：`);
    setPanel("chat"); setSelection("");
  };

  const protectLead = async () => {
    if (!story) return;
    const lead = story.characters[0];
    if (!lead) return;
    try {
      await api.toggleProtection(story.id, lead.id);
      await load(); toast(`${lead.name}已设为死亡保护角色；其他叙事代价仍然有效。`);
    } catch (requestError) { toast(requestError instanceof Error ? requestError.message : "设置失败。", "error"); }
  };

  if (error) return <main className="reader-state"><ErrorState message={error} onRetry={() => void load()} /></main>;
  if (!story || !chapter || !revision) return <main className="reader-state"><LoadingState label="正在恢复正史、阅读位置与对话…" /></main>;

  const retcon = story.retcons[0];
  const revisedChapterLabel = story.chapters
    .filter((item) => item.hasUnreadRevision)
    .map((item) => item.number)
    .slice(0, 4)
    .join("、");
  const hasNext = currentIndex < story.chapters.length - 1;
  const hasPrevious = currentIndex > 0;

  return (
    <div className={`reader reader--${settings.theme}`} style={articleStyle} onMouseUp={feedbackSelection}>
      <a className="skip-link" href="#chapter-content">跳到章节正文</a>
      <header className="reader-header">
        <div className="reader-header__left"><Link className="reader-back" to="/"><ChevronLeft size={18} /> <span>书架</span></Link><Logo compact /><button type="button" className="chapter-trigger" onClick={() => setPanel(panel === "contents" ? null : "contents")}><span>{story.title}</span><small>第 {chapter.number} 章</small><ChevronDown size={15} /></button></div>
        <div className="reader-header__progress"><span style={{ width: `${((currentIndex + 1) / story.chapters.length) * 100}%` }} /></div>
        <nav className="reader-header__actions" aria-label="阅读工具">
          <Link to={`/story/${story.id}/archive`} aria-label="故事档案"><BookMarked size={18} /><span>档案</span></Link>
          <Link to={`/story/${story.id}/history`} aria-label="版本历史"><History size={18} /><span>版本</span></Link>
          <button type="button" onClick={() => setPanel(panel === "settings" ? null : "settings")} aria-label="阅读设置"><Settings2 size={18} /><span>阅读</span></button>
          <button type="button" className={panel === "chat" ? "active" : ""} onClick={() => setPanel(panel === "chat" ? null : "chat")} aria-label="读者对话"><MessageCircle size={18} /><span>对话</span>{story.conversation.length > 1 && <i />}</button>
        </nav>
      </header>

      {story.unreadCanonChanges > 0 && (
        <div className="canon-update-banner">
          <div><span className="canon-update-banner__icon"><ScrollText size={18} /></span><span><strong>正史已更新至 v{story.canonVersion}</strong><small>{revisedChapterLabel ? `第 ${revisedChapterLabel} 章有可追溯修订` : "存在可追溯修订"}；无需强制重读。</small></span></div>
          <div><Link to={`/story/${story.id}/history`}>查看修改</Link><button type="button" onClick={() => { void api.markCanonChangesRead(story.id); setStory({ ...story, unreadCanonChanges: 0 }); }}>我知道了</button></div>
        </div>
      )}

      <main className="reader-main" id="chapter-content">
        <article className="chapter-article">
          <header className="chapter-heading">
            <span className="chapter-number">CHAPTER {String(chapter.number).padStart(2, "0")}</span>
            <h1>{revision.title}</h1>
            <div><span><Clock3 size={14} /> 约 {chapter.estimatedMinutes} 分钟</span><span>正史 v{story.canonVersion}</span>{chapter.revisions.length > 1 && <Link to={`/story/${story.id}/history`}>Revision {chapter.revisions.length}</Link>}</div>
          </header>

          <div className="chapter-body">
            {revision.paragraphs.map((paragraph, index) => <p key={`${revision.id}-${index}`} className={index === 0 ? "dropcap" : ""}>{paragraph}</p>)}
          </div>

          {generationFailure && streamedParagraphs.length > 0 && (
            <section className="generation-interrupted" aria-live="polite">
              <div><CircleAlert size={18} /><span><strong>生成在提交正史前中断</strong><small>{generationFailure} · 已完成段落仅保留为草稿，不会产生重复章节。</small></span></div>
              {streamedTitle && <h3>{streamedTitle}</h3>}
              {streamedParagraphs.map((paragraph, index) => <p key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>)}
              <button className="text-link" type="button" onClick={() => { setGenerationFailure(null); setStreamedParagraphs([]); }}>收起草稿</button>
            </section>
          )}

          <footer className="chapter-footer">
            <div className="chapter-end-mark" aria-hidden="true"><span /><i>续</i><span /></div>
            <p>{hasNext ? "这一章之后，故事仍在继续。" : "已读到当前正史的末尾。"}</p>
            <div className="chapter-actions">
              <button type="button" className="button button--secondary" disabled={!hasPrevious} onClick={() => hasPrevious && changeChapter(story.chapters[currentIndex - 1])}><ChevronLeft size={17} /> 上一章</button>
              <button type="button" className="button button--soft" onClick={() => setPanel("chat")}><MessageCircle size={17} /> 对本章说一句</button>
              {hasNext ? <button type="button" className="button button--primary" onClick={() => changeChapter(story.chapters[currentIndex + 1])}>下一章 <ChevronRight size={17} /></button> : <button type="button" className="button button--primary" disabled={generating} onClick={() => void generateNext()}>{generating ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{generating ? "正在生成" : "生成下一章"}</button>}
            </div>
          </footer>
        </article>
      </main>

      {selection && <button className="selection-feedback" type="button" onClick={openSelectionFeedback}><TextCursorInput size={16} /> 对选中内容说一句</button>}

      <div className={`reader-panel-backdrop${panel ? " visible" : ""}`} onClick={() => setPanel(null)} aria-hidden="true" />

      <aside className={`reader-side-panel contents-panel${panel === "contents" ? " open" : ""}`} aria-hidden={panel !== "contents"}>
        <header><div><span className="eyebrow">目录</span><h2>{story.title}</h2></div><button type="button" aria-label="关闭目录" onClick={() => setPanel(null)}><X size={19} /></button></header>
        <div className="contents-scroll">
          {chaptersByAct.map((act) => <section key={act.label}><h3>{act.label}</h3>{act.chapters.map((item) => <button type="button" key={item.id} className={item.id === chapter.id ? "active" : ""} onClick={() => changeChapter(item)}><span>{String(item.number).padStart(2, "0")}</span><strong>{currentRevision(item)?.title ?? item.title}</strong>{item.hasUnreadRevision && <i>已修订</i>}</button>)}</section>)}
        </div>
      </aside>

      <aside className={`reader-side-panel settings-panel${panel === "settings" ? " open" : ""}`} aria-hidden={panel !== "settings"}>
        <header><div><span className="eyebrow">阅读偏好</span><h2>让文字更合眼</h2></div><button type="button" aria-label="关闭设置" onClick={() => setPanel(null)}><X size={19} /></button></header>
        <div className="settings-scroll">
          <section><label>阅读主题</label><div className="theme-options"><button type="button" className={settings.theme === "paper" ? "active" : ""} onClick={() => setSettings({ ...settings, theme: "paper" })}><Sun size={17} /><span>纸张</span></button><button type="button" className={settings.theme === "mist" ? "active" : ""} onClick={() => setSettings({ ...settings, theme: "mist" })}><BookOpenText size={17} /><span>雾白</span></button><button type="button" className={settings.theme === "night" ? "active" : ""} onClick={() => setSettings({ ...settings, theme: "night" })}><Moon size={17} /><span>夜读</span></button></div></section>
          <section><label>正文字号 <strong>{settings.fontSize}px</strong></label><div className="stepper"><button type="button" aria-label="减小字号" onClick={() => setSettings({ ...settings, fontSize: Math.max(16, settings.fontSize - 1) })}><Minus size={16} /></button><span style={{ fontSize: `${settings.fontSize}px` }}>读</span><button type="button" aria-label="增大字号" onClick={() => setSettings({ ...settings, fontSize: Math.min(26, settings.fontSize + 1) })}><Plus size={16} /></button></div></section>
          <section><label htmlFor="line-height">行间距 <strong>{settings.lineHeight.toFixed(2)}</strong></label><input id="line-height" type="range" min="1.6" max="2.3" step="0.05" value={settings.lineHeight} onChange={(event) => setSettings({ ...settings, lineHeight: Number(event.target.value) })} /></section>
          <section><label htmlFor="text-width">正文宽度 <strong>{settings.width}px</strong></label><input id="text-width" type="range" min="600" max="820" step="20" value={settings.width} onChange={(event) => setSettings({ ...settings, width: Number(event.target.value) })} /></section>
          <button type="button" className="text-link reset-settings" onClick={() => setSettings(defaultSettings)}>恢复默认阅读设置</button>
        </div>
      </aside>

      <aside className={`chat-panel${panel === "chat" ? " open" : ""}`} aria-hidden={panel !== "chat"}>
        <header><div><span className="eyebrow">读者对话</span><h2>只说你的感受</h2></div><button type="button" aria-label="关闭对话" onClick={() => setPanel(null)}><X size={19} /></button></header>
        <div className="chat-context"><ShieldCheck size={15} /><span>当前分支 · 正史 v{story.canonVersion}</span><small>对话可恢复，但正史仍以 Revision 为准</small></div>
        <div className="chat-scroll">
          <div className="chat-intro"><MessageCircle size={20} /><p>你不需要给出替代情节。告诉我哪里不舒服，系统会自行完成修改与代价。</p></div>
          {story.conversation.map((message) => <ConversationCard key={message.id} message={message} story={story} />)}
          <div ref={chatEnd} />
        </div>
        <div className="quick-prompts"><button type="button" onClick={() => { setFeedbackContext(""); setDraft(`不，我不希望${story.characters[0]?.name ?? "她"}死。`); }}>不希望主角死</button><button type="button" onClick={() => { setFeedbackContext(""); setDraft("这段关系发展太快了。"); }}>关系太快</button><button type="button" onClick={() => { setFeedbackContext(""); setDraft("不要把这个反派洗白。"); }}>不要洗白反派</button><button type="button" onClick={() => { setFeedbackContext(""); setDraft(`${story.characters[0]?.name ?? "主角"}为什么会这样选择？`); }}>问一个事实</button></div>
        <form className="chat-composer" onSubmit={(event) => void sendMessage(event)}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={500} placeholder="对故事说一句……" />
          <button type="submit" aria-label="发送" disabled={sending || !draft.trim()}>{sending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}</button>
          <small>{draft.length}/500</small>
        </form>
        {retcon && retcon.kind === "intervention" && retcon.status === "committed" && !story.characters[0]?.protected && <button className="protect-suggestion" type="button" onClick={() => void protectLead()}><ShieldCheck size={16} /><span><strong>希望以后都避免主角死亡？</strong><small>设为保护角色；受伤与失败仍可能发生。</small></span><ChevronRight size={16} /></button>}
      </aside>

      {generating && (
        <div className="generation-overlay" role="status" aria-live="polite">
          <div className="generation-card">
            <span className="generation-glyph"><Sparkles size={22} /></span><span className="eyebrow">后台自主创作</span><h2>下一章正在发生</h2>
            <ol>{["组装当前正史与相关记忆", "生成 5 个短剧情胶囊", "执行正史与因果门禁", "选择并扩写一个方案", "提取事件并提交 Revision"].map((item, index) => <li key={item} className={index < generationStage ? "done" : index === generationStage ? "active" : ""}><span>{index < generationStage ? <Check size={13} /> : index + 1}</span>{item}</li>)}</ol>
            {streamedParagraphs.length > 0 ? <blockquote><strong>{streamedTitle}</strong><span>{streamedParagraphs.at(-1)}</span><small>已完成 {streamedParagraphs.length} 段，提交前仍是草稿</small></blockquote> : <p>只扩写一个完整章节；不会把整本小说反复发送给模型。</p>}
          </div>
        </div>
      )}
    </div>
  );
}
