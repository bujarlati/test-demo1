import type { CoverTheme } from "../types";

interface BookCoverProps {
  title: string;
  subtitle?: string;
  theme: CoverTheme;
  size?: "small" | "medium" | "large";
  className?: string;
}

export function BookCover({ title, subtitle, theme, size = "medium", className = "" }: BookCoverProps) {
  return (
    <div className={`book-cover book-cover--${theme} book-cover--${size} ${className}`} aria-label={`${title}封面`}>
      <span className="book-cover__edition">XUMO · ORIGINAL</span>
      <span className="book-cover__ornament" aria-hidden="true" />
      <span className="book-cover__title">{title}</span>
      {subtitle && <span className="book-cover__subtitle">{subtitle}</span>}
      <span className="book-cover__folio" aria-hidden="true">AI SERIAL</span>
    </div>
  );
}
