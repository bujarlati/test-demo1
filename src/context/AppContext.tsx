import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, ApiError, authStore } from "../api";
import type { BootstrapPayload, OpeningJobStatusPayload } from "../types";

interface AppContextValue {
  data: BootstrapPayload | null;
  loading: boolean;
  error: string | null;
  authRequired: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  reconcileOpeningJobStatus: (status: OpeningJobStatusPayload) => void;
  loadMoreStories: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(!authStore.get());

  const refresh = useCallback(async () => {
    if (!authStore.get()) {
      setAuthRequired(true);
      setLoading(false);
      return;
    }
    try {
      setError(null);
      setData(await api.bootstrap());
      setAuthRequired(false);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        authStore.clear();
        setData(null);
        setAuthRequired(true);
        setError(null);
        return;
      }
      setError(requestError instanceof Error ? requestError.message : "应用数据加载失败。请确认服务已启动。");
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    authStore.set(result.token);
    setAuthRequired(false);
    setLoading(true);
    await refresh();
  }, [refresh]);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const result = await api.register(name, email, password);
    authStore.set(result.token);
    setAuthRequired(false);
    setLoading(true);
    await refresh();
  }, [refresh]);

  const loadMoreStories = useCallback(async () => {
    const cursor = data?.storyPage.nextCursor;
    if (!cursor) return;
    const page = await api.stories(cursor);
    setData((current) => current ? {
      ...current,
      stories: [
        ...current.stories,
        ...page.stories.filter((story) => !current.stories.some((existing) => existing.id === story.id)),
      ],
      storyPage: {
        nextCursor: page.nextCursor,
        totalStories: page.totalStories,
        totalChapters: page.totalChapters,
      },
    } : current);
  }, [data?.storyPage.nextCursor]);

  const reconcileOpeningJobStatus = useCallback((status: OpeningJobStatusPayload) => {
    setData((current) => {
      if (!current) return current;
      if (status.status === "completed" || status.status === "failed") {
        return {
          ...current,
          pendingJobs: current.pendingJobs.filter((job) => job.id !== status.jobId),
        };
      }
      return {
        ...current,
        pendingJobs: current.pendingJobs.map((job) => job.id === status.jobId
          ? { ...job, status: status.status }
          : job),
      };
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      authStore.clear();
      setData(null);
      setAuthRequired(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      data,
      loading,
      error,
      authRequired,
      login,
      register,
      logout,
      refresh,
      reconcileOpeningJobStatus,
      loadMoreStories,
    }),
    [authRequired, data, error, loading, loadMoreStories, login, logout, reconcileOpeningJobStatus, refresh, register],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp 必须在 AppProvider 内使用。");
  return context;
}
