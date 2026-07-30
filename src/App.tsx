import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { LoadingState } from "./components/States";
import { useApp } from "./context/AppContext";
import { ArchivePage } from "./pages/ArchivePage";
import { HistoryPage } from "./pages/HistoryPage";
import { LibraryPage } from "./pages/LibraryPage";
import { LoginPage } from "./pages/LoginPage";
import { ModelSettingsPage } from "./pages/ModelSettingsPage";
import { NewStoryPage } from "./pages/NewStoryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OpsPage } from "./pages/OpsPage";
import { PublicLibraryPage } from "./pages/PublicLibraryPage";
import { PublicReaderPage } from "./pages/PublicReaderPage";
import { ReaderPage } from "./pages/ReaderPage";

export function App() {
  const { authRequired, data, loading } = useApp();
  if (authRequired) return <LoginPage />;
  if (loading && !data) return <main className="reader-state"><LoadingState label="正在恢复私人书架与正史…" /></main>;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<LibraryPage />} />
        <Route
          path="discover"
          element={data?.features.publicStorySharing ? <PublicLibraryPage /> : <Navigate to="/" replace />}
        />
        <Route path="new" element={<NewStoryPage />} />
        <Route path="story/:storyId/archive" element={<ArchivePage />} />
        <Route path="story/:storyId/history" element={<HistoryPage />} />
        <Route path="settings/models" element={data?.user.role === "admin" ? <ModelSettingsPage /> : <Navigate to="/" replace />} />
        <Route path="ops" element={data?.user.role === "admin" ? <OpsPage /> : <Navigate to="/" replace />} />
      </Route>
      <Route
        path="public/story/:storyId"
        element={data?.features.publicStorySharing ? <PublicReaderPage /> : <Navigate to="/" replace />}
      />
      <Route path="story/:storyId" element={<ReaderPage />} />
      <Route path="library" element={<Navigate to="/" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
