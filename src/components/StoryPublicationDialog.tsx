import {
  Check,
  Copy,
  ExternalLink,
  Globe2,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Unlink,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OwnerPublicationState, Story } from "../types";
import { BookCover } from "./BookCover";

type PublicationPreviewBase = Pick<
  Story,
  "id" | "title" | "subtitle" | "genre" | "tone" | "length" | "coverTheme" | "status" | "canonVersion"
>;
export type PublicationPreviewStory = PublicationPreviewBase & (
  | { chapters: Story["chapters"]; chapterCount?: never }
  | { chapterCount: number; chapters?: never }
);

interface StoryPublicationDialogProps {
  open: boolean;
  story: PublicationPreviewStory;
  publication: OwnerPublicationState | null;
  publicPenName: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  manualCopyUrl: string | null;
  onClose(): void;
  onRetry(): void;
  onPublish(publicPenName?: string): Promise<void>;
  onUnpublish(): Promise<void>;
  onUpdatePublicPenName(publicPenName: string): Promise<void>;
  onCopy(): Promise<void>;
}

function publicPenNameError(value: string): string | null {
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    return "笔名不能包含换行或控制字符。";
  }
  const length = Array.from(value.trim()).length;
  if (length < 2 || length > 20) return "请输入 2 至 20 个字符的笔名。";
  return null;
}

function publicationStatusLabel(publication: OwnerPublicationState): string {
  if (publication.status === "active") return "已公开";
  if (publication.status === "author_unpublished") return "已取消公开";
  if (publication.status === "admin_suspended") return "平台已下架";
  return "仅自己可见";
}

export function StoryPublicationDialog({
  open,
  story,
  publication,
  publicPenName,
  loading,
  busy,
  error,
  manualCopyUrl,
  onClose,
  onRetry,
  onPublish,
  onUnpublish,
  onUpdatePublicPenName,
  onCopy,
}: StoryPublicationDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const manualLinkRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [penName, setPenName] = useState(publicPenName ?? "");
  const [editingPenName, setEditingPenName] = useState(!publicPenName);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPenName(publicPenName ?? "");
    setEditingPenName(!publicPenName);
    setConfirmingUnpublish(false);
  }, [open, publicPenName]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (manualCopyUrl) manualLinkRef.current?.select();
  }, [manualCopyUrl]);

  if (!open) return null;

  const penError = editingPenName ? publicPenNameError(penName) : null;
  const normalizedPenName = penName.trim();
  const status = publication?.status ?? "private";
  const isActive = status === "active";
  const isSuspended = status === "admin_suspended";
  const chapterCount = story.chapterCount ?? story.chapters?.length ?? 0;
  const canPublish = story.status !== "archived" && chapterCount > 0;

  return createPortal(
    <div
      className="modal-backdrop publication-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="publication-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-dialog-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <header className="publication-dialog__header">
          <div>
            <span className="eyebrow">作者分享</span>
            <h2 id="publication-dialog-title">
              {isActive ? "管理公开作品" : status === "author_unpublished" ? "重新公开作品" : isSuspended ? "作品公开状态" : "把故事放进公共书库"}
            </h2>
            <p>公开链接始终不变，正文只同步当前正史。</p>
          </div>
          <button type="button" aria-label="关闭公开设置" disabled={busy} onClick={onClose}><X size={19} /></button>
        </header>

        {loading && !publication ? (
          <div className="publication-dialog__loading"><LoaderCircle className="spin" size={22} /><span>正在读取作品公开状态…</span></div>
        ) : error && !publication ? (
          <div className="publication-dialog__loading publication-dialog__loading--error">
            <ShieldAlert size={22} />
            <span>{error}</span>
            <button className="button button--secondary" type="button" onClick={onRetry}><RefreshCw size={15} /> 重试</button>
          </div>
        ) : publication ? (
          <>
            <div className="publication-dialog__body">
              <aside className="publication-preview">
                <BookCover title={story.title} subtitle={story.subtitle} theme={story.coverTheme} size="medium" />
                <div className="publication-preview__meta">
                  <span>{story.genre}</span><span>{story.length}</span><span>{chapterCount} 章</span>
                </div>
                <strong>当前正史 v{story.canonVersion}</strong>
                <small>成功新增章节或修订当前 Revision 后，公开版本自动同步。</small>
              </aside>

              <div className="publication-dialog__content">
                <div className={`publication-state publication-state--${status.replaceAll("_", "-")}`}>
                  <span>{isSuspended ? <ShieldAlert size={18} /> : isActive ? <Globe2 size={18} /> : <LockKeyhole size={18} />}</span>
                  <div>
                    <small>当前状态</small>
                    <strong>{publicationStatusLabel(publication)}</strong>
                    <p>{isSuspended
                      ? publication.adminReason || "作品正在等待平台复核，作者暂时不能重新公开。"
                      : isActive
                        ? "注册读者可以从公共书库或分享链接阅读。"
                        : status === "author_unpublished"
                          ? "原链接目前不可读；读者保存的进度仍会保留。"
                          : "公开前，只有你的账号能够阅读和管理这部作品。"}</p>
                  </div>
                </div>

                <section className="publication-pen-name">
                  <div className="publication-section-heading">
                    <div><small>公开署名</small><strong>账号统一笔名</strong></div>
                    {!editingPenName && !isSuspended && <button type="button" className="text-link" onClick={() => setEditingPenName(true)}><Pencil size={13} /> 修改笔名</button>}
                  </div>
                  {editingPenName ? (
                    <div className="publication-pen-name__editor">
                      <label htmlFor="publication-pen-name">作者笔名</label>
                      <input
                        id="publication-pen-name"
                        autoComplete="nickname"
                        maxLength={40}
                        value={penName}
                        aria-invalid={Boolean(penError)}
                        onChange={(event) => setPenName(event.target.value)}
                        placeholder="例如：青砚"
                      />
                      <small className={penError ? "field-error" : ""}>{penError ?? "2—20 个字符；同一账号公开的作品使用同一个笔名。"}</small>
                      {publicPenName && (
                        <div>
                          <button className="button button--soft" type="button" disabled={busy || Boolean(penError)} onClick={() => void onUpdatePublicPenName(normalizedPenName)}>保存笔名</button>
                          <button className="text-link" type="button" disabled={busy} onClick={() => { setPenName(publicPenName); setEditingPenName(false); }}>取消修改</button>
                        </div>
                      )}
                    </div>
                  ) : <p className="publication-pen-name__value">{publicPenName}</p>}
                </section>

                <section className="publication-assurances">
                  <h3>公开后会发生什么</h3>
                  <ul>
                    <li><Check size={15} /><span><strong>仅注册用户可读</strong><small>访客必须登录，不能匿名阅读。</small></span></li>
                    <li><Sparkles size={15} /><span><strong>自动同步当前正史</strong><small>历史 Revision、对话和模型设置不会公开。</small></span></li>
                    <li><Link2 size={15} /><span><strong>链接保持稳定</strong><small>取消后重新公开，仍使用同一个地址。</small></span></li>
                  </ul>
                </section>

                {isActive && (
                  <section className="publication-share-link">
                    <div><small>稳定分享链接</small><code>{publication.sharePath}</code></div>
                    <div><a className="button button--secondary" href={publication.sharePath} target="_blank" rel="noreferrer"><ExternalLink size={15} /> 打开</a><button className="button button--soft" type="button" onClick={() => void onCopy()}><Copy size={15} /> 复制</button></div>
                  </section>
                )}

                {manualCopyUrl && (
                  <label className="publication-manual-copy" htmlFor="publication-manual-copy">
                    <span>浏览器未允许自动复制，请手动复制：</span>
                    <input ref={manualLinkRef} id="publication-manual-copy" readOnly value={manualCopyUrl} onFocus={(event) => event.currentTarget.select()} />
                  </label>
                )}

                {!canPublish && !isActive && <p className="publication-inline-error">只有至少包含一章成功正文的非归档故事可以公开。</p>}
                {error && publication && <p className="publication-inline-error" role="alert">{error}</p>}
              </div>
            </div>

            <footer className="publication-dialog__footer">
              {isSuspended ? (
                <button className="button button--secondary" type="button" onClick={onClose}>关闭</button>
              ) : isActive ? confirmingUnpublish ? (
                <div className="publication-unpublish-confirm">
                  <span><strong>确认取消公开？</strong><small>链接将立即不可读，但读者进度会保留。</small></span>
                  <button className="button button--secondary" type="button" disabled={busy} onClick={() => setConfirmingUnpublish(false)}>暂不取消</button>
                  <button className="button button--danger" type="button" disabled={busy} onClick={() => void onUnpublish()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Unlink size={15} />} 确认取消</button>
                </div>
              ) : (
                <>
                  <button className="text-link text-link--danger" type="button" disabled={busy} onClick={() => setConfirmingUnpublish(true)}><Unlink size={14} /> 取消公开</button>
                  <button className="button button--secondary" type="button" onClick={onClose}>完成</button>
                </>
              ) : (
                <>
                  <button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>暂不公开</button>
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={busy || !canPublish || (editingPenName && Boolean(penError))}
                    onClick={() => void onPublish(editingPenName ? normalizedPenName : undefined)}
                  >
                    {busy ? <LoaderCircle className="spin" size={16} /> : <Globe2 size={16} />}
                    {status === "author_unpublished" ? "重新公开" : "立即公开"}
                  </button>
                </>
              )}
            </footer>
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
