import { BookOpenText, Minus, Moon, Plus, Sun } from "lucide-react";
import { useId } from "react";
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
  type ReaderTheme,
} from "../readerSettings";

interface ReaderSettingsControlsProps {
  settings: ReaderSettings;
  onChange: (settings: ReaderSettings) => void;
  onReset?: () => void;
}

const themes: ReadonlyArray<{
  id: ReaderTheme;
  label: string;
  icon: typeof Sun;
}> = [
  { id: "paper", label: "纸张", icon: Sun },
  { id: "mist", label: "雾白", icon: BookOpenText },
  { id: "night", label: "夜读", icon: Moon },
];

export function ReaderSettingsControls({
  settings,
  onChange,
  onReset,
}: ReaderSettingsControlsProps) {
  const lineHeightId = useId();
  const widthId = useId();
  const update = <Key extends keyof ReaderSettings>(key: Key, value: ReaderSettings[Key]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <>
      <section>
        <label>阅读主题</label>
        <div className="theme-options">
          {themes.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={settings.theme === id ? "active" : ""}
              aria-pressed={settings.theme === id}
              onClick={() => update("theme", id)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <label>正文字号 <strong>{settings.fontSize}px</strong></label>
        <div className="stepper">
          <button
            type="button"
            aria-label="减小字号"
            onClick={() => update("fontSize", Math.max(16, settings.fontSize - 1))}
          >
            <Minus size={16} />
          </button>
          <span style={{ fontSize: `${settings.fontSize}px` }}>读</span>
          <button
            type="button"
            aria-label="增大字号"
            onClick={() => update("fontSize", Math.min(26, settings.fontSize + 1))}
          >
            <Plus size={16} />
          </button>
        </div>
      </section>
      <section>
        <label htmlFor={lineHeightId}>行间距 <strong>{settings.lineHeight.toFixed(2)}</strong></label>
        <input
          id={lineHeightId}
          type="range"
          min="1.6"
          max="2.3"
          step="0.05"
          value={settings.lineHeight}
          onChange={(event) => update("lineHeight", Number(event.target.value))}
        />
      </section>
      <section>
        <label htmlFor={widthId}>正文宽度 <strong>{settings.width}px</strong></label>
        <input
          id={widthId}
          type="range"
          min="600"
          max="820"
          step="20"
          value={settings.width}
          onChange={(event) => update("width", Number(event.target.value))}
        />
      </section>
      {onReset && (
        <button type="button" className="text-link reset-settings" onClick={onReset}>
          恢复默认阅读设置
        </button>
      )}
    </>
  );
}

export function defaultReaderSettings(): ReaderSettings {
  return { ...DEFAULT_READER_SETTINGS };
}
