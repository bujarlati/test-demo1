import { Archive, ArrowLeft, BookMarked, Eye, EyeOff, Heart, Pause, Play, ShieldCheck, Sparkles, Trash2, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/States";
import { StoryDeletionDialog } from "../components/StoryDeletionDialog";
import { StoryPublicationActions } from "../components/StoryPublicationActions";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import { deleteStoryWithReconciliation } from "../storyDeletion";
import type { Story } from "../types";

type ArchiveTab = "characters" | "world" | "clues" | "preferences";

export function ArchivePage() {
  const { storyId = "" } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const { reconcileStoryDeletion, refresh } = useApp();
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ArchiveTab>("characters");
  const [showSpoilers, setShowSpoilers] = useState(false);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const deletionSubmittingRef = useRef(false);

  const load = async () => {
    try {
      setStory(await api.story(storyId));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "故事档案加载失败。" );
    }
  };

  useEffect(() => { void load(); }, [storyId]);
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!story) return <LoadingState label="正在整理人物与正史档案…" />;

  const toggleProtection = async (characterId: string) => {
    try {
      await api.toggleProtection(story.id, characterId);
      await load();
      toast("角色保护范围已更新。仍会保留受伤、失败与离开的代价。");
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "更新失败。", "error");
    }
  };

  const togglePreference = async (preferenceId: string, active: boolean) => {
    try {
      await api.setPreferenceActive(story.id, preferenceId, active);
      await load();
      toast(active ? "约束已恢复，只影响当前故事。" : "约束已暂停，历史记录仍保留。");
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "约束更新失败。", "error");
    }
  };

  const deletePreference = async (preferenceId: string) => {
    try {
      await api.deletePreference(story.id, preferenceId);
      await load();
      toast("约束已从当前故事删除，审计记录仍保留。");
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "约束删除失败。", "error");
    }
  };

  const setStoryStatus = async (status: "active" | "paused" | "archived") => {
    if (status === "archived" && !window.confirm("将这个故事移出书架？正文、正史与版本历史会软归档，不会物理删除。")) return;
    try {
      const updated = await api.setStoryStatus(story.id, status);
      await refresh();
      if (status === "archived") navigate("/");
      else {
        setStory(updated);
        toast(status === "active" ? "故事已从最新正史恢复连载。" : "故事已暂停；阅读与历史仍可访问。" );
      }
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "故事状态更新失败。", "error");
    }
  };

  const deleteStory = async (confirmationTitle: string) => {
    if (deletionSubmittingRef.current) return;
    deletionSubmittingRef.current = true;
    setDeleting(true);
    setDeletionError(null);
    try {
      await deleteStoryWithReconciliation({
        storyId: story.id,
        confirmationTitle,
        deleteRequest: api.deleteStory,
        probeStory: api.probeOwnedStory,
      });
      reconcileStoryDeletion({
        storyId: story.id,
        chapterCount: story.chapters.length,
        countedInShelf: story.status !== "archived",
      });
      setDeletionOpen(false);
      navigate("/", { replace: true });
      toast("故事已永久删除。");
    } catch (requestError) {
      setDeletionError(requestError instanceof Error ? requestError.message : "故事删除失败，请重试。");
    } finally {
      deletionSubmittingRef.current = false;
      setDeleting(false);
    }
  };

  const tabs: Array<{ id: ArchiveTab; label: string; count: number }> = [
    { id: "characters", label: "人物与关系", count: story.characters.length },
    { id: "world", label: "世界规则", count: story.rules.length },
    { id: "clues", label: "线索账本", count: story.clues.length },
    { id: "preferences", label: "偏好与约束", count: story.preferences.length },
  ];

  return (
    <div className="page page--archive">
      <header className="page-heading archive-heading">
        <div>
          <Link className="back-link" to={`/story/${story.id}`}><ArrowLeft size={16} /> 返回阅读</Link>
          <span className="eyebrow">故事档案 · 正史 v{story.canonVersion}</span>
          <h1>{story.title}</h1>
          <p>{story.summary}</p>
        </div>
        <div className="archive-heading__actions">
          <Link className="button button--secondary" to={`/story/${story.id}/history`}><BookMarked size={17} /> 版本历史</Link>
          {story.status === "paused" ? <button className="button button--secondary" type="button" onClick={() => void setStoryStatus("active")}><Play size={16} /> 恢复连载</button> : <button className="button button--secondary" type="button" onClick={() => void setStoryStatus("paused")}><Pause size={16} /> 暂停连载</button>}
          <button className="text-link text-link--danger" type="button" onClick={() => void setStoryStatus("archived")}><Archive size={15} /> 移出书架</button>
        </div>
      </header>

      <StoryPublicationActions story={story} mode="panel" />

      <div className="archive-layout">
        <nav className="archive-tabs" aria-label="故事档案分类">
          {tabs.map((item) => (
            <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
              <span>{item.label}</span><small>{item.count}</small>
            </button>
          ))}
        </nav>

        <section className="archive-content">
          {tab === "characters" && (
            <>
              <div className="section-heading">
                <div><span className="eyebrow">当前正史状态</span><h2>人物与关系</h2></div>
                <p>状态来自已接受章节，不包含模型猜测。</p>
              </div>
              <div className="character-list">
                {story.characters.map((character) => (
                  <article className="character-row" key={character.id}>
                    <span className={`character-avatar character-avatar--${character.accent}`}>{character.initials}</span>
                    <div className="character-row__identity">
                      <div><h3>{character.name}</h3>{character.protected && <span className="protected-label"><ShieldCheck size={14} /> 已保护</span>}</div>
                      <p>{character.role} · {character.status}</p>
                    </div>
                    <dl>
                      <div><dt>当前位置</dt><dd>{character.location}</dd></div>
                      <div><dt>当前目标</dt><dd>{character.goal}</dd></div>
                      <div><dt>关系状态</dt><dd>{character.relationship}</dd></div>
                    </dl>
                    <button className={`button ${character.protected ? "button--soft" : "button--secondary"}`} type="button" onClick={() => void toggleProtection(character.id)}>
                      <Heart size={16} fill={character.protected ? "currentColor" : "none"} />
                      {character.protected ? "取消死亡保护" : "设为保护角色"}
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}

          {tab === "world" && (
            <>
              <div className="section-heading"><div><span className="eyebrow">可追溯规则</span><h2>已知世界规则</h2></div><p>硬规则会在正文发布前执行确定性检查。</p></div>
              <div className="rule-list">
                {story.rules.map((rule) => (
                  <article key={rule.id}>
                    <span className={`rule-kind rule-kind--${rule.hardness}`}>{rule.hardness === "hard" ? "硬规则" : "叙事基线"}</span>
                    <h3>{rule.title}</h3><p>{rule.description}</p><small>依据：{rule.source}</small>
                  </article>
                ))}
              </div>
            </>
          )}

          {tab === "clues" && (
            <>
              <div className="section-heading">
                <div><span className="eyebrow">伏笔与回收</span><h2>线索账本</h2></div>
                <button className="button button--ghost" type="button" onClick={() => setShowSpoilers((value) => !value)}>{showSpoilers ? <EyeOff size={16} /> : <Eye size={16} />}{showSpoilers ? "隐藏剧透" : "显示隐藏线索"}</button>
              </div>
              <div className="clue-timeline">
                {story.clues.map((clue) => (
                  <article key={clue.id} className={clue.spoiler && !showSpoilers ? "spoiler-hidden" : ""}>
                    <span className={`clue-status clue-status--${clue.status}`} />
                    <div><small>第 {clue.sourceChapter} 章 · {clue.status === "resolved" ? "已回收" : clue.status === "strengthened" ? "已强化" : "已埋设"}</small><h3>{clue.spoiler && !showSpoilers ? "隐藏线索" : clue.title}</h3><p>{clue.spoiler && !showSpoilers ? "继续阅读后会逐步显现。" : clue.description}</p></div>
                  </article>
                ))}
              </div>
            </>
          )}

          {tab === "preferences" && (
            <>
              <div className="section-heading"><div><span className="eyebrow">读者记忆</span><h2>偏好与约束</h2></div><p>单次否决不会自动变成永久保护。</p></div>
              <div className="preference-list">
                {story.preferences.map((preference) => (
                  <article key={preference.id} className={!preference.active ? "inactive" : ""}>
                    <span className={`preference-icon preference-icon--${preference.kind}`}>{preference.kind === "hard" ? <ShieldCheck size={18} /> : <Sparkles size={18} />}</span>
                    <div><div><h3>{preference.label}</h3><span>{preference.kind === "hard" ? "硬约束" : `软偏好 · ${Math.round(preference.confidence * 100)}%`}</span></div><p>{preference.description}</p></div>
                    <div className="preference-actions"><button type="button" className="text-link" onClick={() => void togglePreference(preference.id, !preference.active)}>{preference.active ? <Pause size={14} /> : <Play size={14} />}{preference.active ? "暂停" : "恢复"}</button><button type="button" className="text-link text-link--danger" onClick={() => void deletePreference(preference.id)}><Trash2 size={14} />删除</button></div>
                  </article>
                ))}
                {story.preferences.length === 0 && <div className="inline-empty"><UsersRound size={22} /><p>还没有形成长期偏好。故事会先保持自己的判断。</p></div>}
              </div>
            </>
          )}
        </section>
      </div>

      <section className="story-danger-zone" aria-labelledby="story-danger-title">
        <div>
          <span className="eyebrow">危险操作</span>
          <h2 id="story-danger-title">永久删除这个故事</h2>
          <p>与“移出书架”不同，永久删除会清除正文、版本历史、分享链接和读者进度。</p>
        </div>
        <button
          className="button button--danger"
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            setDeletionError(null);
            setDeletionOpen(true);
          }}
        >
          <Trash2 size={16} /> 永久删除故事
        </button>
      </section>

      <StoryDeletionDialog
        open={deletionOpen}
        storyTitle={story.title}
        busy={deleting}
        error={deletionError}
        onClose={() => { if (!deletionSubmittingRef.current) setDeletionOpen(false); }}
        onConfirm={deleteStory}
      />
    </div>
  );
}
