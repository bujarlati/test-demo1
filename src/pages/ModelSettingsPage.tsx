import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CloudCog,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ServerCog,
  ShieldCheck,
  TestTube2,
  X,
  Zap,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/States";
import { useApp } from "../context/AppContext";
import { useToast } from "../context/ToastContext";
import type { ModelConnection, ModelConnectionInput, ModelConnectionStatus } from "../types";
import { formatDateTime } from "../utils";

const emptyForm: ModelConnectionInput = {
  name: "",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  routes: {
    planner: "reasoning-small",
    writer: "novel-writer-v2",
    extractor: "json-fast",
    embedding: "embedding-large",
  },
  fallbackPolicy: "none",
};

const statusLabel: Record<ModelConnectionStatus, string> = {
  draft: "待测试",
  validating: "测试中",
  active: "可用",
  degraded: "能力降级",
  disabled: "已停用",
  revoked: "凭据失效",
};

export function ModelSettingsPage() {
  const toast = useToast();
  const { refresh: refreshBootstrap } = useApp();
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [defaultId, setDefaultId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ModelConnectionInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const payload = await api.connections();
      setConnections(payload.connections);
      setDefaultId(payload.defaultConnectionId);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "模型连接加载失败。" );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true);
    try {
      const endpoint = new URL(form.baseUrl);
      const blockedHost = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "169.254.169.254";
      if (endpoint.protocol !== "https:" || blockedHost) {
        toast("SaaS 模式已阻止本地、私网或非 HTTPS 模型地址。", "error");
        setSaving(false);
        return;
      }
    } catch {
      toast("Base URL 不是有效地址。", "error");
      setSaving(false);
      return;
    }
    try {
      const connection = await api.createConnection(form);
      toast("连接已安全保存。通过测试后才能用于生成。" );
      setForm(emptyForm); setShowForm(false); await load();
      window.setTimeout(() => document.getElementById(`connection-${connection.id}`)?.focus(), 0);
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "保存失败。", "error");
    } finally { setSaving(false); }
  };

  const test = async (connectionId: string) => {
    setTestingId(connectionId);
    try {
      await api.testConnection(connectionId);
      toast("连接与认证测试通过，能力快照已更新。" );
    } catch (requestError) {
      toast(requestError instanceof Error ? requestError.message : "连接测试失败。", "error");
    } finally { setTestingId(null); await load(); }
  };

  const setDefault = async (connectionId: string) => {
    try {
      const payload = await api.setDefaultConnection(connectionId);
      setDefaultId(payload.defaultConnectionId);
      await refreshBootstrap();
      toast("默认模型连接已更新；只影响之后的新生成作业。" );
    } catch (requestError) { toast(requestError instanceof Error ? requestError.message : "设置失败。", "error"); }
  };

  if (loading) return <LoadingState label="正在读取模型路由与能力快照…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="page page--models">
      <header className="page-heading models-heading">
        <div><span className="eyebrow">模型与密钥域</span><h1>模型连接</h1><p>业务只使用 planner、writer 等逻辑别名；连接不会改变历史正史与 Revision。</p></div>
        <button className="button button--primary" type="button" onClick={() => setShowForm(true)}><Plus size={18} /> 新建连接</button>
      </header>

      <div className="security-notice"><ShieldCheck size={20} /><div><strong>Key 只在服务端使用</strong><p>保存后仅显示掩码；浏览器、日志与错误消息不会收到可复用明文。默认禁止 localhost、私网与云元数据地址。</p></div></div>

      <section className="connection-section">
        <div className="section-heading"><div><span className="eyebrow">任务路由</span><h2>可用连接</h2></div><span>{connections.length} 条</span></div>
        <div className="connection-list">
          {connections.map((connection) => {
            const isDefault = defaultId === connection.id;
            const capabilities = connection.capabilities;
            return (
              <article className={`connection-row${isDefault ? " connection-row--default" : ""}`} key={connection.id} tabIndex={-1} id={`connection-${connection.id}`}>
                <div className="connection-row__icon">{connection.ownerScope === "platform" ? <CloudCog size={22} /> : <ServerCog size={22} />}</div>
                <div className="connection-row__main">
                  <div className="connection-row__title"><h3>{connection.name}</h3>{isDefault && <span className="default-label"><Check size={13} /> 当前默认</span>}<span className={`connection-status connection-status--${connection.status}`}>{connection.status === "active" ? <CheckCircle2 size={13} /> : connection.status === "validating" ? <LoaderCircle className="spin" size={13} /> : <CircleAlert size={13} />}{statusLabel[connection.status]}</span></div>
                  <p>{connection.baseUrl}</p>
                  <div className="route-grid">
                    <span><small>规划</small>{connection.routes.planner}</span><span><small>正文</small>{connection.routes.writer}</span><span><small>抽取</small>{connection.routes.extractor}</span><span><small>向量</small>{connection.routes.embedding}</span>
                  </div>
                  {connection.lastError && <p className="connection-error"><CircleAlert size={14} /> {connection.lastError}</p>}
                </div>
                <div className="connection-row__capabilities">
                  <span className={capabilities?.streaming ? "supported" : ""}><Zap size={14} /> 流式</span>
                  <span className={capabilities?.jsonSchema ? "supported" : ""}><Activity size={14} /> Schema</span>
                  <span className={capabilities?.embedding ? "supported" : ""}><CloudCog size={14} /> Embedding</span>
                  <small>{capabilities ? `${capabilities.latencyMs}ms · ${formatDateTime(capabilities.testedAt)}` : "尚无能力快照"}</small>
                </div>
                <div className="connection-row__actions">
                  {connection.ownerScope === "user" && <button className="button button--secondary" type="button" onClick={() => void test(connection.id)} disabled={testingId === connection.id}>{testingId === connection.id ? <LoaderCircle className="spin" size={16} /> : <TestTube2 size={16} />}{testingId === connection.id ? "测试中" : "测试连接"}</button>}
                  {!isDefault && connection.status === "active" && <button className="text-link" type="button" onClick={() => void setDefault(connection.id)}>设为默认</button>}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="model-boundaries">
        <article><LockKeyhole size={20} /><div><h3>密钥隔离</h3><p>连接只保存 secret_ref，AES-GCM 加密值与应用数据分开存储。</p></div></article>
        <article><ShieldCheck size={20} /><div><h3>禁止静默回退</h3><p>自定义连接失败时明确停止作业，除非预先授权回退策略。</p></div></article>
        <article><Activity size={20} /><div><h3>能力探测</h3><p>流式、Schema、Embedding 与延迟以测试快照参与任务路由。</p></div></article>
      </section>

      {showForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowForm(false); }}>
          <section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
            <header><div><span className="eyebrow">OpenAI-compatible</span><h2 id="connection-title">新建模型连接</h2><p>保存不会立即发起外部请求；请随后主动测试。</p></div><button type="button" aria-label="关闭" onClick={() => setShowForm(false)}><X size={20} /></button></header>
            <form onSubmit={(event) => void submit(event)}>
              <label><span>连接名称</span><input required autoComplete="off" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="我的自托管模型" /></label>
              <label><span>Base URL</span><input required type="url" autoComplete="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /><small>SaaS 仅允许公网 HTTPS；保存前会阻断明显的本地与元数据地址。</small></label>
              <label><span>API Key</span><div className="secret-input"><KeyRound size={17} /><input required type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder="sk-••••••••••••" /></div><small>原始值只在本次请求中传输，保存后不能取回。</small></label>
              <fieldset><legend>任务路由</legend><div className="route-form">{(["planner", "writer", "extractor", "embedding"] as const).map((route) => <label key={route}><span>{route === "planner" ? "规划模型" : route === "writer" ? "正文模型" : route === "extractor" ? "抽取模型" : "Embedding"}</span><input required autoComplete="off" value={form.routes[route]} onChange={(event) => setForm({ ...form, routes: { ...form.routes, [route]: event.target.value } })} /></label>)}</div></fieldset>
              <label><span>失败回退</span><div className="select-wrap"><select value={form.fallbackPolicy} onChange={(event) => setForm({ ...form, fallbackPolicy: event.target.value as ModelConnectionInput["fallbackPolicy"] })}><option value="none">不回退（推荐）</option><option value="same_connection">同连接其他模型</option><option value="platform_managed">平台托管模型</option></select><ChevronDown size={16} /></div><small>跨供应商回退会改变数据发送目的地，应明确授权。</small></label>
              <footer><button className="button button--ghost" type="button" onClick={() => setShowForm(false)}>取消</button><button className="button button--primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}{saving ? "正在加密保存" : "安全保存连接"}</button></footer>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
