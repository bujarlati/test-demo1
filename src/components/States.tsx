import { LoaderCircle, RefreshCcw } from "lucide-react";

export function LoadingState({ label = "正在载入故事…" }: { label?: string }) {
  return (
    <div className="state-panel state-panel--loading" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button className="button button--secondary" type="button" onClick={onRetry}>
          <RefreshCcw size={16} /> 重新加载
        </button>
      )}
    </div>
  );
}
