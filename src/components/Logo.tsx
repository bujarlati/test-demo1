import { Link } from "react-router-dom";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className={`brand${compact ? " brand--compact" : ""}`} aria-label="续墨书架">
      <span className="brand__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {!compact && (
        <span className="brand__text">
          <strong>续墨</strong>
          <small>故事仍在继续</small>
        </span>
      )}
    </Link>
  );
}
