# 注册用户小说分享与公共书库 Implementation Plan

> **实施前提：** 以已确认的设计文档 `docs/superpowers/specs/2026-07-24-public-story-sharing-design.md` 为产品约束。按任务顺序实施，每一步先写失败测试，再写最小实现；功能在数据库迁移、双账号冒烟和字段白名单检查全部通过前保持关闭。

**Goal:** 让故事所有者可以用账号统一笔名立即公开个人故事，让其他注册用户通过“大家的故事”或稳定分享链接只读当前正史，并独立保存阅读进度；取消公开、归档或管理员下架后必须立即停止新的公开读取。

**Architecture:** 新增一个深的 `PublicStorySharing` 模块。它通过小而明确的 interface 隐藏发布状态机、所有权校验、公开字段投影、当前 Revision 查询、游标、进度 CAS 和管理员下架。PostgreSQL adapter 只选择公共白名单列，禁止加载完整 `Story.payload` 后删字段。公开正文不复制，详情查询始终连接 `xumo_chapters.current_revision_id`。Express 只负责会话、Zod 输入和状态码；作者页、公共书库和只读阅读页分别调用该模块。

**Tech Stack:** TypeScript 7、Express 5、Zod 4、React 19、PostgreSQL / PGlite、tsx、node:test；不增加运行时依赖，不引入新的正文副本或缓存层。

## Current Integration Facts

- 所有 `/api/*` 路由已在 `server/index.ts` 统一经过 Bearer 会话认证，因此公共书库仍天然要求登录；`/api/health`、登录和注册保持例外。
- `App` 在未认证时直接渲染 `LoginPage`，不会把浏览器从当前路径导航走。因此访问 `/public/story/:id` 后登录会自然回到原路径，无需接收可能造成开放重定向的 `returnTo` URL。
- `app.param("storyId")` 会按当前用户所有权加载私人故事。公开路由内部必须使用参数名 `:publicStoryId`，避免错误套用所有者读取；URL 形状仍为 `/api/public-stories/:id`。
- PostgreSQL 启动时只把少量运行态数据装入 `AppStore`，不会加载全站故事。跨账号公开查询必须直接走数据库，不能依赖 `store.stories`。
- `xumo_stories.payload` 含灵感、世界书、正史事件、模型连接和作者对话等私有数据。公开查询不得选择该列。
- 章节正文已规范化到 `xumo_chapters` 与 `xumo_chapter_revisions`；当前公开正文可以直接按 `current_revision_id` 查询，无需新增同步作业。
- 当前作者阅读接口和举报接口都要求故事所有权；公共阅读必须使用专用详情、进度和举报目标校验路径。
- 当前 `ReaderPage` 同时包含续写、修史、模型相关状态、对话和作者档案入口。公开阅读页必须单独实现，只复用排版设置等无权限含义的纯展示模块。
- 归档在当前产品中是软删除终态，UI 不支持直接恢复。归档后的公开查询必须立即失效；发布记录转为 `author_unpublished` 并保留，未来数据恢复后仍可使用原链接重新公开。
- 数据库 migration 以文件名排序、校验和锁定并在启动时前向执行；新结构应使用 `004_public_story_sharing.sql`，不得改写 `001`—`003`。
- 当前工作树包含用户的其他修改。实施期间不得 reset/checkout；只修改本计划列出的文件，并在每个任务后检查 diff 范围。

## Global Invariants

- 功能默认关闭；`PUBLIC_STORY_SHARING_ENABLED=true` 时必须同时存在 PostgreSQL `DATABASE_URL`，否则启动失败。
- 公开读取同时验证：登录、发布状态为 `active`、故事未归档、至少存在一个有效当前 Revision。任一条件不满足统一返回 `404 public_story_unavailable`。
- 分享路径中的故事 ID 只是定位符，不是授权凭据。
- 公开 DTO 通过 SQL 正向选择白名单列构造；任何代码不得把完整 `Story` 传入公开序列化器。
- 公开详情只读取每章当前 Revision；历史 Revision、reason、模型名、prompt 版本和作者私有 payload 永不返回。
- 公开、重新公开和重复点击是幂等的；`first_published_at` 与分享路径保持稳定。
- 首次发布和首次设置笔名必须在同一事务中提交，不允许出现“已公开但无笔名”的中间状态。
- 作者不能改变 `admin_suspended`；管理员恢复固定回到 `active`，并清空管理员原因字段。
- 取消公开、管理员下架和归档不删除发布记录或读者进度。
- 新章节或正史修订只有在现有保存事务成功、`current_revision_id` 已提交后才对公开读取可见；生成失败继续展示上一次成功正史。
- 私人阅读进度与公开阅读进度永不共用记录。作者本人通过公开链接阅读时也使用公开进度。
- 公开进度使用乐观并发；首次写入期望版本 `0`，成功后为 `1`，后续仅在版本相等时更新。
- 列表、详情、进度和公开举报响应设置 `Cache-Control: private, no-store`。
- 日志、审计和错误不得包含正文、灵感、对话、世界书、模型密钥或完整自由文本输入。

## PublicStorySharing Module Interface

```ts
export interface PublicStorySharingModule {
  getOwnerPublication(ownerId: string, storyId: string): Promise<OwnerPublicationState>;
  setOwnerPublication(
    actor: Pick<UserAccount, "id" | "role" | "publicPenName">,
    storyId: string,
    input: SetStoryPublicationInput,
  ): Promise<OwnerPublicationState>;
  updatePublicProfile(userId: string, input: PublicProfileInput): Promise<PublicProfile>;
  discover(viewerId: string, query: PublicStoryQuery): Promise<PublicStoryPage>;
  read(viewerId: string, publicStoryId: string): Promise<PublicStoryDetail>;
  saveProgress(
    viewerId: string,
    publicStoryId: string,
    input: SavePublicReadingProgressInput,
  ): Promise<PublicReadingProgress>;
  validateReportTarget(
    viewerId: string,
    publicStoryId: string,
    chapterId: string,
  ): Promise<PublicStoryReportTarget>;
  moderate(
    adminUserId: string,
    publicStoryId: string,
    input: PublicationModerationInput,
  ): Promise<PublicationModerationSummary>;
  listModeration(limit: number): Promise<PublicationModerationSummary[]>;
}
```

The interface is the test surface. 状态转换、事务、SQL、字段投影、进度冲突和统一不可用错误全部留在 module implementation 内；HTTP 路由和 React 页面不重复这些规则。数据库依赖属于 local-substitutable，生产使用 `PgExecutor`，测试使用现有 PGlite executor，不再增加一层假想 port。

## File Map

| 文件 | 职责 |
|---|---|
| `server/publicStorySharing.ts` | module interface、输入归一化、错误码、发布状态规则 |
| `server/database/publicStoryRepository.ts` | PostgreSQL implementation、白名单查询、事务、游标和进度 CAS |
| `server/database/migrations/004_public_story_sharing.sql` | 笔名、发布记录和公开阅读进度 |
| `server/database/types.ts` / `postgres.ts` | 暴露并创建 `PublicStorySharing` module，更新用户列映射 |
| `server/publicStoryRoutes.ts` | 经认证的作者、发现、阅读、进度、举报和管理员 HTTP 路由 |
| `server/index.ts` | 挂载路由、归档联动、运营响应和结构化请求日志 |
| `server/auth.ts` / `seed.ts` / `storage.ts` | 公开笔名、自举兼容、功能开关与 PostgreSQL 前提 |
| `src/types.ts` / `src/api.ts` | 公开 DTO、错误详情和客户端调用 |
| `src/publicStoryState.ts` | 查询参数、分页合并和进度冲突的纯状态逻辑 |
| `src/readerSettings.ts` | 私人和公开阅读页共用的无权限排版设置 |
| `src/components/StoryPublicationDialog.tsx` | 首次笔名、公开预览和确认 |
| `src/components/StoryPublicationActions.tsx` | 状态、打开链接、复制和取消公开 |
| `src/pages/PublicLibraryPage.tsx` | 搜索、题材筛选、最近更新与游标分页 |
| `src/pages/PublicReaderPage.tsx` | 专用只读阅读、公开进度和举报 |
| `src/pages/LibraryPage.tsx` / `App.tsx` / `AppShell.tsx` | 双入口与路由 |
| `src/pages/ReaderPage.tsx` / `ArchivePage.tsx` | 作者公开入口，不承载公开读取 |
| `src/pages/OpsPage.tsx` | 管理员下架、恢复和无正文观测 |

---

### Task 1: 固化共享类型、笔名规则和功能开关

**Files:**
- Create: `server/publicStorySharing.ts`
- Create: `tests/publicStorySharing.test.ts`
- Modify: `src/types.ts`
- Modify: `server/auth.ts`
- Modify: `server/seed.ts`
- Modify: `server/storage.ts`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**

```ts
export type StoryPublicationStatus = "active" | "author_unpublished" | "admin_suspended";

export interface OwnerPublicationState {
  storyId: string;
  status: "private" | StoryPublicationStatus;
  published: boolean;
  sharePath: string;
  firstPublishedAt: string | null;
  statusUpdatedAt: string | null;
}

export interface PublicReadingProgress {
  storyId: string;
  chapterId: string;
  chapterNumber: number;
  scrollProgress: number;
  progressVersion: number;
  updatedAt: string;
}

export function normalizePublicPenName(value: string): string;
export function publicStorySharingEnabled(): boolean;
```

- [ ] **Step 1: 写笔名和发布状态失败测试**

覆盖：去除首尾空白；按 Unicode code point 计数 2—20；拒绝空白、换行和控制字符；不要求唯一；`private/active/author_unpublished/admin_suspended` 的作者合法与非法转换；分享路径始终为 `/public/story/${storyId}`。

- [ ] **Step 2: 写功能开关启动约束测试**

验证默认关闭；显式 `true` 才开启；开启但没有 `DATABASE_URL` 时 `loadStore` 在监听端口前失败；关闭时文件/内存开发模式保持可用。

- [ ] **Step 3: 增加共享 DTO 和用户笔名字段**

为 `UserAccount`、`UserProfile` 增加 `publicPenName: string | null`；为公开摘要、详情、章节当前 Revision、分页、进度、作者发布状态和管理员摘要增加明确类型。`createReaderAccount` 与 seed 用户初始化为 `null`，`publicUser` 只向本人会话返回该字段。

- [ ] **Step 4: 实现纯规则，不接数据库**

状态函数返回结构化错误码，不直接构造 Express response。错误至少包括：`invalid_public_pen_name`、`story_not_publishable`、`publication_suspended`、`public_story_unavailable`、`progress_conflict`、`public_story_sharing_disabled`。

- [ ] **Step 5: 运行局部测试**

Run: `npm.cmd exec -- tsx --test tests/publicStorySharing.test.ts`

Expected: PASS；不启动服务器、不连接真实 PostgreSQL。

---

### Task 2: 增加兼容 migration 与数据库白名单查询

**Files:**
- Create: `server/database/migrations/004_public_story_sharing.sql`
- Create: `server/database/publicStoryRepository.ts`
- Create: `tests/helpers/pglite.ts`
- Create: `tests/publicStorySharing.database.test.ts`
- Modify: `tests/database.test.ts`
- Modify: `server/database/types.ts`
- Modify: `server/database/postgres.ts`

**Migration:**

```sql
ALTER TABLE xumo_users ADD COLUMN IF NOT EXISTS public_pen_name text;

CREATE TABLE xumo_story_publications (...);
CREATE TABLE xumo_public_reading_progress (...);
```

约束必须包含：

- `public_pen_name` 为 `NULL` 或规范化后 2—20 字符；
- `xumo_stories(id, owner_id)` 唯一约束，以及发布记录到该二元组的级联外键；
- 发布状态枚举与管理员字段一致性检查；
- 读者、故事级联删除，滚动位置 `0..1`，版本为正整数；
- `chapter_id` 不建级联外键，保留 `chapter_number` 用于章节替换回退；
- `active` 发布列表与进度最近更新时间索引。

- [ ] **Step 1: 抽出现有 PGlite executor 测试 helper**

只机械移动 `tests/database.test.ts` 已有 adapter，不改变生产 `PgExecutor`。先运行现有数据库测试确认行为不变。

- [ ] **Step 2: 写 migration 失败测试**

验证迁移可重复执行、已有用户笔名为 `NULL`、已有故事无发布记录、无所有权匹配的发布插入失败、非法状态/滚动位置/版本失败、删除账号或故事正确级联。

- [ ] **Step 3: 写公开字段白名单失败测试**

在 PGlite 中写入带有“私密哨兵”的 `inspiration`、`payload`、历史 Revision reason、模型名和 prompt 版本。公开摘要与详情序列化后不得包含这些哨兵或禁止字段，只能包含当前 Revision。

- [ ] **Step 4: 实现 PostgreSQL adapter**

公开列表和详情 SQL 显式列出安全列。禁止 `SELECT s.payload`、`SELECT r.reason` 或 `SELECT r.*`。详情用：

```sql
JOIN xumo_chapter_revisions r
  ON r.id = c.current_revision_id
 AND r.chapter_id = c.id
 AND r.story_id = s.id
```

列表游标编码 `{updatedAt, storyId, filterHash}`；换了搜索词或题材后使用旧游标返回 `400 invalid_public_story_cursor`。标题和笔名搜索使用参数化 `ILIKE`，并转义用户输入中的 `%` 与 `_`。

- [ ] **Step 5: 更新用户列映射**

`UserRow`、`toUser`、所有用户 SELECT 和 `upsertUser` 同步读写 `public_pen_name`。首次发布时的笔名更新不得依赖稍后异步 `saveSnapshot`。

- [ ] **Step 6: 运行数据库测试**

Run: `npm.cmd exec -- tsx --test tests/database.test.ts tests/publicStorySharing.database.test.ts`

Expected: PASS；migration 表记录 `004_public_story_sharing.sql` 且 checksum 稳定。

---

### Task 3: 实现发布状态、自动同步和进度 CAS

**Files:**
- Modify: `server/publicStorySharing.ts`
- Modify: `server/database/publicStoryRepository.ts`
- Modify: `server/database/types.ts`
- Modify: `server/database/postgres.ts`
- Modify: `server/storage.ts`
- Modify: `tests/publicStorySharing.test.ts`
- Modify: `tests/publicStorySharing.database.test.ts`

- [ ] **Step 1: 写发布事务失败测试**

覆盖：仅所有者可发布；无成功章节、`archived` 不可发布；`active/paused/completed` 可发布；首次笔名与发布原子提交；重复发布不改 `first_published_at`；取消后记录保留；重新公开恢复原路径；作者不能改变 `admin_suspended`。

- [ ] **Step 2: 写自动同步失败测试**

公开故事后新增章节并更新 `xumo_stories.updated_at`，列表顺序和详情立即变化；把旧章 `current_revision_id` 切到新 Revision 后公开正文变化；只插入未成为 current 的历史 Revision 时公开正文不变；模拟事务回滚时继续返回旧正史。

- [ ] **Step 3: 写进度并发与回退失败测试**

覆盖首次 `expectedVersion=0` 插入、正确版本递增、两个并发更新只有一个成功、冲突携带服务器最新进度、取消公开后拒绝新写入但保留旧行、章节 ID 不存在时按章节编号回退、无更早章节时回到第一章并把滚动位置置零。

- [ ] **Step 4: 实现 `PublicStorySharing` module**

module implementation 组合纯状态规则和 PostgreSQL adapter。所有者检查、可发布性、首次笔名事务、公开投影、进度 CAS 和统一 404 都在 module 内完成。Express 和 React 不自行判断发布状态。

- [ ] **Step 5: 实现归档一致性**

在 `PostgresDatabase.saveSnapshot` 保存故事的同一事务中，当故事变为 `archived` 时把 `active` 发布记录改为 `author_unpublished`。公开查询本身仍额外过滤 `s.status <> 'archived'`，即使联动写入失败也不能泄露归档正文。

- [ ] **Step 6: 运行状态机和数据库测试**

Run: `npm.cmd exec -- tsx --test tests/publicStorySharing.test.ts tests/publicStorySharing.database.test.ts`

Expected: PASS；测试通过 module interface 观察结果，不读取 repository 内部状态。

---

### Task 4: 接入经认证的 HTTP 路由与公开举报

**Files:**
- Create: `server/publicStoryRoutes.ts`
- Create: `tests/publicStoryRoutes.test.ts`
- Modify: `server/index.ts`
- Modify: `src/api.ts`
- Modify: `src/types.ts`
- Modify: `package.json`

**Routes:**

```text
GET   /api/stories/:storyId/publication
PUT   /api/stories/:storyId/publication
PATCH /api/me/public-profile
GET   /api/public-stories
GET   /api/public-stories/:publicStoryId
PUT   /api/public-stories/:publicStoryId/progress
POST  /api/public-stories/:publicStoryId/reports
POST  /api/ops/publications/:publicStoryId/suspend
POST  /api/ops/publications/:publicStoryId/restore
```

- [ ] **Step 1: 写 HTTP 状态失败测试**

用临时 Express server 和注入的 module fake 覆盖：未登录 `401`；非所有者 `403`；非法笔名 `422`；不可发布 `409`；管理员下架 `409 publication_suspended`；私有/取消/下架/归档/不存在统一 `404 public_story_unavailable`；进度冲突 `409` 并返回最新记录；普通用户调用管理员路由 `403`。

- [ ] **Step 2: 实现薄路由**

路由只做 Zod 输入、`response.locals.user`、调用 module 和状态码映射。公开路径参数使用 `publicStoryId`，不得调用 `storyOrThrow` 或 `loadOwnedStory`。

- [ ] **Step 3: 增加安全响应头和错误结构**

公开响应统一加 `Cache-Control: private, no-store`。扩展 `ApiError` 以保留 `{ code, details }`，同时不破坏当前只读取 `message/status` 的调用者；进度页面可从 `details.latestProgress` 恢复。

- [ ] **Step 4: 接入公共举报**

先由 module 验证故事仍公开、章节属于该故事并解析当前 Revision，再沿用现有 `ContentReport` 持久化。举报记录包含故事、章节、当前 Revision、报告者和限长原因；不复制正文。作者私有举报路由保持不变。

- [ ] **Step 5: 关闭开关时失败关闭**

入口隐藏之外，所有新增路由在开关关闭时返回统一 `404 public_story_sharing_disabled`。不得仅依赖前端隐藏。

- [ ] **Step 6: 运行路由测试**

Run: `npm.cmd exec -- tsx --test tests/publicStoryRoutes.test.ts`

Expected: PASS；响应体不存在私有字段，所有公开成功响应都有 `private, no-store`。

---

### Task 5: 实现作者笔名、公开确认与稳定链接

**Files:**
- Create: `src/components/StoryPublicationDialog.tsx`
- Create: `src/components/StoryPublicationActions.tsx`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src/pages/ArchivePage.tsx`
- Modify: `src/context/AppContext.tsx`
- Modify: `src/api.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: 实现作者状态加载**

公开操作打开时读取 `GET /publication`。无记录展示“公开作品”，`active` 展示“已公开 / 打开 / 复制 / 取消”，`author_unpublished` 展示“重新公开”，`admin_suspended` 展示下架原因的安全摘要且禁用发布。

- [ ] **Step 2: 实现首次笔名与公开预览**

没有账号笔名时要求输入 2—20 字符；已有笔名默认只读展示，并提供显式“修改笔名”操作。确认卡展示封面、标题、简介、题材、章节数和正史版本，并明确“仅登录用户可读、正史自动同步、私有创作数据不公开”。

- [ ] **Step 3: 实现幂等提交与复制链接**

按钮提交期间禁用；成功后立即更新本地发布状态和 `AppContext.user.publicPenName`。复制使用 `new URL(sharePath, window.location.origin)`，失败时显示可手动复制的完整站内链接。

- [ ] **Step 4: 放置作者入口**

在作者 `ReaderPage` 工具区加入分享动作，在 `ArchivePage` 提供完整发布状态和取消入口。不要把发布状态写入 `Story.payload`。

- [ ] **Step 5: 验证作者流程**

Run: `npm.cmd run typecheck`

Expected: PASS；首次发布、重复点击、取消、重新公开和修改统一笔名均有明确界面状态。

---

### Task 6: 实现“大家的故事”公共书库

**Files:**
- Create: `src/pages/PublicLibraryPage.tsx`
- Create: `src/components/PublicStoryCard.tsx`
- Create: `src/publicStoryState.ts`
- Create: `tests/publicStoryState.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/pages/LibraryPage.tsx`
- Modify: `src/api.ts`
- Modify: `src/styles.css`
- Modify: `package.json`

- [ ] **Step 1: 写查询与分页状态失败测试**

覆盖查询字符串编码、题材枚举、搜索/题材变化清空旧游标、加载更多去重、请求乱序时丢弃旧响应、不可用作品从当前结果移除。

- [ ] **Step 2: 增加双入口与路由**

`/` 继续是“我的书架”，新增 `/discover` 为“大家的故事”；桌面侧栏、移动导航和书架顶部都提供清晰入口。功能开关关闭时不显示入口。

- [ ] **Step 3: 实现发现页**

默认最近更新倒序，每页 24 本；搜索标题或笔名；题材筛选；加载更多使用不透明游标。卡片只显示公开摘要字段，并链接 `/public/story/:id`。

- [ ] **Step 4: 处理加载与空状态**

区分首次加载、无匹配、加载更多和作品刚取消公开。搜索输入采用短防抖并用 `AbortController` 取消过期请求，不能让旧结果覆盖新筛选。

- [ ] **Step 5: 运行纯状态测试与构建**

Run: `npm.cmd exec -- tsx --test tests/publicStoryState.test.ts`

Run: `npm.cmd run build`

Expected: PASS；`/discover` 刷新和浏览器返回都保持可直达。

---

### Task 7: 实现专用只读阅读页与独立进度

**Files:**
- Create: `src/pages/PublicReaderPage.tsx`
- Create: `src/readerSettings.ts`
- Create: `tests/publicReadingProgress.test.ts`
- Modify: `src/pages/ReaderPage.tsx`
- Modify: `src/App.tsx`
- Modify: `src/api.ts`
- Modify: `src/styles.css`
- Modify: `package.json`

- [ ] **Step 1: 抽取无权限含义的阅读设置**

把主题、字号、行距、宽度和本地存取从 `ReaderPage` 移到 `readerSettings.ts`。私人页和公开页共享该纯模块，但公开页不导入作者对话、生成、修史或故事档案模块。

- [ ] **Step 2: 写公开进度状态失败测试**

覆盖详情恢复章节和滚动位置、900ms 防抖保存、成功版本递增、`409` 使用服务器最新进度、`404` 停止后续保存并显示“作品暂不可读”、卸载时清理定时器。

- [ ] **Step 3: 实现 `/public/story/:storyId`**

页面保留目录、上下章、排版设置、作者笔名、举报和返回公共书库。作者本人额外看到“返回创作版”，但正文 DTO 不扩大。未登录时继续由现有顶层登录门处理，登录后 URL 不变。

- [ ] **Step 4: 明确只读渲染**

页面不得渲染或调用续写、消息、修史、模型设置、版本历史、作者档案、角色保护和偏好接口。正文只用 React 文本节点输出，不使用 `dangerouslySetInnerHTML`。

- [ ] **Step 5: 接入举报和中途取消公开**

举报调用公共举报路由。阅读中取消公开时，已加载文字保持在浏览器；下一次进度或重新加载得到统一不可用状态，不主动清除 DOM 中已呈现正文。

- [ ] **Step 6: 运行测试与构建**

Run: `npm.cmd exec -- tsx --test tests/publicReadingProgress.test.ts`

Run: `npm.cmd run build`

Expected: PASS；公开页 bundle 中不存在调用作者写接口的路径。

---

### Task 8: 实现管理员下架、恢复与无正文观测

**Files:**
- Modify: `server/publicStorySharing.ts`
- Modify: `server/database/publicStoryRepository.ts`
- Modify: `server/publicStoryRoutes.ts`
- Modify: `server/index.ts`
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/pages/OpsPage.tsx`
- Modify: `src/styles.css`
- Modify: `tests/publicStorySharing.database.test.ts`
- Modify: `tests/publicStoryRoutes.test.ts`

- [ ] **Step 1: 写管理员状态失败测试**

覆盖普通用户拒绝、仅 `active -> admin_suspended`、重复下架幂等、作者无法绕过、`admin_suspended -> active`、恢复后原链接和读者进度可用、审计事件不含正文。

- [ ] **Step 2: 扩展运营响应**

`/api/ops` 增加最近发布状态摘要和计数，不返回正文。Ops 页面可从举报或发布列表下架，并能查看、恢复已下架作品；管理员原因限制为短结构化文本。

- [ ] **Step 3: 增加结构化请求观测**

记录公开/取消/下架/恢复动作，以及公开列表、详情和进度的状态码与延迟。日志只含 route 名、状态码、耗时、匿名化请求关联 ID；不记录 query 原文、笔名、标题、故事 ID 或正文。

- [ ] **Step 4: 运行管理员与隐私测试**

Run: `npm.cmd exec -- tsx --test tests/publicStorySharing.database.test.ts tests/publicStoryRoutes.test.ts`

Expected: PASS；Ops DTO 和日志 fixture 中不存在段落、私有 payload 或模型字段。

---

### Task 9: 全链路回归、灰度上线与回滚验证

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `package.json`
- Create: `docs/runbooks/public-story-sharing-release.md`

- [ ] **Step 1: 把所有新测试加入默认测试脚本**

默认 `npm.cmd test` 必须包含：domain、migration/repository、HTTP 路由、发现状态和公开阅读进度测试。

- [ ] **Step 2: 运行完整本地验证**

Run: `npm.cmd run typecheck`

Run: `npm.cmd test`

Run: `npm.cmd run build`

Expected: 全部 PASS；现有私人书架、开篇、续写、修史、模型连接、错误收集和语义门禁测试没有回归。

- [ ] **Step 3: 执行双账号数据库冒烟**

使用测试作者和测试读者验证：发布—发现—读取—保存进度—新增章节—修订旧章—取消—原链接 404—重新公开—原进度恢复；随后用管理员下架与恢复再走一遍。检查公开 JSON 不含禁止字段。

- [ ] **Step 4: 生产迁移与关闭开关部署**

先备份 PostgreSQL；部署包含 `004` 的版本但保持 `PUBLIC_STORY_SHARING_ENABLED=false`；确认 migration checksum、服务健康、私人流程和错误日志，再用内部环境或临时测试开关完成双账号冒烟。

- [ ] **Step 5: 打开功能并观察**

设置 `PUBLIC_STORY_SHARING_ENABLED=true` 后重启服务。确认 `/discover`、稳定分享链接、公开进度和管理员下架；观察公开路由 4xx/5xx、P95 延迟、进度冲突和举报，不记录正文。

- [ ] **Step 6: 验证回滚**

首选回滚是关闭功能开关并重启，使入口和新增路由立即不可用。保留新增表、可空列、发布记录和进度；不执行破坏性 down migration。若代码回滚，切回上一 release symlink，数据库 `004` 保持前向兼容。

## Definition of Done

- 作者能设置账号统一笔名，并立即公开至少含一个成功章节的非归档故事。
- 另一注册用户能通过标题/笔名搜索、题材筛选和最近更新排序找到作品。
- 分享链接在登录前后、取消后重新公开以及管理员恢复后保持不变。
- 公开详情只包含当前正史和明确白名单字段，自动同步成功新章与当前 Revision。
- 公开页面没有任何写作、修史、模型或作者私有入口。
- 作者、不同读者和私人阅读三套进度互不覆盖；并发更新可确定地收敛。
- 取消公开、归档和管理员下架后，新的列表、详情、进度与举报请求立即不可用。
- 功能关闭时原有私人产品完全不受影响，关闭开关可以完成非破坏性回滚。
- 全量测试、类型检查、构建、PGlite migration、双账号冒烟和生产健康检查全部通过。

## Commit Hygiene for This Dirty Worktree

- 不执行 `git reset --hard`、`git checkout --` 或覆盖用户现有修改。
- 每个任务开始和结束都运行 `git status --short` 与 `git diff --check`。
- 对已经脏的跟踪文件只暂存本任务新增 hunks；新文件按明确路径暂存。
- migration、module implementation、HTTP/前端接入和发布开关分开提交，便于审查和回滚。
