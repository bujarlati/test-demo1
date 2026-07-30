import {
  BookOpenText,
  CircleAlert,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { PublicStoryCard } from "../components/PublicStoryCard";
import {
  PUBLIC_STORY_PAGE_SIZE,
  createPublicStoryListState,
  parsePublicStoryGenre,
  publicStoryListReducer,
  type PublicStoryFilters,
} from "../publicStoryState";
import { STORY_GENRES } from "../storyConfig";
import "../publicLibrary.css";

interface PublicLibraryLocationState {
  unavailablePublicStoryId?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "公共书库暂时无法加载，请稍后重试。";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function PublicLibraryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const rawGenre = searchParams.get("genre");
  const query = searchParams.get("q")?.trim() ?? "";
  const genre = parsePublicStoryGenre(rawGenre);
  const filters = useMemo<PublicStoryFilters>(() => ({ query, genre }), [genre, query]);
  const filterKey = `${query}\u0000${genre ?? ""}`;
  const searchKey = searchParams.toString();
  const [searchInput, setSearchInput] = useState(query);
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, dispatch] = useReducer(
    publicStoryListReducer,
    filters,
    createPublicStoryListState,
  );
  const requestIdRef = useRef(0);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const stateMatchesFilters = state.filters.query === query && state.filters.genre === genre;

  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  useEffect(() => {
    if (!rawGenre || genre) return;
    const next = new URLSearchParams(searchKey);
    next.delete("genre");
    setSearchParams(next, { replace: true });
  }, [genre, rawGenre, searchKey, setSearchParams]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const nextQuery = searchInput.trim();
      if (nextQuery === query) return;
      const next = new URLSearchParams(searchKey);
      if (nextQuery) next.set("q", nextQuery);
      else next.delete("q");
      setSearchParams(next, { replace: true });
    }, 320);
    return () => window.clearTimeout(timeout);
  }, [query, searchInput, searchKey, setSearchParams]);

  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    dispatch({ type: "filters_changed", filters });
    dispatch({ type: "request_started", requestId, append: false });

    void api.publicStories({
      query: filters.query || undefined,
      genre: filters.genre ?? undefined,
      limit: PUBLIC_STORY_PAGE_SIZE,
    }, controller.signal).then(
      (page) => dispatch({ type: "request_succeeded", requestId, append: false, page }),
      (error: unknown) => {
        if (!isAbortError(error)) {
          dispatch({ type: "request_failed", requestId, message: errorMessage(error) });
        }
      },
    );

    return () => controller.abort();
  }, [filterKey, retryVersion]);

  useEffect(() => {
    const locationState = location.state as PublicLibraryLocationState | null;
    if (!locationState?.unavailablePublicStoryId) return;
    dispatch({ type: "story_unavailable", storyId: locationState.unavailablePublicStoryId });
    void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate]);

  useEffect(() => () => loadMoreControllerRef.current?.abort(), []);

  const setGenre = (value: string) => {
    const next = new URLSearchParams(searchKey);
    const selectedGenre = parsePublicStoryGenre(value);
    if (selectedGenre) next.set("genre", selectedGenre);
    else next.delete("genre");
    setSearchParams(next);
  };

  const clearFilters = () => {
    setSearchInput("");
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const loadMore = async () => {
    if (!stateMatchesFilters || !state.nextCursor || state.loading !== "idle") return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    dispatch({ type: "request_started", requestId, append: true });
    try {
      const page = await api.publicStories({
        query: state.filters.query || undefined,
        genre: state.filters.genre ?? undefined,
        cursor: state.nextCursor,
        limit: PUBLIC_STORY_PAGE_SIZE,
      }, controller.signal);
      dispatch({ type: "request_succeeded", requestId, append: true, page });
    } catch (error) {
      if (!isAbortError(error)) {
        dispatch({ type: "request_failed", requestId, message: errorMessage(error) });
      }
    } finally {
      if (loadMoreControllerRef.current === controller) loadMoreControllerRef.current = null;
    }
  };

  const initialLoading = !stateMatchesFilters || (state.loading === "initial" && !state.hasLoaded);
  const hasFilters = Boolean(query || genre);

  return (
    <div className="page page--public-library">
      <header className="public-library-hero">
        <div>
          <span className="eyebrow">注册读者共享书架</span>
          <h1>大家的故事</h1>
          <p>看看其他作者正在写什么。公开作品会随作者的当前正史自动更新。</p>
        </div>
        <div className="public-library-hero__mark" aria-hidden="true">
          <BookOpenText size={28} />
          <span>PUBLIC<br />LIBRARY</span>
        </div>
      </header>

      <section className="public-library-controls" aria-label="筛选公开作品">
        <label className="public-library-search">
          <Search size={19} aria-hidden="true" />
          <span className="sr-only">搜索书名或作者笔名</span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索书名或作者笔名"
            autoComplete="off"
          />
          {searchInput && (
            <button type="button" onClick={() => setSearchInput("")} aria-label="清空搜索">
              <X size={17} />
            </button>
          )}
        </label>
        <label className="public-library-select">
          <SlidersHorizontal size={18} aria-hidden="true" />
          <span className="sr-only">按题材筛选</span>
          <select value={genre ?? ""} onChange={(event) => setGenre(event.target.value)}>
            <option value="">全部题材</option>
            {STORY_GENRES.map((option) => (
              <option value={option.label} key={option.label}>{option.label}</option>
            ))}
          </select>
        </label>
        <span className="public-library-sort">最近更新优先</span>
      </section>

      {state.unavailableStoryRemoved && (
        <div className="public-library-notice" role="status">
          <CircleAlert size={18} aria-hidden="true" />
          <span>这部作品刚刚取消公开，已从书库中移除。</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => dispatch({ type: "unavailable_notice_dismissed" })}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div className="public-library-result-heading" aria-live="polite">
        <div>
          <span className="eyebrow">公开正史</span>
          <h2>{hasFilters ? "筛选结果" : "最近更新"}</h2>
        </div>
        {!initialLoading && !state.error && <span>已显示 {state.stories.length} 本</span>}
      </div>

      {initialLoading ? (
        <div className="public-story-grid" aria-label="正在加载公开作品" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="public-story-skeleton" key={index} aria-hidden="true">
              <span />
              <div><i /><i /><i /></div>
            </div>
          ))}
        </div>
      ) : state.error && state.stories.length === 0 ? (
        <section className="public-library-state" role="alert">
          <CircleAlert size={28} />
          <h2>书库暂时没有打开</h2>
          <p>{state.error}</p>
          <button className="button button--secondary" type="button" onClick={() => setRetryVersion((value) => value + 1)}>
            再试一次
          </button>
        </section>
      ) : state.stories.length === 0 ? (
        <section className="public-library-state">
          <Sparkles size={30} />
          <h2>{hasFilters ? "没有找到符合条件的故事" : "还没有作者公开故事"}</h2>
          <p>{hasFilters ? "换个书名、笔名或题材再找找。" : "第一位公开作品的作者，也许就是你。"}</p>
          {hasFilters && <button className="button button--secondary" type="button" onClick={clearFilters}>清除筛选</button>}
        </section>
      ) : (
        <>
          <div className="public-story-grid">
            {state.stories.map((story) => <PublicStoryCard story={story} key={story.id} />)}
          </div>
          {state.error && (
            <div className="public-library-inline-error" role="alert">
              <CircleAlert size={17} />
              <span>{state.error}</span>
            </div>
          )}
          {state.nextCursor && (
            <button
              className="button button--secondary public-library-load-more"
              type="button"
              disabled={state.loading !== "idle"}
              onClick={() => void loadMore()}
            >
              {state.loading === "more" && <LoaderCircle className="spin" size={17} />}
              {state.loading === "more" ? "正在取下一页" : "加载更多故事"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
