import { ArrowLeft, ArrowRight, Check, CircleAlert, Dices, LoaderCircle, ServerCog, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { BookCover } from "../components/BookCover";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import { composeCustomTone, CUSTOM_TONE_WORD_MAX_LENGTH, DEFAULT_STORY_LENGTH, getGenreOption, STORY_GENRES, STORY_LENGTH_OPTIONS, STORY_TONES, type StoryGenre, type StoryLengthPlanId } from "../storyConfig";
import type { GenerationModelOption, ModelConnectionStatus } from "../types";

const connectionStatusLabel: Record<ModelConnectionStatus, string> = {
  draft: "待测试",
  validating: "测试中",
  active: "可用",
  degraded: "能力降级",
  disabled: "已停用",
  revoked: "凭据失效",
};

function canGenerateWith(connection: GenerationModelOption) {
  return connection.status === "active" && !connection.managedLocal;
}

function generationAvailability(connection: GenerationModelOption) {
  if (connection.managedLocal) {
    return {
      selectable: false,
      label: "托管占位 · 禁用",
      reason: "本地托管占位不可用于高质量故事生成。",
    };
  }
  if (connection.status !== "active") {
    return {
      selectable: false,
      label: connectionStatusLabel[connection.status],
      reason: "连接尚未通过测试，当前不能用于生成。",
    };
  }
  return { selectable: true, label: null, reason: null };
}

function preferredConnection(connections: GenerationModelOption[]) {
  return connections.find((connection) => canGenerateWith(connection) && connection.isDefault)
    ?? connections.find(canGenerateWith);
}

export function NewStoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, refresh } = useApp();
  const [genre, setGenre] = useState<StoryGenre>("悬疑");
  const [presetTone, setPresetTone] = useState<string>(STORY_TONES[0]);
  const [toneMode, setToneMode] = useState<"preset" | "custom">("preset");
  const [customToneWords, setCustomToneWords] = useState<[string, string]>(["", ""]);
  const [lengthPlan, setLengthPlan] = useState<StoryLengthPlanId>(DEFAULT_STORY_LENGTH.id);
  const [inspiration, setInspiration] = useState("");
  const [creating, setCreating] = useState(false);
  const [stage, setStage] = useState(0);
  const [modelConnectionId, setModelConnectionId] = useState(
    () => preferredConnection(data?.modelConnections ?? [])?.id ?? "",
  );
  const creationIdempotencyKey = useRef(crypto.randomUUID());

  const preview = useMemo(() => getGenreOption(genre), [genre]);
  const selectedLength = useMemo(
    () => STORY_LENGTH_OPTIONS.find((option) => option.id === lengthPlan) ?? DEFAULT_STORY_LENGTH,
    [lengthPlan],
  );
  const customTone = useMemo(
    () => composeCustomTone(customToneWords[0], customToneWords[1]),
    [customToneWords],
  );
  const tone = toneMode === "custom" ? customTone : presetTone;
  const modelConnections = useMemo(() => data?.modelConnections ?? [], [data?.modelConnections]);
  const selectedConnection = useMemo(
    () => modelConnections.find((connection) => connection.id === modelConnectionId && canGenerateWith(connection)),
    [modelConnectionId, modelConnections],
  );

  useEffect(() => {
    setModelConnectionId((currentId) => {
      if (modelConnections.some((connection) => connection.id === currentId && canGenerateWith(connection))) {
        return currentId;
      }
      return preferredConnection(modelConnections)?.id ?? "";
    });
  }, [modelConnections]);

  const randomize = () => {
    setGenre(STORY_GENRES[Math.floor(Math.random() * STORY_GENRES.length)].label);
    setPresetTone(STORY_TONES[Math.floor(Math.random() * STORY_TONES.length)]);
    setToneMode("preset");
    setCustomToneWords(["", ""]);
    setLengthPlan(STORY_LENGTH_OPTIONS[Math.floor(Math.random() * STORY_LENGTH_OPTIONS.length)].id);
    setInspiration("");
  };

  const submit = async () => {
    if (!tone) {
      toast(`请分别输入两个不超过 ${CUSTOM_TONE_WORD_MAX_LENGTH} 个字的基调词语。`, "error");
      return;
    }
    if (!selectedConnection) {
      toast("请先选择一个已通过测试的模型连接；系统不会静默切换模型。", "error");
      return;
    }
    setCreating(true);
    setStage(0);
    const timer = window.setInterval(() => setStage((value) => Math.min(3, value + 1)), 420);
    try {
      const story = await api.createStory({
        genre,
        tone,
        lengthPlan,
        inspiration,
        modelConnectionId: selectedConnection.id,
      }, creationIdempotencyKey.current);
      await refresh();
      toast("第一章已经写好，故事开始了。");
      navigate(`/story/${story.id}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "开书失败，请稍后重试。", "error");
      setCreating(false);
    } finally {
      window.clearInterval(timer);
    }
  };

  return (
    <div className="page page--new-story">
      <header className="page-heading page-heading--compact">
        <div>
          <Link className="back-link" to="/"><ArrowLeft size={16} /> 返回书架</Link>
          <span className="eyebrow">一键开书</span>
          <h1>选一个世界，开始一部长篇连载。</h1>
          <p>覆盖 21 种主流网文题材，默认从 200 章起步。你无需写大纲，也不会被追问情节。</p>
        </div>
        <button className="button button--ghost" type="button" onClick={randomize}>
          <Dices size={18} /> 完全随机
        </button>
      </header>

      <div className="story-builder">
        <form className="story-builder__form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <fieldset>
            <legend><span>01</span> 你想先走进哪种故事？ <em>必选</em></legend>
            <div className="choice-grid choice-grid--genres">
              {STORY_GENRES.map((item) => (
                <label key={item.label} className={genre === item.label ? "selected" : ""}>
                  <input type="radio" name="genre" value={item.label} checked={genre === item.label} onChange={() => setGenre(item.label)} />
                  <span><strong>{item.label}</strong><small>{item.note}</small></span>
                  {genre === item.label && <Check size={16} />}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend><span>02</span> 阅读时希望是什么感觉？ <small>选择预设，或自定义两个词语</small></legend>
            <div className="pill-options">
              {STORY_TONES.map((item) => (
                <button type="button" key={item} className={toneMode === "preset" && presetTone === item ? "selected" : ""} onClick={() => { setPresetTone(item); setToneMode("preset"); }}>{item}</button>
              ))}
            </div>
            <div className={`custom-tone ${toneMode === "custom" ? "selected" : ""}`}>
              <div className="custom-tone__heading">
                <strong>自定义基调</strong>
                <small>每个词语最多 {CUSTOM_TONE_WORD_MAX_LENGTH} 个字</small>
              </div>
              <div className="custom-tone__fields">
                <label>
                  <span>第一个词语</span>
                  <input
                    aria-label="第一个基调词语"
                    value={customToneWords[0]}
                    maxLength={CUSTOM_TONE_WORD_MAX_LENGTH}
                    placeholder="例如：清冷"
                    onFocus={() => setToneMode("custom")}
                    onChange={(event) => { setToneMode("custom"); setCustomToneWords([event.target.value, customToneWords[1]]); }}
                  />
                </label>
                <span className="custom-tone__separator" aria-hidden="true">·</span>
                <label>
                  <span>第二个词语</span>
                  <input
                    aria-label="第二个基调词语"
                    value={customToneWords[1]}
                    maxLength={CUSTOM_TONE_WORD_MAX_LENGTH}
                    placeholder="例如：浪漫"
                    onFocus={() => setToneMode("custom")}
                    onChange={(event) => { setToneMode("custom"); setCustomToneWords([customToneWords[0], event.target.value]); }}
                  />
                </label>
                <div className="custom-tone__result" aria-live="polite">
                  <small>组合效果</small>
                  <strong>{customTone ?? "等待两个词语"}</strong>
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend><span>03</span> 规划多长的连载？ <small>后续可自然收束</small></legend>
            <div className="choice-grid choice-grid--lengths">
              {STORY_LENGTH_OPTIONS.map((item) => (
                <label key={item.id} className={lengthPlan === item.id ? "selected" : ""}>
                  <input type="radio" name="length" value={item.id} checked={lengthPlan === item.id} onChange={() => setLengthPlan(item.id)} />
                  <span><strong>{item.name}</strong><small>{item.chapterCount} 章 · {item.note}</small></span>
                  {lengthPlan === item.id && <Check size={16} />}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend><span>04</span> 有没有一个模糊的念头？ <small>可选 · 180 字以内</small></legend>
            <textarea
              value={inspiration}
              maxLength={180}
              onChange={(event) => setInspiration(event.target.value)}
              placeholder="例如：发生在海底城市；主角收到一封来自未来的信……"
              rows={4}
            />
            <div className="textarea-meta"><span>不用解释如何写</span><span>{inspiration.length}/180</span></div>
          </fieldset>

          <fieldset>
            <legend><span>05</span> 选择本次生成模型 <em>必选</em></legend>
            {modelConnections.length > 0 && (
              <div className="choice-grid choice-grid--models" role="radiogroup" aria-label="本次生成模型">
                {modelConnections.map((connection) => {
                  const availability = generationAvailability(connection);
                  const selectable = availability.selectable;
                  const selected = modelConnectionId === connection.id;
                  return (
                    <label
                      key={connection.id}
                      className={`${selected ? "selected" : ""}${selectable ? "" : " disabled"}`.trim()}
                    >
                      <input
                        type="radio"
                        name="model-connection"
                        value={connection.id}
                        checked={selected}
                        disabled={!selectable}
                        onChange={() => setModelConnectionId(connection.id)}
                      />
                      <span className="model-choice__icon"><ServerCog size={18} /></span>
                      <span className="model-choice__body">
                        <span className="model-choice__heading">
                          <strong>{connection.name}</strong>
                          {connection.isDefault && <small className="model-choice__tag">账号默认</small>}
                          {!selectable && (
                            <small className="model-choice__tag model-choice__tag--disabled">
                              {availability.label}
                            </small>
                          )}
                        </span>
                        <span className="model-choice__routes">
                          <span><small>Planner · 规划</small><strong>{connection.plannerModel}</strong></span>
                          <span><small>Writer · 正文</small><strong>{connection.writerModel}</strong></span>
                        </span>
                        {!selectable && (
                          <small className="model-choice__reason">{availability.reason}</small>
                        )}
                      </span>
                      {selected && <Check className="model-choice__check" size={16} />}
                    </label>
                  );
                })}
              </div>
            )}
            {!selectedConnection && (
              <div className="model-choice-empty" role="alert">
                <CircleAlert size={18} />
                <span>
                  <strong>暂无可用于高质量生成的模型连接</strong>
                  <small>请先新增并测试一个自定义连接，再回来开始故事。</small>
                </span>
                <Link className="text-link" to="/settings/models">前往模型连接</Link>
              </div>
            )}
            <p className="model-choice-note">第一章固定使用所选 Planner 与 Writer；开篇失败时会停止并明确报错，不会静默切换。后续章节按该连接已配置的回退策略执行。</p>
          </fieldset>

          <button className="button button--primary button--large story-builder__submit" type="submit" disabled={creating || !tone || !selectedConnection}>
            {creating ? <><LoaderCircle className="spin" size={19} /> 正在让故事醒来</> : <><Sparkles size={18} /> 生成第一章 <ArrowRight size={18} /></>}
          </button>
          <p className="form-footnote">系统会在后台生成故事基因、人物与暂定结局，但不会提前剧透。</p>
        </form>

        <aside className="story-builder__preview" aria-label="新故事预览">
          <span className="eyebrow">你的下一本书</span>
          <BookCover
            title={preview.previewTitle}
            subtitle={inspiration || "标题与故事仍会在生成时变化"}
            theme={preview.coverTheme}
            size="large"
          />
          <dl>
            <div><dt>题材</dt><dd>{genre}</dd></div>
            <div><dt>氛围</dt><dd>{tone ?? "等待两个词语"}</dd></div>
            <div><dt>规模</dt><dd>{selectedLength.chapterCount} 章</dd></div>
          </dl>
          <p>第一章生成后直接进入阅读，不展示大纲确认页。</p>
        </aside>
      </div>

      {creating && (
        <div className="creation-overlay" role="status" aria-live="polite">
          <div className="creation-dialog">
            <span className="creation-orbit" aria-hidden="true"><Sparkles size={22} /></span>
            <h2>故事正在找到自己的方向</h2>
            <ol>
              {["生成故事基因与世界规则", "认识第一位角色", "选择冲突与代价", "写下第一章"].map((item, index) => (
                <li key={item} className={index < stage ? "done" : index === stage ? "active" : ""}>
                  <span>{index < stage ? <Check size={14} /> : index + 1}</span>{item}
                </li>
              ))}
            </ol>
            <p>不需要继续输入，完成后会自动翻开第一页。</p>
          </div>
        </div>
      )}
    </div>
  );
}
