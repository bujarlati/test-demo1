# 续墨｜AI 自主互动小说平台

依据 `docs/` 下两份 V0.1 需求文档实现的全栈 Web 应用。产品以“阅读优先”为核心：AI 默认自主连载，读者只在关键时刻表达否决或偏好；任何已读内容修改都会创建不可变 Revision，并提供影响说明和回滚入口。

## 已实现

- 普通读者注册、账号登录、故事归属校验、私人书架与带 `progress_version` 乐观并发控制的跨设备继续阅读
- PostgreSQL 线上持久化：账号/会话独立表、书架游标分页、故事按需加载、章节与不可变 Revision 分表；保留旧 JSON 幂等导入工具
- 极简开书：题材必选，氛围、篇幅与灵感可跳过；输入会生成独立的标题、人物、故事基因、结局契约与首章
- 沉浸阅读器：目录、阅读主题、字号、行距、正文宽度、下一章长度和移动端适配
- 一键续章：5 个短剧情候选、独立语义知识依赖审计、带 Revision 来源的事件时间/物品库存/硬约束门禁、固定预算记忆检索、目标段落校验、逐段流式展示与可重试幂等提交
- 每个故事分支独立的持久对话线程、带来源区间的滚动摘要与相关消息上下文，以及绑定章节、Revision、选中文本和事件的结构化介入提案
- 死亡否决、关系节奏、责任边界与局部选文重写的传递影响分析和句级最小修史闭环；延迟否决会创建新分支，并从可信快照幂等重放结构化状态事件
- 不可变 Revision、可读旧正文与逐段差异、并发版本校验，以及只允许安全回滚最新正史事务的回滚链
- 人物、世界规则、伏笔、偏好与保护角色档案
- 管理员 OpenAI-compatible 模型连接、planner/writer/extractor 任务路由、密钥轮换/删除与流式、Schema、Tool、缓存、上下文上限等真实能力探测
- 服务端版本化密钥加密、明文不回显、DNS 结果固定，以及 HTTPS/localhost/私网/元数据地址防护和阻断审计
- 故事暂停、恢复连载与软归档生命周期；恢复始终读取最新分支、正史与 Revision
- 用户可暂停/恢复/删除当前故事的偏好约束；角色保护状态保持同步
- 独立内容治理：输入、候选、流式段落与完整输出审核，用户举报/申诉、管理员复核及脱敏决策记录
- 生成观察台：由真实作业动态计算接受率、冲突率、首字 P95 与成本，并按模型/题材/提示词聚合候选、举报和过滤结果；服务重启后可识别中断作业并安全重试
- 上下文叙述语义门禁：先按完整句意区分故事内描述与写作安排；歧义时由故事所有者选择保留或重写，90 秒无操作自动重写，管理员只查看匿名聚合指标

## 本地运行

```bash
pnpm install
pnpm dev
```

验证：

```bash
pnpm test
pnpm build
```

- Web：`http://localhost:5173`
- API：`http://127.0.0.1:8787`

开发模式演示管理员账号（登录页已预填）：

- 邮箱：`admin@xumo.local`
- 密码：`xumo2026`

另有用于验证权限隔离的普通读者账号：`reader@xumo.local` / `read2026`。

生产构建：

```bash
pnpm build
$env:BOOTSTRAP_ADMIN_PASSWORD="请替换为强密码"
$env:APP_ENCRYPTION_KEY="32 字节 Base64 或 64 位十六进制主密钥"
$env:DATABASE_URL="postgresql://user:password@host:5432/xumo"
pnpm db:migrate
pnpm start
```

生产环境首次创建数据时必须提供 `BOOTSTRAP_ADMIN_PASSWORD`，模型密钥功能必须提供 `APP_ENCRYPTION_KEY`，不会创建公开默认密码或本地临时主密钥。若也要启用演示读者账号，可另外设置 `BOOTSTRAP_READER_PASSWORD`；未设置时该账号使用随机不可猜测密码。正式线上必须设置 `DATABASE_URL`，不要继续使用 `/tmp` 或 memory 保存真实用户数据。新版本会拒绝在未配置数据库的生产环境启动；只有明确不保留数据的纯演示站才能设置 `XUMO_ALLOW_EPHEMERAL_PRODUCTION=true`。

### 上下文叙述语义门禁

新开篇默认仍使用原门禁。完成数据库迁移并确认主密钥稳定后，再为小流量实例配置：

```dotenv
CONTEXTUAL_NARRATION_REVIEW_ENABLED=true
NARRATION_REVIEW_CONFIDENCE_THRESHOLD=0.85
DATABASE_URL=postgresql://user:password@host:5432/xumo
APP_ENCRYPTION_KEY=32字节Base64或64位十六进制值
```

开启时启动过程会校验 PostgreSQL 与主密钥；缺失或格式错误会直接拒绝启动。阈值仅影响新 assessment，案例会记录当时实际阈值。待确认 checkpoint 加密保存 24 小时，用户明确同意的脱敏上下文加密保存最多 90 天；未同意时不会写入长期正文片段。

推荐发布与回滚顺序：

1. 先部署代码并执行 `003` migration，保持开关为 `false`。
2. 确认 `DATABASE_URL`、`APP_ENCRYPTION_KEY` 与 migration health check 正常。
3. 小流量开启，观察 `ask_user`、用户保留、超时、重写成功和最老 pending 年龄。
4. 异常时把开关恢复为 `false`；这只停止新作业进入新门禁，scheduler 仍会让已有案例完成或超时收敛。不要回滚或删除 `003` migration。

### 注册用户公共书库

公共书库只允许注册用户访问。作者设置账号统一笔名后，可以立即公开至少含一章成功正文的非归档故事；读者通过公共书库或稳定分享链接只读访问当前正史，并保存独立阅读进度。作者取消公开或管理员下架后，链接立即不可读，但发布记录、稳定链接和读者进度保留。

- 故事档案页支持输入完整标题后永久删除；删除会同步移除正文、版本历史、公开链接和读者进度，只保留不含故事内容的脱敏模型统计与审计

启用前必须使用 PostgreSQL 并完成 `004_public_story_sharing.sql`：

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/xumo
PUBLIC_STORY_SHARING_ENABLED=false
AI_TRACE_ENABLED=false
```

先保持开关关闭部署、迁移和验证私人流程，再做双账号冒烟并开启。功能开关关闭是首选回滚方式；不要删除 `004` 新增表或修改已执行 migration。完整操作见 [公共书库发布、灰度与回滚手册](docs/runbooks/public-story-sharing-release.md)。

发布前统一执行：

```bash
npm run verify:release
```

结构化公共请求日志只包含固定 route 名、状态码、耗时和匿名请求关联 ID，不应包含搜索原文、笔名、标题、故事 ID 或正文。

### 从旧 JSON 切换到 PostgreSQL

先备份旧数据并保持旧服务运行，然后对新数据库执行：

```bash
$env:DATABASE_URL="postgresql://user:password@host:5432/xumo"
pnpm db:migrate
pnpm db:import-json -- --source="D:\backup\store.json"
```

导入命令按源文件 SHA-256 幂等执行，并核对用户、故事、章节和 Revision 数量。它不会删除或修改旧 `store.json`。校验通过后再把 `DATABASE_URL` 配置到线上服务并重启；`GET /api/health` 的 `storage` 应为 `postgresql`。观察期保留旧 JSON，确认注册、登录、书架分页、阅读和续章均正常后再单独安排旧存储下线。

在没有持久卷的站点运行时，可将 `XUMO_STORAGE_MODE` 设为 `memory`。这只适合公开演示，实例重启或重新部署会重置故事、会话和后来保存的模型连接；正式长期运行使用 PostgreSQL。

当托管平台把构建产物挂载到独立目录时，可用 `XUMO_STATIC_DIRECTORY` 指向该目录；Sites Worker 使用 `/bundle`。

## 数据与密钥

演示数据首次启动时由 `server/seed.ts` 生成。设置 `DATABASE_URL` 后，账号、会话、故事、章节和 Revision 写入 PostgreSQL；未设置时本地兼容模式仍写入 `server/data/store.json`。模型 Key 使用 AES-256-GCM 加密后写入独立的 `server/data/secrets.json`。这些运行期文件均已忽略，不会提交到 Git。

生产环境应通过 `APP_ENCRYPTION_KEY` 提供 32 字节主密钥，并由正式 KMS/Vault 替换本地密钥文件。默认 `ALLOW_PRIVATE_MODEL_ENDPOINTS=false`，云端部署不会访问用户的 localhost 或私有网络。

如需恢复初始演示状态，停止服务后删除 `server/data/store.json`；下次启动会重新生成。
