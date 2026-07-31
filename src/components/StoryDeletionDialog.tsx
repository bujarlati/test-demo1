import { LoaderCircle, ShieldAlert, Trash2, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { storyDeletionTitleMatches } from "../storyDeletion";
import "../storyDeletion.css";

interface StoryDeletionDialogProps {
  open: boolean;
  storyTitle: string;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(confirmationTitle: string): Promise<void>;
}

const ERROR_ID = "story-deletion-error";

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.tabIndex >= 0
    && !element.hidden
    && element.getAttribute("aria-hidden") !== "true");
}

function containDialogFocus(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== "Tab") return;
  const elements = focusableElements(event.currentTarget);
  if (elements.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }

  const first = elements[0]!;
  const last = elements.at(-1)!;
  const activeIndex = elements.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && activeIndex <= 0) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === elements.length - 1)) {
    event.preventDefault();
    first.focus();
  }
}

export function StoryDeletionDialog({
  open,
  storyTitle,
  busy,
  error,
  onClose,
  onConfirm,
}: StoryDeletionDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [confirmationTitle, setConfirmationTitle] = useState("");

  useLayoutEffect(() => {
    if (!open) return;
    setConfirmationTitle("");
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open && busy) dialogRef.current?.focus();
  }, [busy, open]);

  useLayoutEffect(() => {
    if (open && !busy && error) inputRef.current?.focus();
  }, [busy, error, open]);

  if (!open) return null;
  const matches = storyDeletionTitleMatches(storyTitle, confirmationTitle);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !matches) return;
    void onConfirm(confirmationTitle.trim());
  };

  return createPortal(
    <div
      className="modal-backdrop story-deletion-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (busy) dialogRef.current?.focus();
        else onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="story-deletion-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby="story-deletion-title"
        aria-describedby="story-deletion-description"
        tabIndex={-1}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
            else dialogRef.current?.focus();
            return;
          }
          containDialogFocus(event);
        }}
      >
        <header>
          <span className="story-deletion-dialog__icon" aria-hidden="true"><ShieldAlert size={22} /></span>
          <div>
            <span className="eyebrow">危险操作</span>
            <h2 id="story-deletion-title">永久删除故事</h2>
          </div>
          <button type="button" aria-label="关闭永久删除确认" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="story-deletion-dialog__body">
          <p id="story-deletion-description">
            正文、全部版本历史、公开链接和所有读者进度都会永久删除，且无法恢复。
          </p>
          <label htmlFor="story-deletion-confirmation">
            <span>请输入完整故事标题以确认</span>
            <strong>{storyTitle}</strong>
            <input
              ref={inputRef}
              id="story-deletion-confirmation"
              value={confirmationTitle}
              readOnly={busy}
              aria-invalid={Boolean(error)}
              aria-errormessage={error ? ERROR_ID : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setConfirmationTitle(event.target.value)}
            />
          </label>
          {error && <p id={ERROR_ID} className="story-deletion-dialog__error" role="alert">{error}</p>}
        </div>

        <footer>
          <span className="story-deletion-dialog__status" role="status" aria-live="polite" aria-atomic="true">
            {busy ? "正在永久删除故事，请稍候。" : ""}
          </span>
          <button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="button button--danger" type="submit" disabled={busy || !matches}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            {busy ? "正在删除…" : "永久删除"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
