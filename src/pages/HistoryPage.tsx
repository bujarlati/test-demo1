import { ArrowLeft, ArrowRight, CheckCircle2, GitBranch, RotateCcw, ScrollText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/States";
import { useToast } from "../context/ToastContext";
import type { RetconTransaction, Story } from "../types";
import { formatDateTime } from "../utils";

export function HistoryPage() {
  const { storyId = "" } = useParams();
  const toast = useToast();
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewRevisionId, setPreviewRevisionId] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const load = async () => {
    try {
      const value = await api.story(storyId);
      setStory(value);
      setSelectedId((current) => current ?? value.retcons[0]?.id ?? null);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "版本历史加载失败。" );
    }
  };
  useEffect(() => { void load(); }, [storyId]);

  const selected = useMemo<RetconTransaction | null>(
    () => story?.retcons.find((retcon) => retcon.id === selectedId) ?? story?.retcons[0] ?? null,
    [selectedId, story],
  );

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!story) return <LoadingState label="正在读取不可变 Revision 历史…" />;

  const revisionEntries = story.chapters
    .filter((chapter) => chapter.revisions.length > 1)
    .flatMap((chapter) => chapter.revisions.map((revision) => ({ chapter, revision })))
    .sort((a, b) => Date.parse(b.revision.createdAt) - Date.parse(a.revision.createdAt));
  const previewEntry = previewRevisionId
    ? revisionEntries.find(({ revision }) => revision.id === previewRevisionId) ?? null
    : null;
  const previewParent = previewEntry?.revision.parentRevisionId
    ? previewEntry.chapter.revisions.find((revision) => revision.id === previewEntry.revision.parentRevisionId) ?? null
    : null;
  const canRollback = Boolean(
    selected &&
    selected.kind === "intervention" &&
    selected.status === "committed" &&
    selected.canonVersionAfter === story.canonVersion,
  );

  const rollback = async () => {
    if (!selected || !canRollback) return;
    setRollingBack(true);
    try {
      const result = await api.rollbackRetcon(story, selected.id);
      setStory(result.story);
      setSelectedId(result.retcon.id);
      toast("旧正史已作为新的回滚记录恢复，历史没有被删除。");
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "回滚失败。", "error");
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <div className="page page--history">
      <header className="page-heading history-heading">
        <div>
          <Link className="back-link" to={`/story/${story.id}`}><ArrowLeft size={16} /> 返回阅读</Link>
          <span className="eyebrow">正史与 Revision</span>
          <h1>{story.title} · 版本历史</h1>
          <p>每次修改都创建新版本。旧正文可读、可恢复，但不会被悄悄覆盖。</p>
        </div>
        <div className="canon-version-seal"><small>当前正史</small><strong>v{story.canonVersion}</strong><span>{story.activeBranchId.replace("branch_", "")}</span></div>
      </header>

      <div className="history-layout">
        <aside className="history-timeline">
          <div className="history-timeline__header"><GitBranch size={18} /><strong>正史事务</strong><span>{story.retcons.length}</span></div>
          {story.retcons.map((retcon) => (
            <button type="button" key={retcon.id} className={selected?.id === retcon.id ? "active" : ""} onClick={() => setSelectedId(retcon.id)}>
              <span className={`timeline-node timeline-node--${retcon.status}`} />
              <small>{formatDateTime(retcon.createdAt)}</small>
              <strong>{retcon.title}</strong>
              <span>v{retcon.canonVersionBefore} <ArrowRight size={12} /> v{retcon.canonVersionAfter}</span>
            </button>
          ))}
          {story.retcons.length === 0 && <div className="timeline-empty"><ScrollText size={22} /><p>还没有发生修史事务。当前章节均为初始 Revision。</p></div>}

          {revisionEntries.length > 0 && (
            <div className="revision-index">
              <span className="eyebrow">章节 Revision</span>
              {revisionEntries.map(({ chapter, revision }) => (
                <button type="button" className={previewRevisionId === revision.id ? "active" : ""} key={revision.id} onClick={() => setPreviewRevisionId(revision.id)}><small>第 {chapter.number} 章 · {revision.id === chapter.currentRevisionId ? "当前" : "历史"}</small><strong>{revision.changeSummary ?? revision.reason}</strong></button>
              ))}
            </div>
          )}
        </aside>

        <section className="history-detail">
          {previewEntry && <section className="revision-reader" aria-label="Revision 正文查看器">
            <header><div><span className="eyebrow">可读历史版本</span><h2>第 {previewEntry.chapter.number} 章 · {previewEntry.revision.title}</h2><p>{previewEntry.revision.id} · {formatDateTime(previewEntry.revision.createdAt)} · {previewEntry.revision.reason}</p></div><button type="button" className="text-link" onClick={() => setPreviewRevisionId(null)}>关闭正文</button></header>
            <div className="revision-reader__columns">
              {previewParent && <article><strong>父 Revision · {previewParent.id}</strong>{previewParent.paragraphs.map((paragraph, index) => <p className={paragraph !== previewEntry.revision.paragraphs[index] ? "changed" : ""} key={`${previewParent.id}-${index}`}>{paragraph}</p>)}</article>}
              <article><strong>{previewEntry.revision.id === previewEntry.chapter.currentRevisionId ? "当前正史" : "历史 Revision"} · {previewEntry.revision.id}</strong>{previewEntry.revision.paragraphs.map((paragraph, index) => <p className={paragraph !== previewParent?.paragraphs[index] ? "changed" : ""} key={`${previewEntry.revision.id}-${index}`}>{paragraph}</p>)}</article>
            </div>
          </section>}
          {selected ? (
            <>
              <div className="history-detail__top">
                <div><span className={`transaction-status transaction-status--${selected.status}`}><CheckCircle2 size={15} />{selected.kind === "rollback" ? "独立回滚事务" : selected.status === "committed" ? "已提交正史" : "已由回滚事务反转"}</span><h2>{selected.title}</h2><p>{selected.kind === "rollback" ? selected.sourceText : `读者原话：“${selected.sourceText}”`}</p></div>
                {canRollback && <button className="button button--secondary" type="button" onClick={() => void rollback()} disabled={rollingBack}><RotateCcw size={16} />{rollingBack ? "正在回滚" : "恢复旧正史"}</button>}
                {selected.kind === "intervention" && selected.status === "committed" && !canRollback && <span className="rollback-lock-note">已有后续正史，不能直接回滚</span>}
              </div>

              <div className="impact-summary">
                <span className="eyebrow">影响说明</span><p>{selected.summary}</p><small>{selected.cost} · {formatDateTime(selected.createdAt)}</small>
              </div>

              <div className="change-list">
                {selected.changes.map((change) => (
                  <article key={`${change.chapterNumber}-${change.kind}`}>
                    <span className={`change-kind change-kind--${change.kind}`}>{change.kind === "required" ? "必须修改" : change.kind === "supporting" ? "建议调整" : change.kind === "unchanged" ? "无需修改" : "后续重规划"}</span>
                    <div><small>{change.chapterNumber <= story.chapters.length ? `第 ${change.chapterNumber} 章` : "未来"}</small><h3>{change.chapterTitle}</h3><p>{change.summary}</p></div>
                    {change.revisionId && <span className="revision-id">{change.revisionId}</span>}
                  </article>
                ))}
              </div>

              {selected.characterSnapshots && selected.characterSnapshots.length > 0 && <div className="diff-preview">
                <div className="section-heading"><div><span className="eyebrow">事实差异</span><h3>正史发生了什么变化</h3></div></div>
                <div className="diff-columns">
                  <div className="diff-old"><span>v{selected.canonVersionBefore} · 旧正史</span>{selected.characterSnapshots.map((snapshot) => { const character = story.characters.find((item) => item.id === snapshot.characterId); return <div key={snapshot.characterId}><p><del>{character?.name ?? "角色"}：{snapshot.before.status}</del></p><p><del>位置：{snapshot.before.location}</del></p><p><del>关系：{snapshot.before.relationship}</del></p></div>; })}</div>
                  <div className="diff-new"><span>v{selected.canonVersionAfter} · 新正史</span>{selected.characterSnapshots.map((snapshot) => { const character = story.characters.find((item) => item.id === snapshot.characterId); return <div key={snapshot.characterId}><p><ins>{character?.name ?? "角色"}：{snapshot.after.status}</ins></p><p><ins>位置：{snapshot.after.location}</ins></p><p><ins>关系：{snapshot.after.relationship}</ins></p></div>; })}</div>
                </div>
              </div>}
            </>
          ) : (
            <div className="history-pristine"><span className="pristine-glyph"><CheckCircle2 size={28} /></span><h2>正史尚未被修订</h2><p>当你否决一个事件时，影响章节、事实差异和回滚入口都会出现在这里。</p><Link className="button button--primary" to={`/story/${story.id}`}>返回阅读</Link></div>
          )}
        </section>
      </div>
    </div>
  );
}
