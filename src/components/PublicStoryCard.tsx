import { BookOpenText, Clock3, UserRound } from "lucide-react";
import { Link } from "react-router-dom";
import type { PublicStorySummary } from "../types";
import { formatRelativeDate } from "../utils";
import { BookCover } from "./BookCover";

interface PublicStoryCardProps {
  story: PublicStorySummary;
}

function statusLabel(status: PublicStorySummary["status"]): string | null {
  if (status === "paused") return "暂停更新";
  if (status === "completed") return "已完结";
  return null;
}

export function PublicStoryCard({ story }: PublicStoryCardProps) {
  const lifecycleLabel = statusLabel(story.status);

  return (
    <Link
      className="public-story-card"
      to={`/public/story/${encodeURIComponent(story.id)}`}
      aria-label={`阅读《${story.title}》，作者 ${story.authorPenName}`}
    >
      <BookCover
        className="public-story-card__cover"
        title={story.title}
        subtitle={story.subtitle}
        theme={story.coverTheme}
        size="medium"
      />
      <div className="public-story-card__body">
        <div className="public-story-card__tags">
          <span>{story.genre}</span>
          <span>{story.tone}</span>
          {lifecycleLabel && <span className="public-story-card__status">{lifecycleLabel}</span>}
        </div>
        <div>
          <h3>{story.title}</h3>
          <p className="public-story-card__subtitle">{story.subtitle}</p>
        </div>
        <p className="public-story-card__excerpt">“{story.latestExcerpt}”</p>
        <div className="public-story-card__author">
          <UserRound size={15} aria-hidden="true" />
          <span>{story.authorPenName}</span>
        </div>
        <div className="public-story-card__footer">
          <span><BookOpenText size={15} aria-hidden="true" /> {story.chapterCount} 章</span>
          <span><Clock3 size={15} aria-hidden="true" /> {formatRelativeDate(story.updatedAt)}更新</span>
        </div>
      </div>
    </Link>
  );
}
