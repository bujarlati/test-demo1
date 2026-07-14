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
import type { BootstrapPayload } from "../types";

interface AppContextValue {
  data: BootstrapPayload | null;
  loading: boolean;
  error: string | null;
  authRequired: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
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
    () => ({ data, loading, error, authRequired, login, logout, refresh }),
    [authRequired, data, error, loading, login, logout, refresh],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp 必须在 AppProvider 内使用。");
  return context;
}
