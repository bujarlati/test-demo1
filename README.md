# 续墨｜AI 自主互动小说平台

依据 `docs/` 下两份 V0.1 需求文档实现的全栈 Web 应用。产品以“阅读优先”为核心：AI 默认自主连载，读者只在关键时刻表达否决或偏好；任何已读内容修改都会创建不可变 Revision，并提供影响说明和回滚入口。

## 已实现

- 账号登录、故事归属校验、私人书架与跨设备继续阅读
- 极简开书：题材必选，氛围、篇幅与灵感可跳过
- 沉浸阅读器：目录、阅读主题、字号、行距、正文宽度和移动端适配
- 一键续章：5 个短剧情候选、硬正史过滤、固定预算记忆检索、逐段流式展示与幂等提交
- 每本小说独立的持久对话线程
- 任意故事死亡事件的零追问锚定、影响分析与最小修史闭环
- 不可变 Revision、事实差异，以及同样创建新事务和新 Revision 的回滚
- 人物、世界规则、伏笔、偏好与保护角色档案
- 管理员 OpenAI-compatible 模型连接、planner/writer/extractor 任务路由与真实能力探测
- 服务端密钥加密、明文不回显、HTTPS/localhost/私网/元数据地址防护
- 生成观察台：候选/过滤摘要、提示词版本、连接、延迟、成本、作业与安全审计

## 本地运行

```bash
pnpm install
pnpm dev
```

- Web：`http://localhost:5173`
- API：`http://127.0.0.1:8787`

演示管理员账号（登录页已预填）：

- 邮箱：`admin@xumo.local`
- 密码：`xumo2026`

另有用于验证权限隔离的普通读者账号：`reader@xumo.local` / `read2026`。

生产构建：

```bash
pnpm build
pnpm start
```

## 数据与密钥

演示数据首次启动时由 `server/seed.ts` 生成。运行期故事、会话与 Revision 写入 `server/data/store.json`；模型 Key 使用 AES-256-GCM 加密后写入独立的 `server/data/secrets.json`。这些运行期文件均已忽略，不会提交到 Git。

生产环境应通过 `APP_ENCRYPTION_KEY` 提供 32 字节主密钥，并由正式 KMS/Vault 替换本地密钥文件。默认 `ALLOW_PRIVATE_MODEL_ENDPOINTS=false`，云端部署不会访问用户的 localhost 或私有网络。

如需恢复初始演示状态，停止服务后删除 `server/data/store.json`；下次启动会重新生成。
