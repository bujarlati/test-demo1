import {
  BarChart3,
  BookOpenText,
  ChevronRight,
  Library,
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
  const { data } = useApp();
  const activeStory = data?.stories.find((story) => story.id === data.activeStoryId);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <Logo />
        <nav className="sidebar__nav" aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

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
            <small>私人书架</small>
          </span>
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
        {navigation.slice(0, 3).map(({ to, label, icon: Icon, end }) => (
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
