import {
  BarChart3,
  BookOpenText,
  ChevronRight,
  CircleAlert,
  Compass,
  Library,
  LoaderCircle,
  LogOut,
  Plus,
  Settings2,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { recoveryNoticeForJob } from "../jobRecovery";
import { Logo } from "./Logo";

export function AppShell() {
  const { data, logout } = useApp();
  const navigation = [
    { to: "/", label: "我的书架", icon: Library, end: true },
    ...(data?.features.publicStorySharing
      ? [{ to: "/discover", label: "大家的故事", icon: Compass, end: true }]
      : []),
    { to: "/new", label: "开始新故事", icon: Plus },
    { to: "/settings/models", label: "模型连接", icon: Settings2 },
    { to: "/ops", label: "生成观察台", icon: BarChart3 },
  ];
  const activeStory = data?.stories.find((story) => story.id === data.activeStoryId);
  const pendingJob = data?.pendingJobs.find((job) => job.status === "awaiting_user_review")
    ?? data?.pendingJobs[0];
  const availableStoryIds = new Set(data?.stories.map((story) => story.id) ?? []);
  const recoveryNotice = data?.recoverableJobs
    .map((job) => recoveryNoticeForJob(job, availableStoryIds))
    .find((notice) => notice !== null);
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

        {pendingJob?.status === "awaiting_user_review" ? (
          <NavLink className="sidebar__jobs sidebar__jobs--review" to={`/new?job=${encodeURIComponent(pendingJob.id)}`}>
            <CircleAlert size={16} />
            <span><strong>有一句话等你判断</strong><small>查看上下文并选择保留或重写</small></span>
          </NavLink>
        ) : pendingJob ? (
          <div className="sidebar__jobs" role="status" aria-live="polite">
            <LoaderCircle size={16} />
            <span>
              <strong>{pendingJob.task === "opening" ? "新故事仍在生成" : "续写仍在后台进行"}</strong>
              <small>{pendingJob.task === "opening" ? "正在准备第一章" : `${pendingJob.storyTitle} · 第 ${pendingJob.chapterNumber} 章`}</small>
            </span>
          </div>
        ) : null}

        {recoveryNotice && !pendingJob && (
          <NavLink className="sidebar__jobs sidebar__jobs--failed" to={recoveryNotice.to}>
            <LoaderCircle size={16} />
            <span><strong>{recoveryNotice.title}</strong><small>{recoveryNotice.detail}</small></span>
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
            <span>{label === "开始新故事"
              ? "新故事"
              : label === "大家的故事"
                ? "发现"
                : label.replace("我的", "")}</span>
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
