import { ArrowRight, BookOpenText, Clock3, Compass, LoaderCircle, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BookCover } from "../components/BookCover";
import { ErrorState, LoadingState } from "../components/States";
import { useApp } from "../context/AppContext";
import { formatRelativeDate } from "../utils";

export function LibraryPage() {
  const { data, loading, error, refresh, loadMoreStories } = useApp();
  const [loadingMore, setLoadingMore] = useState(false);

  if (loading) return <LoadingState label="正在打开你的私人书架…" />;
  if (error || !data) return <ErrorState message={error ?? "书架加载失败。"} onRetry={() => void refresh()} />;

  const activeStory = data.stories.find((story) => story.id === data.activeStoryId) ?? data.stories[0];
  const otherStories = data.stories.filter((story) => story.id !== activeStory?.id);
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      await loadMoreStories();
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page page--library">
      <header className="page-heading library-heading">
        <div>
          <span className="eyebrow">下午好，{data.user.name}</span>
          <h1>故事已经替你翻到这里。</h1>
          <p>继续读，或让一段全新的命运自行开始。</p>
        </div>
        <div className="library-heading__actions">
          {data.features.publicStorySharing && (
            <Link className="button button--secondary" to="/discover">
              <Compass size={18} /> 大家的故事
            </Link>
          )}
          <Link className="button button--primary" to="/new">
            <Plus size={18} /> 开始新故事
          </Link>
        </div>
      </header>

      {activeStory ? (
        <section className="continue-story" aria-labelledby="continue-title">
          <div className="continue-story__art">
            <BookCover
              title={activeStory.title}
              subtitle={activeStory.subtitle}
              theme={activeStory.coverTheme}
              size="large"
            />
            {activeStory.unreadCanonChanges > 0 && (
              <span className="canon-badge">{activeStory.unreadCanonChanges} 处正史更新</span>
            )}
          </div>
          <div className="continue-story__copy">
            <div className="section-kicker">
              <span className="live-dot" aria-hidden="true" />
              继续阅读
            </div>
            <h2 id="continue-title">{activeStory.title}</h2>
            <p className="continue-story__subtitle">{activeStory.subtitle}</p>
            <blockquote>“{activeStory.latestExcerpt}”</blockquote>
            <div className="reading-meta">
              <span><BookOpenText size={16} /> 第 {activeStory.currentChapterNumber} 章 · {activeStory.currentChapterTitle}</span>
              <span><Clock3 size={16} /> {formatRelativeDate(activeStory.updatedAt)}</span>
            </div>
            <div className="progress-row" aria-label={`全书进度 ${Math.round(activeStory.progress * 100)}%`}>
              <span className="progress-track"><span style={{ width: `${activeStory.progress * 100}%` }} /></span>
              <small>{Math.round(activeStory.progress * 100)}%</small>
            </div>
            <div className="continue-story__actions">
              <Link className="button button--primary button--large" to={`/story/${activeStory.id}`}>
                继续第 {activeStory.currentChapterNumber} 章 <ArrowRight size={18} />
              </Link>
              <Link className="text-link" to={`/story/${activeStory.id}/archive`}>查看故事档案</Link>
            </div>
          </div>
          <div className="continue-story__thread" aria-hidden="true">
            <span>正史 v{activeStory.canonVersion}</span>
          </div>
        </section>
      ) : (
        <section className="empty-library">
          <Sparkles size={30} />
          <h2>书架还是空的</h2>
          <p>只需选择题材，第一章会替你开始。</p>
          <Link className="button button--primary" to="/new">开始第一本小说</Link>
        </section>
      )}

      <section className="library-section" aria-labelledby="all-stories-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">私人收藏</span>
            <h2 id="all-stories-title">你的其他故事</h2>
          </div>
          <div className="library-stats">
            <span><strong>{data.storyPage.totalStories}</strong> 本故事</span>
            <span><strong>{data.storyPage.totalChapters}</strong> 个章节</span>
          </div>
        </div>

        <div className="story-grid">
          {otherStories.map((story) => (
            <Link className="story-tile" to={`/story/${story.id}`} key={story.id}>
              <BookCover title={story.title} subtitle={story.subtitle} theme={story.coverTheme} size="medium" />
              <div className="story-tile__body">
                <span className="story-tile__genre">{story.genre} · {story.tone}</span>
                <h3>{story.title}</h3>
                <p>{story.subtitle}</p>
                <div className="progress-row progress-row--compact">
                  <span className="progress-track"><span style={{ width: `${story.progress * 100}%` }} /></span>
                  <small>第 {story.currentChapterNumber} 章</small>
                </div>
                <span className="story-tile__time">{formatRelativeDate(story.updatedAt)}更新</span>
              </div>
            </Link>
          ))}
          <Link className="story-tile story-tile--new" to="/new">
            <span className="new-story-glyph"><Plus size={28} /></span>
            <h3>让另一个故事开始</h3>
            <p>题材是唯一必选项，其余都可以交给 AI。</p>
          </Link>
        </div>
        {data.storyPage.nextCursor && (
          <button className="button button--secondary library-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore && <LoaderCircle className="spin" size={16} />}
            {loadingMore ? "正在取下一页" : "加载更多故事"}
          </button>
        )}
      </section>
    </div>
  );
}
