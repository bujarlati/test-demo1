import { ArrowLeft, ArrowRight, Check, Dices, LoaderCircle, Sparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { BookCover } from "../components/BookCover";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import type { CoverTheme } from "../types";

const genres = [
  { label: "悬疑", note: "秘密与因果" },
  { label: "科幻", note: "未来与选择" },
  { label: "奇幻", note: "规则与代价" },
  { label: "治愈", note: "日常与相遇" },
];
const tones = ["冷冽 · 克制", "温暖 · 轻盈", "诡谲 · 梦境", "明快 · 冒险"];
const lengths = ["短篇 · 预计 12 章", "中篇 · 预计 24 章", "长篇 · 预计 60 章"];
const themeByGenre: Record<string, CoverTheme> = {
  悬疑: "tide",
  科幻: "moon",
  奇幻: "fog",
  治愈: "ember",
};
const titleByGenre: Record<string, string> = {
  悬疑: "潮汐背面",
  科幻: "第七次日落",
  奇幻: "灯塔之外",
  治愈: "风从面包房来",
};

export function NewStoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { refresh } = useApp();
  const [genre, setGenre] = useState("悬疑");
  const [tone, setTone] = useState(tones[0]);
  const [length, setLength] = useState(lengths[1]);
  const [inspiration, setInspiration] = useState("");
  const [creating, setCreating] = useState(false);
  const [stage, setStage] = useState(0);
  const creationIdempotencyKey = useRef(crypto.randomUUID());

  const preview = useMemo(
    () => ({ title: titleByGenre[genre], theme: themeByGenre[genre] }),
    [genre],
  );

  const randomize = () => {
    setGenre(genres[Math.floor(Math.random() * genres.length)].label);
    setTone(tones[Math.floor(Math.random() * tones.length)]);
    setLength(lengths[Math.floor(Math.random() * lengths.length)]);
    setInspiration("");
  };

  const submit = async () => {
    setCreating(true);
    setStage(0);
    const timer = window.setInterval(() => setStage((value) => Math.min(3, value + 1)), 420);
    try {
      const story = await api.createStory({ genre, tone, length, inspiration }, creationIdempotencyKey.current);
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
          <h1>给故事一点方向，剩下的交给它。</h1>
          <p>只有题材必选。你无需写大纲，也不会在下一页被追问情节。</p>
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
              {genres.map((item) => (
                <label key={item.label} className={genre === item.label ? "selected" : ""}>
                  <input type="radio" name="genre" value={item.label} checked={genre === item.label} onChange={() => setGenre(item.label)} />
                  <span><strong>{item.label}</strong><small>{item.note}</small></span>
                  {genre === item.label && <Check size={16} />}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend><span>02</span> 阅读时希望是什么感觉？ <small>可跳过</small></legend>
            <div className="pill-options">
              {tones.map((item) => (
                <button type="button" key={item} className={tone === item ? "selected" : ""} onClick={() => setTone(item)}>{item}</button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend><span>03</span> 想陪它走多久？ <small>可跳过</small></legend>
            <div className="pill-options">
              {lengths.map((item) => (
                <button type="button" key={item} className={length === item ? "selected" : ""} onClick={() => setLength(item)}>{item}</button>
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

          <button className="button button--primary button--large story-builder__submit" type="submit" disabled={creating}>
            {creating ? <><LoaderCircle className="spin" size={19} /> 正在让故事醒来</> : <><Sparkles size={18} /> 生成第一章 <ArrowRight size={18} /></>}
          </button>
          <p className="form-footnote">系统会在后台生成故事基因、人物与暂定结局，但不会提前剧透。</p>
        </form>

        <aside className="story-builder__preview" aria-label="新故事预览">
          <span className="eyebrow">你的下一本书</span>
          <BookCover
            title={preview.title}
            subtitle={inspiration || "标题与故事仍会在生成时变化"}
            theme={preview.theme}
            size="large"
          />
          <dl>
            <div><dt>题材</dt><dd>{genre}</dd></div>
            <div><dt>氛围</dt><dd>{tone}</dd></div>
            <div><dt>长度</dt><dd>{length.split(" · ")[0]}</dd></div>
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
