import {
  BarChart3,
  BookOpenText,
  ChevronRight,
  Library,
  LoaderCircle,
  LogOut,
  Plus,
  Settings2,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { Logo } from "./Logo";

const navigation = [
  { to: "/", label: "我的书架", icon: Library, end: true },
  { to: "/new", label: "开始新故事", icon: Plus },
  { to: "/settings/models", label: "模型连接", icon: Settings2 },
  { to: "/ops", label: "生成观察台", icon: BarChart3 },
];

export function AppShell() {
  const { data, logout } = useApp();
  const activeStory = data?.stories.find((story) => story.id === data.activeStoryId);
  const visibleNavigation = data?.user.role === "admin"
    ? navigation
    : navigation.filter((item) => item.to !== "/settings/models" && item.to !== "/ops");
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <Logo />
        <nav className="sidebar__nav" aria-label="主导航">
          {visibleNavigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {Boolean(data?.pendingJobs.length) && (
          <div className="sidebar__jobs" role="status" aria-live="polite">
            <LoaderCircle size={16} />
            <span>
              <strong>续写仍在后台进行</strong>
              <small>{data?.pendingJobs[0]?.storyTitle} · 第 {data?.pendingJobs[0]?.chapterNumber} 章</small>
            </span>
          </div>
        )}

        {Boolean(data?.recoverableJobs.length) && !data?.pendingJobs.length && (
          <NavLink className="sidebar__jobs sidebar__jobs--failed" to={`/story/${data?.recoverableJobs[0]?.storyId}`}>
            <LoaderCircle size={16} />
            <span><strong>上次续写被中断</strong><small>{data?.recoverableJobs[0]?.storyTitle} · 可安全重试</small></span>
          </NavLink>
        )}

        {activeStory && (
          <div className="sidebar__continue">
            <span className="eyebrow">正在阅读</span>
            <strong>{activeStory.title}</strong>
            <span>第 {activeStory.currentChapterNumber} 章 · {activeStory.currentChapterTitle}</span>
            <NavLink to={`/story/${activeStory.id}`}>
              继续阅读 <ChevronRight size={15} />
            </NavLink>
          </div>
        )}

        <div className="sidebar__profile">
          <span className="avatar">{data?.user.initials ?? "默"}</span>
          <span>
            <strong>{data?.user.name ?? "读者"}</strong>
            <small>{data?.user.role === "admin" ? "平台管理员 · 私人书架" : "私人书架"}</small>
          </span>
          <button type="button" aria-label="退出登录" title="退出登录" onClick={() => void logout()}><LogOut size={16} /></button>
        </div>
      </aside>

      <header className="mobile-header">
        <Logo />
        <span className="avatar">{data?.user.initials ?? "默"}</span>
      </header>

      <main className="app-main" id="main-content">
        <Outlet />
      </main>

      <nav className="mobile-nav" aria-label="移动端主导航">
        {visibleNavigation.filter((item) => item.to !== "/ops").slice(0, 3).map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon size={20} />
            <span>{label === "开始新故事" ? "新故事" : label.replace("我的", "")}</span>
          </NavLink>
        ))}
        {activeStory && (
          <NavLink to={`/story/${activeStory.id}`}>
            <BookOpenText size={20} />
            <span>阅读</span>
          </NavLink>
        )}
      </nav>
    </div>
  );
}
