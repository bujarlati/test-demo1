import {
  Copy,
  ExternalLink,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Share2,
  ShieldAlert,
  Unlink,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import "../publicStory.css";
import type { OwnerPublicationState } from "../types";
import {
  StoryPublicationDialog,
  type PublicationPreviewStory,
} from "./StoryPublicationDialog";

interface StoryPublicationActionsProps {
  story: PublicationPreviewStory;
  mode?: "toolbar" | "panel" | "library";
}

function requestMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isSharingDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.code === "public_story_sharing_disabled";
}

function absoluteShareUrl(sharePath: string): string {
  return new URL(sharePath, window.location.origin).toString();
}

export function StoryPublicationActions({ story, mode = "toolbar" }: StoryPublicationActionsProps) {
  const toast = useToast();
  const { data, reconcilePublicProfile } = useApp();
  const [publication, setPublication] = useState<OwnerPublicationState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const [serverDisabled, setServerDisabled] = useState(false);
  const sharingEnabled = data?.features.publicStorySharing === true && !serverDisabled;
  const publicPenName = data?.user.publicPenName ?? null;

  const loadPublication = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPublication(await api.ownerPublication(story.id));
    } catch (requestError) {
      if (isSharingDisabled(requestError)) {
        setServerDisabled(true);
        setDialogOpen(false);
        return;
      }
      setError(requestMessage(requestError, "公开状态加载失败。"));
    } finally {
      setLoading(false);
    }
  }, [story.id]);

  useEffect(() => {
    setPublication(null);
    setDialogOpen(false);
    setError(null);
    setManualCopyUrl(null);
    setServerDisabled(false);
  }, [story.id]);

  useEffect(() => {
    if (mode === "panel" && sharingEnabled && !publication && !loading && !error) {
      void loadPublication();
    }
  }, [error, loadPublication, loading, mode, publication, sharingEnabled]);

  if (!sharingEnabled) return null;

  const openDialog = () => {
    setDialogOpen(true);
    setError(null);
    setManualCopyUrl(null);
    if (!publication && !loading) void loadPublication();
  };

  const publish = async (submittedPenName?: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setStoryPublication(story.id, {
        published: true,
        ...(submittedPenName ? { publicPenName: submittedPenName } : {}),
      });
      setPublication(updated);
      if (submittedPenName) reconcilePublicProfile({ publicPenName: submittedPenName.trim() });
      toast(updated.firstPublishedAt === updated.statusUpdatedAt ? "作品已公开，稳定分享链接已经建立。" : "作品已重新公开，原分享链接继续有效。");
    } catch (requestError) {
      const message = requestMessage(requestError, "作品公开失败。");
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const unpublish = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setStoryPublication(story.id, { published: false });
      setPublication(updated);
      toast("作品已取消公开；原链接立即不可读，读者进度仍会保留。");
    } catch (requestError) {
      const message = requestMessage(requestError, "取消公开失败。");
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const updatePublicPenName = async (nextPenName: string) => {
    setBusy(true);
    setError(null);
    try {
      const profile = await api.updatePublicProfile({ publicPenName: nextPenName });
      reconcilePublicProfile(profile);
      toast("账号统一笔名已更新，所有公开作品同步使用新笔名。");
    } catch (requestError) {
      const message = requestMessage(requestError, "笔名更新失败。");
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const copyShareLink = async () => {
    if (!publication) return;
    const url = absoluteShareUrl(publication.sharePath);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(url);
      setManualCopyUrl(null);
      toast("分享链接已复制。" );
    } catch {
      setManualCopyUrl(url);
      toast("浏览器未允许自动复制，请手动复制显示的链接。", "error");
    }
  };

  const dialog = (
    <StoryPublicationDialog
      open={dialogOpen}
      story={story}
      publication={publication}
      publicPenName={publicPenName}
      loading={loading}
      busy={busy}
      error={error}
      manualCopyUrl={manualCopyUrl}
      onClose={() => { if (!busy) setDialogOpen(false); }}
      onRetry={() => void loadPublication()}
      onPublish={publish}
      onUnpublish={unpublish}
      onUpdatePublicPenName={updatePublicPenName}
      onCopy={copyShareLink}
    />
  );

  if (mode === "toolbar") {
    return (
      <>
        <button type="button" onClick={openDialog} aria-label="公开与分享作品">
          <Share2 size={18} /><span>{publication?.status === "active" ? "已公开" : "分享"}</span>
        </button>
        {dialog}
      </>
    );
  }

  if (mode === "library") {
    return (
      <>
        <button
          className="button button--soft story-publication-trigger story-publication-trigger--library"
          type="button"
          aria-haspopup="dialog"
          aria-label={`公开与分享《${story.title}》`}
          onClick={openDialog}
        >
          <Share2 size={16} /><span>{publication?.status === "active" ? "管理公开" : "公开 / 分享"}</span>
        </button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <section className="story-publication-panel" aria-label="作品公开状态">
        <header>
          <span className={`story-publication-panel__icon story-publication-panel__icon--${publication?.status ?? "loading"}`}>
            {publication?.status === "admin_suspended" ? <ShieldAlert size={20} /> : publication?.status === "active" ? <Globe2 size={20} /> : <LockKeyhole size={20} />}
          </span>
          <div><span className="eyebrow">公共书库</span><h2>分享这部作品</h2></div>
        </header>

        {loading && !publication ? (
          <div className="story-publication-panel__loading"><LoaderCircle className="spin" size={18} /> 正在读取公开状态…</div>
        ) : error && !publication ? (
          <div className="story-publication-panel__error"><span>{error}</span><button type="button" className="text-link" onClick={() => void loadPublication()}><RefreshCw size={14} /> 重试</button></div>
        ) : publication ? (
          <>
            <div className="story-publication-panel__state">
              <strong>{publication.status === "active" ? "已公开" : publication.status === "author_unpublished" ? "已取消公开" : publication.status === "admin_suspended" ? "平台已下架" : "仅自己可见"}</strong>
              <p>{publication.status === "active"
                ? `以“${publicPenName}”署名，当前正史更新会自动同步。`
                : publication.status === "author_unpublished"
                  ? "原链接暂不可读，重新公开后继续使用；已有阅读进度不会丢失。"
                  : publication.status === "admin_suspended"
                    ? publication.adminReason || "作品正在等待平台复核，暂时不能由作者重新公开。"
                    : "公开后，注册用户可以从公共书库和稳定链接阅读。"}</p>
            </div>
            {publication.status === "active" && <code className="story-publication-panel__link">{publication.sharePath}</code>}
            <div className="story-publication-panel__actions">
              {publication.status === "active" && <a className="button button--secondary" href={publication.sharePath} target="_blank" rel="noreferrer"><ExternalLink size={15} /> 打开公开页</a>}
              {publication.status === "active" && <button className="button button--soft" type="button" onClick={() => void copyShareLink()}><Copy size={15} /> 复制链接</button>}
              <button className={publication.status === "active" ? "text-link text-link--danger" : "button button--primary"} type="button" disabled={publication.status === "admin_suspended"} onClick={openDialog}>
                {publication.status === "active" ? <><Unlink size={14} /> 管理或取消公开</> : <><Share2 size={15} /> {publication.status === "author_unpublished" ? "重新公开" : publication.status === "admin_suspended" ? "等待复核" : "公开作品"}</>}
              </button>
            </div>
            {manualCopyUrl && <label className="story-publication-panel__manual-link"><span>请手动复制：</span><input readOnly value={manualCopyUrl} onFocus={(event) => event.currentTarget.select()} /></label>}
          </>
        ) : null}
      </section>
      {dialog}
    </>
  );
}
