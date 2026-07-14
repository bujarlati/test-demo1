import { BookOpenText, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/Logo";
import { useApp } from "../context/AppContext";

export function LoginPage() {
  const { login } = useApp();
  const [email, setEmail] = useState("admin@xumo.local");
  const [password, setPassword] = useState("xumo2026");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
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
            <span className="login-seal"><LockKeyhole size={21} /></span>
            <span className="eyebrow">欢迎回来</span>
            <h2>进入你的私人书架</h2>
            <p>登录后会恢复上次故事、分支、正史版本与滚动位置。</p>
          </header>
          <label>
            <span>邮箱</span>
            <input required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            <span>密码</span>
            <div className="secret-input"><KeyRound size={17} /><input required minLength={8} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="button button--primary button--large" type="submit" disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={18} /> : <BookOpenText size={18} />}
            {loading ? "正在恢复正史" : "继续阅读"}
          </button>
          <aside className="demo-account">
            <ShieldCheck size={16} />
            <span><strong>演示管理员账号已预填</strong><small>管理员可查看模型网关与审计；普通读者无法访问运营数据。</small></span>
          </aside>
        </form>
      </section>
    </main>
  );
}
