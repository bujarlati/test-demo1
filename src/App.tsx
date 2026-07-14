import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ArchivePage } from "./pages/ArchivePage";
import { HistoryPage } from "./pages/HistoryPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ModelSettingsPage } from "./pages/ModelSettingsPage";
import { NewStoryPage } from "./pages/NewStoryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OpsPage } from "./pages/OpsPage";
import { ReaderPage } from "./pages/ReaderPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<LibraryPage />} />
        <Route path="new" element={<NewStoryPage />} />
        <Route path="story/:storyId/archive" element={<ArchivePage />} />
        <Route path="story/:storyId/history" element={<HistoryPage />} />
        <Route path="settings/models" element={<ModelSettingsPage />} />
        <Route path="ops" element={<OpsPage />} />
      </Route>
      <Route path="story/:storyId" element={<ReaderPage />} />
      <Route path="library" element={<Navigate to="/" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
