# 公共书库发布、灰度与回滚手册

本手册用于把注册用户公共书库发布到单机 Ubuntu + Nginx + PostgreSQL 环境。发布记录和读者进度由 `004_public_story_sharing.sql` 增量创建；回滚优先关闭功能开关，不删除表、不执行破坏性 down migration。

## 1. 发布目标与不变量

- 新代码在 `PUBLIC_STORY_SHARING_ENABLED=false` 时不能影响登录、私人书架、阅读、续写、修史、模型连接或运营台。
- `004` 只增加账号笔名列、发布记录和公共阅读进度表；既有故事默认保持私有。
- 作者取消公开或管理员下架只改变状态，不删除稳定链接或读者进度。
- 公共列表、详情、进度和管理操作的结构化观测不得记录 query、笔名、标题、故事 ID 或正文。
- 代码回滚时保留 `004`，上一版本必须能忽略这些新增表和可空列。

## 2. 发布前检查

在准备发布的源码目录执行：

```bash
npm ci
npm run verify:release
git diff --check
git status --short
```

`npm test` 必须包含以下公共书库测试：

- `tests/publicStorySharing.test.ts`
- `tests/publicStoryState.test.ts`
- `tests/publicReadingProgress.test.ts`
- `tests/publicStorySharing.database.test.ts`
- `tests/publicStoryRoutes.test.ts`

同时确认：

1. 发布提交已经推送，能够用提交 SHA 唯一定位。
2. 上一个可用发布目录或构建产物仍在，记录为 `PREVIOUS_RELEASE`。
3. 线上 `DATABASE_URL`、`APP_ENCRYPTION_KEY` 和当前模型配置保持不变。
4. `AI_TRACE_ENABLED=false`，避免生产日志写入模型提示或小说正文。
5. 域名 TLS、DNS、ICP备案和 Nginx 反向代理均可从外网访问。

## 3. 备份与基线

在服务器上生成只读发布标识并建立数据库备份。不要把连接串或备份文件提交到 Git。

```bash
export RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
install -d -m 700 /var/backups/xumo
pg_dump --format=custom --no-owner --no-acl \
  --file="/var/backups/xumo/pre-public-story-${RELEASE_ID}.dump" \
  "$DATABASE_URL"
pg_restore --list "/var/backups/xumo/pre-public-story-${RELEASE_ID}.dump" >/dev/null
```

记录迁移、数据量和服务基线：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT version, checksum, applied_at FROM xumo_schema_migrations ORDER BY version;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) AS users FROM xumo_users; SELECT count(*) AS stories FROM xumo_stories;"
curl --fail --silent http://127.0.0.1:8787/api/health
```

备份无法创建、无法列出，或基线健康检查失败时停止发布。

## 4. 关闭开关部署与迁移

先把新版本部署到独立发布目录，保持：

```dotenv
PUBLIC_STORY_SHARING_ENABLED=false
DATABASE_AUTO_MIGRATE=false
AI_TRACE_ENABLED=false
```

在新目录安装、构建并单独执行前向迁移：

```bash
npm ci
npm run build
npm run db:migrate
```

迁移完成后验证：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT version, checksum FROM xumo_schema_migrations WHERE version = '004_public_story_sharing.sql';"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT to_regclass('public.xumo_story_publications') AS publications, to_regclass('public.xumo_public_reading_progress') AS progress;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) AS publication_rows FROM xumo_story_publications;"
```

首次迁移后 `publication_rows` 应为 `0`，既有小说不会自动公开。将服务切到新发布目录并重启，再验证：

```bash
curl --fail --silent http://127.0.0.1:8787/api/health
journalctl -u xumo-api --since "10 minutes ago" --no-pager
```

健康响应必须显示 `storage: "postgresql"`。开关关闭时，公共接口返回 `404 public_story_sharing_disabled`，但私人登录、书架和故事详情仍正常。

## 5. 双账号灰度冒烟

使用专门的测试作者和测试读者，不使用真实用户作品。先仅在服务器回环地址或受控测试入口临时开启开关并重启服务。

按顺序验证：

1. 作者登录，设置账号统一笔名并公开至少含一章的非归档故事。
2. 记录 `/public/story/:storyId`，确认重复公开不改变链接或首次公开时间。
3. 读者登录，通过标题搜索、题材筛选和最近更新排序找到作品。
4. 读者打开分享链接，确认只能读取当前正史，没有续写、修史、模型、角色保护或作者私有入口。
5. 读者保存第二章和滚动位置；并发保存时一个请求成功，冲突请求返回 `409 progress_conflict` 和最新版本。
6. 作者新增成功章节并提交一次旧章修订；公开详情自动读取新章节和当前 Revision。
7. 模拟一次生成或保存失败，确认公开版仍为上一份成功正史。
8. 作者取消公开，确认列表消失，详情、进度和举报统一返回 `404 public_story_unavailable`。
9. 作者重新公开，确认原链接恢复、读者进度恢复。
10. 管理员下架，确认作者不能绕过；管理员恢复后再次确认原链接和进度。
11. 检查公共 JSON，不得出现 `passwordHash`、`passwordSalt`、`payload`、`conversation`、`modelConnectionId`、历史 Revision 或作者阅读进度。

冒烟过程中不要把 token、正文、标题、笔名或故事 ID 写入工单和日志。完成后可以让测试作者取消公开，测试数据按常规保留或清理。

## 6. 开启功能并观察

受控冒烟通过后，将正式环境设置为：

```dotenv
PUBLIC_STORY_SHARING_ENABLED=true
```

重启服务并检查：

```bash
curl --fail --silent http://127.0.0.1:8787/api/health
journalctl -u xumo-api --since "10 minutes ago" --no-pager
```

结构化公共请求日志只能包含：

```json
{"routeName":"public_story.detail","statusCode":200,"latencyMs":18,"requestCorrelationId":"..."}
```

发布后至少观察 30 分钟：

- 公共列表/详情的 4xx、5xx 和延迟；
- `progress_conflict` 数量；
- 发布、取消、管理员下架和恢复是否产生预期状态；
- 举报数量和处理状态；
- PostgreSQL 连接池、CPU、内存和磁盘；
- Nginx 499/502/504 以及域名 TLS/ICP备案状态。

出现正文、query、标题、笔名或故事 ID 被写入结构化请求日志时，立即关闭开关并按隐私事故处理。

## 7. 回滚验证

### 7.1 首选：关闭功能开关

```dotenv
PUBLIC_STORY_SHARING_ENABLED=false
```

重启后验证：

1. `/discover` 入口隐藏。
2. 发布、公共列表、详情、进度和管理发布状态接口返回统一不可用响应。
3. 登录、私人书架、作者阅读、续写、修史、模型连接和 `/api/ops` 继续可用。
4. `xumo_story_publications` 和 `xumo_public_reading_progress` 的行数不减少。

如果只是演练且结果正常，可重新开启开关并再次执行健康检查。

### 7.2 代码回滚

只有关闭开关不能恢复私人产品时，才把服务软链接或进程工作目录切回 `PREVIOUS_RELEASE` 并重启。不要删除 `004` 表、笔名列、发布记录或进度，也不要修改已经执行的 migration 文件。

回滚后再次执行私人流程冒烟和健康检查。数据库备份保留到观察期结束，并记录最终使用的发布 SHA、迁移 checksum、备份路径和回滚演练结果。

## 8. 停止条件

出现以下任一情况时停止切流并关闭开关：

- 备份或 `pg_restore --list` 校验失败；
- migration checksum 不一致；
- 健康检查不是 PostgreSQL，或服务无法启动；
- 私人产品在开关关闭时出现回归；
- 公共响应泄露禁止字段或历史正文；
- 管理员下架后作品仍可通过新请求读取；
- 外网域名因 TLS、DNS、ICP备案或 Nginx 配置无法访问。
