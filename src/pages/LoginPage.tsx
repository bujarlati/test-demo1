import { BookOpenText, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/Logo";
import { useApp } from "../context/AppContext";

export function LoginPage() {
  const { login, register } = useApp();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(import.meta.env.DEV ? "admin@xumo.local" : "");
  const [password, setPassword] = useState(import.meta.env.DEV ? "xumo2026" : "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "register") await register(name, email, password);
      else await login(email, password);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "登录失败。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-story" aria-label="续墨产品介绍">
        <Logo />
        <div>
          <span className="eyebrow">PRIVATE LIVING FICTION</span>
          <h1>故事会自己向前。<br />你只需决定，什么不能失去。</h1>
          <p>每个账号拥有独立书架、正史、对话与阅读位置。所有修订保留 Revision，任何改变都不会悄悄发生。</p>
        </div>
        <blockquote>
          <BookOpenText size={20} />
          <span>“潮门在他们身后打开。黑色海水涌入缓冲舱……”</span>
        </blockquote>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={(event) => void submit(event)}>
          <header>
            <span className="login-seal">{mode === "login" ? <LockKeyhole size={21} /> : <UserPlus size={21} />}</span>
            <span className="eyebrow">{mode === "login" ? "欢迎回来" : "第一次来续墨"}</span>
            <h2>{mode === "login" ? "进入你的私人书架" : "创建你的私人书架"}</h2>
            <p>{mode === "login" ? "登录后会恢复上次故事、分支、正史版本与滚动位置。" : "注册只会创建普通读者账号；你的故事、章节与阅读位置都独立保存。"}</p>
          </header>
          {mode === "register" && (
            <label>
              <span>昵称</span>
              <input required maxLength={40} name="name" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          )}
          <label>
            <span>邮箱</span>
            <input required name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            <span>密码</span>
            <div className="secret-input"><KeyRound size={17} /><input required minLength={mode === "register" ? 10 : 8} name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="button button--primary button--large" type="submit" disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={18} /> : mode === "login" ? <BookOpenText size={18} /> : <UserPlus size={18} />}
            {loading ? (mode === "login" ? "正在恢复正史" : "正在创建书架") : (mode === "login" ? "继续阅读" : "注册并进入")}
          </button>
          <button className="login-mode-switch" type="button" onClick={() => {
            setMode((current) => current === "login" ? "register" : "login");
            setError(null);
            if (mode === "login" && import.meta.env.DEV) {
              setEmail("");
              setPassword("");
            }
          }}>{mode === "login" ? "还没有账号？免费注册" : "已经有账号？返回登录"}</button>
          {mode === "login" && (
            <aside className="demo-account">
              <ShieldCheck size={16} />
              <span><strong>演示管理员账号已预填</strong><small>管理员可查看模型网关与审计；普通读者无法访问运营数据。</small></span>
            </aside>
          )}
        </form>
      </section>
    </main>
  );
}
