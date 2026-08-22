import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import {
  Camera,
  Check,
  File as FileIcon,
  FileStack,
  ImageIcon,
  MessageCircle,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Send,
  SendHorizontal,
  Plus,
  UserPlus,
  UsersRound,
  X,
  ZapOff,
} from "lucide-react";
import "./styles.css";

const API_URL = `${window.location.protocol}//${window.location.hostname}:4000`;
const APP_VERSION = "v2026-08-21-1824";

function makeClientId(userId: number) {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${userId}-${Date.now()}-${randomUuid}`;
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `${userId}-${Date.now()}-${randomPart}`;
}

function avatarLabel(name: string | null | undefined) {
  const value = (name ?? "").trim();
  if (!value) return "会话";
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value.slice(0, 4);
  return Array.from(value).slice(0, 2).join("");
}

function avatarRoleClass(phone: string | null | undefined) {
  return phone === "admin" || phone?.startsWith("staff:") ? "service" : "customer";
}

type User = {
  id: number;
  phone: string;
  nickname: string;
  sequence_number: number;
  status: string;
  created_at: string;
  last_seen_at: string | null;
};

type Conversation = {
  id: number;
  type: string;
  title: string | null;
  unread_count: number;
  is_pinned: number;
  is_muted: number;
  last_message_body: string | null;
  last_message_at: string | null;
  peer_id: number | null;
  peer_phone: string | null;
  peer_nickname: string | null;
  peer_last_seen_at: string | null;
};

type ChatMessage = {
  id: number;
  conversation_id: number;
  sender_id: number;
  type: string;
  body: string;
  client_id: string;
  created_at: string;
  revoked_at: string | null;
  edited_at: string | null;
  sender_nickname: string;
};

type ViewMode = "chats" | "contacts";
type ForwardMode = "separate" | "bundle";
type CaptureMode = "photo" | "video";
type CapturedMedia = {
  url: string;
  blob: Blob;
  fileName: string;
  type: "image" | "video";
};

type MediaBody = {
  url: string;
  name: string;
  size: number;
  mimeType: string;
};

type BundleBody = {
  title: string;
  count: number;
  items: Array<{
    sender: string;
    type: string;
    body: string;
    createdAt: string;
  }>;
};

type AdminSettings = {
  autoReplyEnabled: boolean;
  autoReplyText: string;
};

type StaffRole = "super_admin" | "admin" | "service";

type StaffAccount = {
  id: number;
  username: string;
  display_name: string;
  role: StaffRole;
  status: string;
  parent_id: number | null;
  chat_user_id: number | null;
  customer_prefix: string | null;
  next_customer_sequence: number;
  created_at: string;
  updated_at: string;
  parent_name: string | null;
  chat_nickname: string | null;
};

type InviteLink = {
  id: number;
  code: string;
  title: string;
  owner_staff_id: number;
  auto_reply_enabled: number;
  auto_reply_text: string;
  status: string;
  visits: number;
  customers: number;
  created_by: number;
  created_at: string;
  updated_at: string;
  owner_name: string;
  owner_role: StaffRole;
};

type AdminOverview = {
  staff: StaffAccount;
  users: User[];
  staffAccounts: StaffAccount[];
  inviteLinks: InviteLink[];
  settings: AdminSettings;
  stats: {
    totalUsers: number;
    activeUsers: number;
    disabledUsers: number;
    staffAccounts: number;
    inviteLinks: number;
  };
};

type AdminPage = "staff" | "links" | "users" | "reply";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "请求失败");
  return data as T;
}

async function adminApi<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "请求失败");
  return data as T;
}

function formatTime(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(`${value}Z`));
}

function isOnline(lastSeen: string | null) {
  if (!lastSeen) return false;
  const seen = new Date(`${lastSeen}Z`).getTime();
  return Date.now() - seen < 1000 * 60 * 3;
}

function parseBody<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function messagePreview(message: ChatMessage) {
  if (message.revoked_at) return "[撤回了一条消息]";
  if (message.type === "image") return "[图片]";
  if (message.type === "video") return "[视频]";
  if (message.type === "forward_bundle") return "[聊天记录]";
  return message.body;
}

function formatDuration(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [loginMode, setLoginMode] = useState<"customer" | "service">("customer");
  const [phone, setPhone] = useState("");
  const [serviceUsername, setServiceUsername] = useState("");
  const [servicePassword, setServicePassword] = useState("000000");
  const inviteCode = useMemo(() => new URLSearchParams(window.location.search).get("invite") ?? "", []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result =
        loginMode === "service"
          ? await api<{ user: User }>("/api/staff-chat/login", {
              method: "POST",
              body: JSON.stringify({ username: serviceUsername, password: servicePassword }),
            })
          : await api<{ user: User }>("/api/login", {
              method: "POST",
              body: JSON.stringify({ phone, inviteCode: inviteCode || undefined }),
            });
      localStorage.setItem("local-chat-user", JSON.stringify(result.user));
      onLogin(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">
          <MessageCircle size={30} strokeWidth={2.4} />
        </div>
        <h1>本地聊天</h1>
        <p>{loginMode === "service" ? "客服输入专属账号和密码进入聊天端。" : inviteCode ? "通过专属链接进入，输入手机号后会自动分配客服。" : "输入手机号直接进入，本地开发版不会发送验证码。"}</p>
        <div className="login-mode-tabs">
          <button type="button" className={loginMode === "customer" ? "active" : ""} onClick={() => setLoginMode("customer")}>客户</button>
          <button type="button" className={loginMode === "service" ? "active" : ""} onClick={() => setLoginMode("service")}>客服</button>
        </div>
        <form onSubmit={submit} className="login-form">
          {loginMode === "customer" ? (
            <>
              <label htmlFor="phone">手机号</label>
              <input
                id="phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="例如 13800138000"
                inputMode="tel"
                autoComplete="tel"
              />
            </>
          ) : (
            <>
              <label htmlFor="service-username">客服账号</label>
              <input id="service-username" value={serviceUsername} onChange={(event) => setServiceUsername(event.target.value)} placeholder="例如 xiaoming" autoComplete="username" />
              <label htmlFor="service-password">客服密码</label>
              <input id="service-password" type="password" value={servicePassword} onChange={(event) => setServicePassword(event.target.value)} placeholder="默认 000000" autoComplete="current-password" />
            </>
          )}
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit" disabled={loading}>
            {loading ? "进入中..." : loginMode === "service" ? "客服进入" : "进入聊天"}
          </button>
        </form>
      </section>
    </main>
  );
}

function roleName(role: StaffRole) {
  return role === "super_admin" ? "超级管理员" : "客服";
}

function inviteUrl(code: string) {
  return `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
}

function AdminApp() {
  const [token, setToken] = useState(() => localStorage.getItem("local-chat-admin-token") ?? "");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AdminSettings | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeAdminPage, setActiveAdminPage] = useState<AdminPage>("staff");
  const [customerPage, setCustomerPage] = useState(1);
  const [staffForm, setStaffForm] = useState({ username: "", password: "000000", displayName: "", customerPrefix: "" });
  const [linkForm, setLinkForm] = useState({ title: "", ownerStaffId: "", autoReplyEnabled: true, autoReplyText: "{nickname} 你好抖音评论 0.3元一条有效评论，没有数量限制。24小时都可以发 当天晚上10点前统一结算。" });

  useEffect(() => {
    if (!token) return;
    void loadOverview(token);
  }, [token]);

  async function loadOverview(nextToken = token) {
    setError("");
    try {
      const result = await adminApi<AdminOverview>("/api/admin/overview", nextToken);
      setOverview(result);
      setSettingsDraft(result.settings);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "加载失败");
      localStorage.removeItem("local-chat-admin-token");
      setToken("");
    }
  }

  function showError(message: string) {
    setError(message);
    window.alert(message);
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; staff: StaffAccount }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem("local-chat-admin-token", result.token);
      setToken(result.token);
      setPassword("");
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "登录失败");
    }
  }

  async function saveSettings() {
    if (!settingsDraft) return;
    setSaving(true);
    setError("");
    try {
      const result = await adminApi<{ settings: AdminSettings }>("/api/admin/settings", token, {
        method: "PATCH",
        body: JSON.stringify(settingsDraft),
      });
      setSettingsDraft(result.settings);
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function createStaff(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await adminApi<{ staff: StaffAccount }>("/api/admin/staff", token, {
        method: "POST",
        body: JSON.stringify({
          username: staffForm.username.trim(),
          password: staffForm.password,
          displayName: staffForm.displayName.trim(),
          role: "service",
          customerPrefix: staffForm.customerPrefix.trim(),
        }),
      });
      setStaffForm({ username: "", password: "000000", displayName: "", customerPrefix: "" });
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "创建失败");
    }
  }

  async function toggleStaffStatus(staff: StaffAccount) {
    const nextStatus = staff.status === "active" ? "disabled" : "active";
    setError("");
    try {
      await adminApi<{ staff: StaffAccount }>(`/api/admin/staff/${staff.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "更新失败");
    }
  }

  async function deleteStaff(staff: StaffAccount) {
    if (!window.confirm(`确定删除客服「${staff.display_name}」吗？删除后该客服账号不能再登录。`)) return;
    setError("");
    try {
      await adminApi<{ ok: true }>(`/api/admin/staff/${staff.id}`, token, { method: "DELETE" });
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "删除失败");
    }
  }

  async function createLink(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await adminApi<{ inviteLink: InviteLink }>("/api/admin/invite-links", token, {
        method: "POST",
        body: JSON.stringify({
          title: linkForm.title.trim(),
          ownerStaffId: Number(linkForm.ownerStaffId),
          autoReplyEnabled: linkForm.autoReplyEnabled,
          autoReplyText: linkForm.autoReplyText,
        }),
      });
      setLinkForm((form) => ({ ...form, title: "" }));
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "创建失败");
    }
  }

  async function toggleLinkStatus(link: InviteLink) {
    const nextStatus = link.status === "active" ? "disabled" : "active";
    setError("");
    try {
      await adminApi<{ ok: true }>(`/api/admin/invite-links/${link.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "更新失败");
    }
  }

  async function deleteLink(link: InviteLink) {
    if (!window.confirm(`确定删除链接「${link.title}」吗？删除后二维码和链接将不可用。`)) return;
    setError("");
    try {
      await adminApi<{ ok: true }>(`/api/admin/invite-links/${link.id}`, token, { method: "DELETE" });
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "删除失败");
    }
  }

  async function toggleUserStatus(user: User) {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    setError("");
    try {
      await adminApi<{ user: User }>(`/api/admin/users/${user.id}/status`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadOverview();
    } catch (requestError) {
      showError(requestError instanceof Error ? requestError.message : "更新失败");
    }
  }

  useEffect(() => {
    setCustomerPage(1);
  }, [query]);

  if (!token || (!overview && !error)) {
    return (
      <main className="admin-login-shell">
        <form className="admin-login-panel" onSubmit={login}>
          <strong>后台管理</strong>
          <span>超级管理员默认账号 admin，密码 000000。</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="账号" autoComplete="username" />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" autoComplete="current-password" />
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit">进入后台</button>
        </form>
      </main>
    );
  }

  const staff = overview?.staff;
  const serviceAccounts = overview?.staffAccounts.filter((item) => item.role === "service") ?? [];
  const activeServiceAccounts = serviceAccounts.filter((item) => item.status === "active");
  const filteredUsers = overview?.users.filter((user) => `${user.nickname}${user.phone}${user.status}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const pageSize = 10;
  const totalCustomerPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const safeCustomerPage = Math.min(customerPage, totalCustomerPages);
  const pagedUsers = filteredUsers.slice((safeCustomerPage - 1) * pageSize, safeCustomerPage * pageSize);

  return (
    <main className="admin-shell">
      <aside className="admin-side">
        <div className="admin-brand">
          <MessageCircle size={24} />
          <strong>本地聊天后台</strong>
        </div>
        <button className={`admin-nav ${activeAdminPage === "staff" ? "active" : ""}`} onClick={() => setActiveAdminPage("staff")}>客服</button>
        <button className={`admin-nav ${activeAdminPage === "links" ? "active" : ""}`} onClick={() => setActiveAdminPage("links")}>链接/二维码</button>
        <button className={`admin-nav ${activeAdminPage === "users" ? "active" : ""}`} onClick={() => setActiveAdminPage("users")}>客户</button>
        <button className={`admin-nav ${activeAdminPage === "reply" ? "active" : ""}`} onClick={() => setActiveAdminPage("reply")}>全局回复</button>
        <button
          onClick={() => {
            localStorage.removeItem("local-chat-admin-token");
            setToken("");
          }}
        >
          退出
        </button>
      </aside>
      <section className="admin-main">
        <header className="admin-topbar">
          <div>
            <strong>运营后台</strong>
            <span>{staff ? `${staff.display_name} · ${roleName(staff.role)}` : "客服、链接、二维码和客户管理"}</span>
          </div>
          <a href="/">返回聊天端</a>
        </header>

        {error ? <div className="admin-alert">{error}</div> : null}

        <div className="admin-metrics">
          <Metric label="客户" value={overview?.stats.totalUsers ?? 0} />
          <Metric label="客服" value={serviceAccounts.length} />
          <Metric label="链接" value={overview?.stats.inviteLinks ?? 0} />
        </div>

        {activeAdminPage === "staff" ? (
        <section className="admin-section">
          <header>
            <div>
              <strong>客服</strong>
              <span>添加客服账号后，客服可直接用账号和密码登录聊天端。默认密码 000000，可先统一使用。</span>
            </div>
          </header>
          <form className="admin-form-grid service-form" onSubmit={createStaff}>
            <input value={staffForm.displayName} onChange={(event) => setStaffForm((form) => ({ ...form, displayName: event.target.value }))} placeholder="客服名称" />
            <input value={staffForm.username} onChange={(event) => setStaffForm((form) => ({ ...form, username: event.target.value }))} placeholder="登录账号，如 xiaoming" />
            <input value={staffForm.customerPrefix} onChange={(event) => setStaffForm((form) => ({ ...form, customerPrefix: event.target.value }))} placeholder="客户编号前缀，如 aa" />
            <input value={staffForm.password} onChange={(event) => setStaffForm((form) => ({ ...form, password: event.target.value }))} placeholder="初始密码 000000" />
            <button className="admin-primary" type="submit">添加客服</button>
          </form>
          <div className="admin-table staff-table simple-staff-table">
            <div className="admin-table-head"><span>客服名称</span><span>账号</span><span>聊天显示</span><span>客户编号</span><span>状态</span><span>操作</span></div>
            {serviceAccounts.map((item) => (
              <div className="admin-table-row" key={item.id}>
                <strong>{item.display_name}</strong>
                <span>{item.username}</span>
                <span>{item.display_name}</span>
              <span>{item.customer_prefix ? `${item.customer_prefix}${item.next_customer_sequence} 起` : "旧数据"}</span>
                <span className={item.status === "active" ? "status-active" : "status-disabled"}>{item.status === "active" ? "启用" : "禁用"}</span>
                <div className="row-actions">
                  <button onClick={() => void toggleStaffStatus(item)}>{item.status === "active" ? "禁用" : "启用"}</button>
                  <button className="danger-action" onClick={() => void deleteStaff(item)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </section>
        ) : null}

        {activeAdminPage === "links" ? (
        <section className="admin-section">
          <header>
            <div>
              <strong>链接/二维码</strong>
              <span>选择客服生成入口链接，二维码同步显示；客户扫码或点链接后仍填手机号进入。</span>
            </div>
          </header>
          <form className="admin-form-grid link-form" onSubmit={createLink}>
            <input value={linkForm.title} onChange={(event) => setLinkForm((form) => ({ ...form, title: event.target.value }))} placeholder="链接名称，如 抖音评论" />
            <select value={linkForm.ownerStaffId} onChange={(event) => setLinkForm((form) => ({ ...form, ownerStaffId: event.target.value }))}>
              <option value="">选择客服</option>
              {activeServiceAccounts.map((service) => (
                <option key={service.id} value={service.id}>{service.display_name}</option>
              ))}
            </select>
            <label className="admin-switch"><input type="checkbox" checked={linkForm.autoReplyEnabled} onChange={(event) => setLinkForm((form) => ({ ...form, autoReplyEnabled: event.target.checked }))} />启用回复</label>
            <textarea value={linkForm.autoReplyText} onChange={(event) => setLinkForm((form) => ({ ...form, autoReplyText: event.target.value }))} />
            <button className="admin-primary" type="submit">添加链接</button>
          </form>
          <div className="link-card-grid">
            {overview?.inviteLinks.map((link) => (
              <article className="link-card" key={link.id}>
                <QrCodeImage value={inviteUrl(link.code)} />
                <div className="link-card-main">
                  <header><strong>{link.title}</strong><span className={link.status === "active" ? "status-active" : "status-disabled"}>{link.status === "active" ? "启用" : "停用"}</span></header>
                  <p>客服：{link.owner_name}</p>
                  <p>访问 {link.visits} · 客户 {link.customers}</p>
                  <div className="admin-url">{inviteUrl(link.code)}</div>
                  <div className="row-actions">
                    <button onClick={() => void toggleLinkStatus(link)}>{link.status === "active" ? "停用" : "启用"}</button>
                    <button className="danger-action" onClick={() => void deleteLink(link)}>删除</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
        ) : null}

        {activeAdminPage === "reply" ? (
        <section className="admin-section">
          <header>
            <div>
              <strong>全局自动回复</strong>
              <span>没有通过链接进入的新客户，仍由 A1 发送这套默认话术。</span>
            </div>
            <label className="admin-switch"><input type="checkbox" checked={settingsDraft?.autoReplyEnabled ?? false} onChange={(event) => setSettingsDraft((draft) => (draft ? { ...draft, autoReplyEnabled: event.target.checked } : draft))} />启用</label>
          </header>
          <textarea value={settingsDraft?.autoReplyText ?? ""} onChange={(event) => setSettingsDraft((draft) => (draft ? { ...draft, autoReplyText: event.target.value } : draft))} />
          <button className="admin-primary" onClick={() => void saveSettings()} disabled={saving || !settingsDraft?.autoReplyText.trim()}>{saving ? "保存中..." : "保存全局回复"}</button>
        </section>
        ) : null}

        {activeAdminPage === "users" ? (
        <section className="admin-section">
          <header>
            <div>
              <strong>客户</strong>
              <span>查看客户编号、手机号、状态和最近在线。</span>
            </div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号 / 手机号 / 状态" />
          </header>
          <div className="admin-table">
            <div className="admin-table-head"><span>编号</span><span>手机号</span><span>状态</span><span>最近在线</span><span>操作</span></div>
            {pagedUsers.map((user) => (
              <div className="admin-table-row" key={user.id}>
                <strong>{user.nickname}</strong>
                <span>{user.phone}</span>
                <span className={user.status === "active" ? "status-active" : "status-disabled"}>{user.status === "active" ? "启用" : "禁用"}</span>
                <span>{formatTime(user.last_seen_at)}</span>
                <button onClick={() => void toggleUserStatus(user)} disabled={user.sequence_number === 1}>{user.sequence_number === 1 ? "保留" : user.status === "active" ? "禁用" : "启用"}</button>
              </div>
            ))}
          </div>
          <div className="pagination-bar">
            <span>共 {filteredUsers.length} 位客户 · 第 {safeCustomerPage} / {totalCustomerPages} 页</span>
            <button onClick={() => setCustomerPage((page) => Math.max(1, page - 1))} disabled={safeCustomerPage <= 1}>上一页</button>
            <button onClick={() => setCustomerPage((page) => Math.min(totalCustomerPages, page + 1))} disabled={safeCustomerPage >= totalCustomerPages}>下一页</button>
          </div>
        </section>
        ) : null}
      </section>
    </main>
  );
}

function QrCodeImage({ value }: { value: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    void import("qrcode").then((QRCode) => QRCode.toDataURL(value, { width: 132, margin: 1 })).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  return src ? <img className="qr-code" src={src} alt="二维码" /> : <div className="qr-code" />;
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const raw = localStorage.getItem("local-chat-user");
    return raw ? (JSON.parse(raw) as User) : null;
  });
  const [socket, setSocket] = useState<Socket | null>(null);
  const [mode, setMode] = useState<ViewMode>("chats");
  const [users, setUsers] = useState<User[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedMessageIds, setSelectedMessageIds] = useState<number[]>([]);
  const [forwardMode, setForwardMode] = useState<ForwardMode | null>(null);
  const [viewingBundle, setViewingBundle] = useState<BundleBody | null>(null);
  const [viewingMedia, setViewingMedia] = useState<MediaBody | null>(null);
  const [actionMenu, setActionMenu] = useState<{ messageId: number; x: number; y: number } | null>(null);
  const [conversationMenu, setConversationMenu] = useState<{ conversationId: number; x: number; y: number } | null>(null);
  const [swipedConversationId, setSwipedConversationId] = useState<number | null>(null);
  const [editableRecalls, setEditableRecalls] = useState<Record<number, string>>({});
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("photo");
  const [capturedMedia, setCapturedMedia] = useState<CapturedMedia | null>(null);
  const [cameraError, setCameraError] = useState("");
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const [sendDebug, setSendDebug] = useState("");
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const conversationPressTimerRef = useRef<number | null>(null);
  const conversationTouchStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeConversationIdRef = useRef<number | null>(null);
  const currentUserRef = useRef<User | null>(null);
  const draftRef = useRef("");
  const sendingRef = useRef(false);
  const sessionBlockedRef = useRef(false);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendButtonCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    window.scrollTo(0, 0);
  }, [activeConversationId]);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );

  function forceLogout(message: string) {
    if (sessionBlockedRef.current) return;
    sessionBlockedRef.current = true;
    window.alert(message);
    logout();
  }

  function handleSessionError(error: unknown) {
    const message = error instanceof Error ? error.message : "账号不可用";
    if (message.includes("未匹配专属客服")) {
      forceLogout("未匹配专属客服");
      return;
    }
    setNotice(message);
  }

  useEffect(() => {
    if (!currentUser) return;
    sessionBlockedRef.current = false;
    const nextSocket = io(API_URL);
    nextSocket.emit("user:online", currentUser.id);
    nextSocket.on("message:new", (message: ChatMessage) => {
      if (message.conversation_id === activeConversationIdRef.current) {
        void loadMessages(message.conversation_id).catch(handleSessionError);
      } else {
        void loadConversations(currentUser.id).catch(handleSessionError);
      }
    });
    nextSocket.on("message:changed", (message: ChatMessage) => {
      if (message.conversation_id === activeConversationIdRef.current) {
        void loadMessages(message.conversation_id).catch(handleSessionError);
      }
      void loadConversations(currentUser.id).catch(handleSessionError);
    });
    nextSocket.on("conversation:changed", ({ conversationId }: { conversationId: number }) => {
      if (conversationId === activeConversationIdRef.current) {
        void loadMessages(conversationId).catch(handleSessionError);
        return;
      }
      void loadConversations(currentUser.id).catch(handleSessionError);
    });
    nextSocket.on("presence:changed", () => {
      void loadConversations(currentUser.id).catch(handleSessionError);
    });
    setSocket(nextSocket);
    void Promise.all([loadUsers(currentUser.id), loadConversations(currentUser.id)]).catch(handleSessionError);
    return () => {
      nextSocket.disconnect();
    };
  }, [currentUser]);

  useEffect(() => {
    if (!socket || !activeConversationId) return;
    socket.emit("conversation:join", activeConversationId);
    return () => {
      socket.emit("conversation:leave", activeConversationId);
    };
  }, [socket, activeConversationId]);

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list) {
        list.scrollTo({ top: list.scrollHeight, behavior });
        return;
      }
      bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }

  useEffect(() => {
    scrollToBottom(messages.length > 2 ? "auto" : "smooth");
    const timer = window.setTimeout(() => scrollToBottom("auto"), 160);
    return () => window.clearTimeout(timer);
  }, [messages, activeConversationId]);

  useEffect(() => {
    return () => {
      stopCamera();
      if (capturedMedia) URL.revokeObjectURL(capturedMedia.url);
    };
  }, []);

  async function loadUsers(userId: number) {
    const result = await api<{ users: User[] }>(`/api/users?userId=${userId}`);
    setUsers(result.users);
  }

  async function loadConversations(userId: number) {
    const result = await api<{ conversations: Conversation[] }>(`/api/conversations?userId=${userId}`);
    setConversations(result.conversations);
  }

  async function openDirect(peerId: number) {
    if (!currentUser) return;
    const result = await api<{ conversationId: number }>("/api/conversations/direct", {
      method: "POST",
      body: JSON.stringify({ userId: currentUser.id, peerId }),
    });
    setActiveConversationId(result.conversationId);
    setMode("chats");
    await loadConversations(currentUser.id);
    await loadMessages(result.conversationId);
  }

  async function loadMessages(conversationId: number) {
    if (!currentUser) return;
    const result = await api<{ messages: ChatMessage[] }>(
      `/api/conversations/${conversationId}/messages?userId=${currentUser.id}`,
    );
    setMessages(result.messages);
    window.setTimeout(() => scrollToBottom("auto"), 0);
    window.setTimeout(() => scrollToBottom("auto"), 220);
    await loadConversations(currentUser.id);
  }

  async function sendMessage(event?: React.SyntheticEvent) {
    event?.preventDefault();
    setSendDebug("发送触发");
    if (sendingRef.current) {
      setSendDebug("正在发送中");
      return;
    }
    const inputValue = composerInputRef.current?.value ?? draftRef.current;
    const currentUserValue = currentUserRef.current;
    const activeConversationIdValue = activeConversationIdRef.current;
    if (!currentUserValue) {
      setSendDebug("未登录，不能发送");
      return;
    }
    if (!activeConversationIdValue) {
      setSendDebug("没有打开会话");
      return;
    }
    if (!inputValue.trim()) {
      setSendDebug("输入框是空的");
      return;
    }
    const body = inputValue.trim();
    setDraft("");
    sendingRef.current = true;
    try {
      await api<{ message: ChatMessage }>(`/api/conversations/${activeConversationIdValue}/messages`, {
        method: "POST",
        body: JSON.stringify({
          userId: currentUserValue.id,
          body,
          clientId: makeClientId(currentUserValue.id),
        }),
      });
      setSendDebug("发送成功");
      scrollToBottom("smooth");
    } catch (error) {
      setSendDebug(error instanceof Error ? `发送失败：${error.message}` : "发送失败");
      setDraft(body);
    } finally {
      sendingRef.current = false;
    }
  }

  function bindSendButton(button: HTMLButtonElement | null) {
    if (sendButtonRef.current === button) return;
    sendButtonCleanupRef.current?.();
    sendButtonCleanupRef.current = null;
    sendButtonRef.current = button;
    if (!button) return;

    const handleNativeSend = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      void sendMessage();
    };

    button.addEventListener("touchstart", handleNativeSend, { passive: false });
    button.addEventListener("pointerdown", handleNativeSend);
    sendButtonCleanupRef.current = () => {
      button.removeEventListener("touchstart", handleNativeSend);
      button.removeEventListener("pointerdown", handleNativeSend);
    };
  }

  async function togglePin(conversation: Conversation) {
    if (!currentUser) return;
    await api<{ ok: true }>(`/api/conversations/${conversation.id}/pin`, {
      method: "PATCH",
      body: JSON.stringify({ userId: currentUser.id, pinned: !conversation.is_pinned }),
    });
    await loadConversations(currentUser.id);
  }

  async function deleteConversationFriend(conversation: Conversation) {
    if (!currentUser || !conversation.peer_id || conversation.peer_id === currentUser.id) return;
    if (!window.confirm(`确定删除好友「${conversation.peer_nickname ?? "对方"}」吗？删除后会从联系人和会话列表隐藏。`)) return;
    try {
      await api<{ ok: true }>(`/api/friends/${conversation.peer_id}?userId=${currentUser.id}`, { method: "DELETE" });
      if (activeConversationId === conversation.id) {
        setActiveConversationId(null);
        setMessages([]);
      }
      setConversationMenu(null);
      setSwipedConversationId(null);
      await loadUsers(currentUser.id);
      await loadConversations(currentUser.id);
      setNotice("已删除好友");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除好友失败");
    }
  }

  function openConversationMenu(conversationId: number, x: number, y: number) {
    const menuWidth = 152;
    const menuHeight = 44;
    const margin = 10;
    setConversationMenu({
      conversationId,
      x: Math.min(Math.max(x, margin + menuWidth / 2), window.innerWidth - margin - menuWidth / 2),
      y: Math.min(Math.max(y, margin + menuHeight), window.innerHeight - margin),
    });
  }

  function startConversationPress(conversationId: number, event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    conversationPressTimerRef.current = window.setTimeout(() => {
      openConversationMenu(conversationId, rect.left + rect.width / 2, rect.top + 8);
    }, 520);
  }

  function cancelConversationPress() {
    if (conversationPressTimerRef.current) window.clearTimeout(conversationPressTimerRef.current);
    conversationPressTimerRef.current = null;
  }

  function handleConversationTouchStart(conversationId: number, event: React.TouchEvent) {
    const touch = event.touches[0];
    conversationTouchStartRef.current = { id: conversationId, x: touch.clientX, y: touch.clientY };
  }

  function handleConversationTouchEnd(conversationId: number, event: React.TouchEvent) {
    const start = conversationTouchStartRef.current;
    const touch = event.changedTouches[0];
    conversationTouchStartRef.current = null;
    if (!start || start.id !== conversationId) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) > 54 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
      setSwipedConversationId(deltaX < 0 ? conversationId : null);
    }
  }

  async function uploadFiles(files: FileList | null, source: "picker" | "capture" = "picker") {
    if (!currentUser || !activeConversationId || !files?.length) return;
    let uploaded = false;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("userId", String(currentUser.id));
        formData.append("file", file);
        const response = await fetch(`${API_URL}/api/conversations/${activeConversationId}/uploads`, {
          method: "POST",
          body: formData,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "上传失败");
        uploaded = true;
      }
      if (uploaded) {
        setNotice("已发送");
        scrollToBottom("smooth");
      }
      if (uploaded && source === "capture") closeCamera();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (captureInputRef.current) captureInputRef.current.value = "";
    }
  }

  async function uploadBlob(blob: Blob, fileName: string) {
    if (!currentUser || !activeConversationId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("userId", String(currentUser.id));
      formData.append("file", new File([blob], fileName, { type: blob.type }));
      const response = await fetch(`${API_URL}/api/conversations/${activeConversationId}/uploads`, {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "上传失败");
      closeCamera();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function openCamera(mode: CaptureMode) {
    setCaptureMode(mode);
    setCameraOpen(true);
    setCapturedMedia(null);
    setCameraError("");
    setToolPanelOpen(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持直接调用摄像头");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: mode === "video",
      });
      mediaStreamRef.current = stream;
      setTimeout(() => {
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          void cameraVideoRef.current.play();
        }
      }, 0);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "无法打开摄像头，请允许浏览器摄像头权限");
    }
  }

  function stopCamera() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  function closeCamera() {
    stopCamera();
    if (capturedMedia) URL.revokeObjectURL(capturedMedia.url);
    setCapturedMedia(null);
    setCameraError("");
    setRecording(false);
    setCameraOpen(false);
  }

  function takePhoto() {
    const video = cameraVideoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (capturedMedia) URL.revokeObjectURL(capturedMedia.url);
      setCapturedMedia({
        blob,
        url: URL.createObjectURL(blob),
        fileName: `photo-${Date.now()}.jpg`,
        type: "image",
      });
    }, "image/jpeg", 0.92);
  }

  function toggleRecording() {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : undefined });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      if (capturedMedia) URL.revokeObjectURL(capturedMedia.url);
      setCapturedMedia({
        blob,
        url: URL.createObjectURL(blob),
        fileName: `video-${Date.now()}.webm`,
        type: "video",
      });
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }

  function toggleMessageSelection(messageId: number) {
    setSelectedMessageIds((ids) => (ids.includes(messageId) ? ids.filter((id) => id !== messageId) : [...ids, messageId]));
  }

  function focusComposer() {
    setToolPanelOpen(false);
    setSelectedMessageIds([]);
    setActionMenu(null);
  }

  function toggleToolPanel() {
    setSelectedMessageIds([]);
    setActionMenu(null);
    composerInputRef.current?.blur();
    setToolPanelOpen((open) => !open);
  }

  function openActionMenu(messageId: number, x: number, y: number) {
    setToolPanelOpen(false);
    const menuWidth = Math.min(324, window.innerWidth - 24);
    const menuHeight = 48;
    const margin = 12;
    setActionMenu({
      messageId,
      x: Math.min(Math.max(x, margin + menuWidth / 2), window.innerWidth - margin - menuWidth / 2),
      y: Math.min(Math.max(y, margin + menuHeight), window.innerHeight - margin),
    });
  }

  async function recallSelectedMessage() {
    if (!currentUser || !actionMenu) return;
    const sourceMessage = messages.find((message) => message.id === actionMenu.messageId);
    try {
      await api<{ message: ChatMessage }>(`/api/messages/${actionMenu.messageId}/recall`, {
        method: "POST",
        body: JSON.stringify({ userId: currentUser.id }),
      });
      if (sourceMessage?.type === "text") {
        setEditableRecalls((items) => ({ ...items, [sourceMessage.id]: sourceMessage.body }));
      }
      setNotice("已撤回");
      setActionMenu(null);
      setSelectedMessageIds([]);
      if (activeConversationId) await loadMessages(activeConversationId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "撤回失败");
    }
  }

  function startLongPress(messageId: number, event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    const message = messages.find((item) => item.id === messageId);
    if (message?.revoked_at) return;
    const point = event.currentTarget.getBoundingClientRect();
    longPressTimerRef.current = window.setTimeout(() => {
      openActionMenu(messageId, point.left + point.width / 2, point.top);
    }, 520);
  }

  function startForwardFromMenu(mode: ForwardMode) {
    if (!actionMenu) return;
    setSelectedMessageIds([actionMenu.messageId]);
    setNotice(mode === "bundle" ? "已进入多选，选完后点合并转发" : "已进入多选，选完后点逐条转发");
    setActionMenu(null);
  }

  function reEditMessage(messageId: number) {
    const body = editableRecalls[messageId];
    if (!body) return;
    setDraft(body);
    setEditableRecalls((items) => {
      const next = { ...items };
      delete next[messageId];
      return next;
    });
    setToolPanelOpen(false);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }

  function cancelLongPress() {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }

  async function forwardTo(conversationId: number) {
    if (!currentUser || !forwardMode || selectedMessageIds.length === 0) return;
    await api<{ messages: ChatMessage[] }>(`/api/conversations/${conversationId}/forward`, {
      method: "POST",
      body: JSON.stringify({
        userId: currentUser.id,
        messageIds: selectedMessageIds,
        mode: forwardMode,
      }),
    });
    setNotice(forwardMode === "bundle" ? "已合并转发" : "已逐条转发");
    setSelectedMessageIds([]);
    setForwardMode(null);
    setActionMenu(null);
    await loadConversations(currentUser.id);
    if (conversationId === activeConversationId) await loadMessages(conversationId);
  }

  function logout() {
    localStorage.removeItem("local-chat-user");
    setCurrentUser(null);
    setSocket(null);
    setActiveConversationId(null);
    setMessages([]);
  }

  if (!currentUser) return <Login onLogin={setCurrentUser} />;

  const keyword = query.trim().toLowerCase();
  const contactUsers = [currentUser, ...users];
  const filteredUsers = contactUsers.filter((user) => `${user.nickname}${user.phone}`.toLowerCase().includes(keyword));
  const filteredConversations = conversations.filter((conversation) => {
    if (!keyword) return true;
    const preview = formatConversationPreview(conversation);
    return `${conversation.peer_nickname ?? ""}${conversation.peer_phone ?? ""}${preview}`.toLowerCase().includes(keyword);
  });
  const totalUnread = conversations.reduce((sum, conversation) => sum + conversation.unread_count, 0);

  return (
    <main className={`app-shell ${activeConversation ? "chat-open" : ""} ${toolPanelOpen ? "tool-open" : ""}`}>
      <aside className="sidebar">
        <header className="profile-bar">
          <button className={`avatar avatar-button ${avatarRoleClass(currentUser.phone)}`} onClick={() => void openDirect(currentUser.id)} aria-label="打开自己的聊天">
            {avatarLabel(currentUser.nickname)}
          </button>
          <div>
            <strong>{currentUser.nickname}</strong>
            <span>{currentUser.phone}</span>
          </div>
          <button className="ghost-button" onClick={logout}>
            退出
          </button>
        </header>

        <div className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
              <X size={15} />
            </button>
          ) : null}
        </div>

        <nav className="tabs">
          <button className={mode === "chats" ? "active" : ""} onClick={() => setMode("chats")}>
            <MessageCircle size={17} />
            聊天
            {totalUnread > 0 ? <em>{totalUnread}</em> : null}
          </button>
          <button className={mode === "contacts" ? "active" : ""} onClick={() => setMode("contacts")}>
            <UsersRound size={17} />
            联系人
          </button>
        </nav>

        <section className="list">
          {mode === "chats" ? (
            filteredConversations.length ? (
              filteredConversations.map((conversation) => (
                <div key={conversation.id} className={`conversation-swipe ${swipedConversationId === conversation.id ? "revealed" : ""}`}>
                  <button
                    className={`list-row conversation-row ${activeConversationId === conversation.id ? "selected" : ""} ${conversation.is_pinned ? "pinned" : ""}`}
                    onClick={() => {
                      if (swipedConversationId === conversation.id) {
                        setSwipedConversationId(null);
                        return;
                      }
                      setActiveConversationId(conversation.id);
                      void loadMessages(conversation.id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openConversationMenu(conversation.id, event.clientX, event.clientY);
                    }}
                    onPointerDown={(event) => startConversationPress(conversation.id, event)}
                    onPointerUp={cancelConversationPress}
                    onPointerCancel={cancelConversationPress}
                    onPointerLeave={cancelConversationPress}
                    onTouchStart={(event) => handleConversationTouchStart(conversation.id, event)}
                    onTouchEnd={(event) => handleConversationTouchEnd(conversation.id, event)}
                  >
                    <div className={`avatar small ${avatarRoleClass(conversation.peer_phone)}`}>{avatarLabel(conversation.peer_nickname)}</div>
                    <div className="row-main">
                      <div className="row-title">
                        <strong>{conversation.peer_nickname ?? "会话"}</strong>
                        <span>{formatTime(conversation.last_message_at)}</span>
                      </div>
                      <p>{formatConversationPreview(conversation)}</p>
                    </div>
                    {conversation.unread_count > 0 ? <b className="badge">{conversation.unread_count}</b> : null}
                  </button>
                  <div className="swipe-actions">
                    <button className="swipe-pin" onClick={() => void togglePin(conversation)}>{conversation.is_pinned ? "取消置顶" : "置顶"}</button>
                    {conversation.peer_id !== currentUser.id ? <button className="swipe-delete" onClick={() => void deleteConversationFriend(conversation)}>删除</button> : null}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState icon={<MessageCircle />} title={keyword ? "没有找到会话" : "暂无会话"} text={keyword ? "换个关键词试试。" : "从联系人开始一个聊天。"} />
            )
          ) : filteredUsers.length ? (
            filteredUsers.map((user) => {
              const isSelf = user.id === currentUser.id;
              return (
              <button key={user.id} className="list-row" onClick={() => void openDirect(user.id)}>
                <div className={`avatar small ${avatarRoleClass(user.phone)}`}>{avatarLabel(user.nickname)}</div>
                <div className="row-main">
                  <div className="row-title">
                    <strong>{isSelf ? `${user.nickname}（自己）` : user.nickname}</strong>
                    <span className={isOnline(user.last_seen_at) ? "online" : ""}>
                      {isSelf ? "自己" : isOnline(user.last_seen_at) ? "在线" : "离线"}
                    </span>
                  </div>
                  <p>{user.phone}</p>
                </div>
              </button>
              );
            })
          ) : (
            <EmptyState icon={<UserPlus />} title={keyword ? "没有找到联系人" : "暂无联系人"} text={keyword ? "换个昵称或手机号试试。" : "用另一个手机号登录即可生成测试联系人。"} />
          )}
        </section>
      </aside>

      <section className="chat-panel">
        {activeConversation ? (
          <>
            <header className="chat-header">
              <button
                className="mobile-back"
                type="button"
                onClick={() => {
                  setActiveConversationId(null);
                  setMessages([]);
                }}
                aria-label="返回聊天列表"
              >
                <X size={20} />
              </button>
              <div>
                <strong>{activeConversation.peer_nickname ?? "会话"}</strong>
                <span className={isOnline(activeConversation.peer_last_seen_at) ? "online" : ""}>
                  {isOnline(activeConversation.peer_last_seen_at) ? "在线" : "离线"}
                </span>
              </div>
              <button className="icon-button" onClick={() => void togglePin(activeConversation)} aria-label={activeConversation.is_pinned ? "取消置顶" : "置顶"}>
                {activeConversation.is_pinned ? <PinOff size={18} /> : <Pin size={18} />}
              </button>
            </header>
            {selectedMessageIds.length > 0 ? (
              <div className="selection-bar">
                <span>已选 {selectedMessageIds.length} 条</span>
                <button onClick={() => setForwardMode("separate")}>逐条转发</button>
                <button onClick={() => setForwardMode("bundle")}>合并转发</button>
                <button className="plain-icon" onClick={() => setSelectedMessageIds([])} aria-label="取消多选">
                  <X size={16} />
                </button>
              </div>
            ) : null}
            <div className="message-list" ref={messageListRef}>
              {messages.map((message) => {
                const mine = message.sender_id === currentUser.id;
                const selected = selectedMessageIds.includes(message.id);
                const senderPhone = mine
                  ? currentUser.phone
                  : users.find((user) => user.id === message.sender_id)?.phone ??
                    (activeConversation.peer_id === message.sender_id ? activeConversation.peer_phone : null);
                if (message.revoked_at) {
                  const canReEdit = mine && Boolean(editableRecalls[message.id]);
                  return (
                    <div key={message.id} className="recalled-row">
                      <span>{mine ? "你撤回了一条消息" : `${message.sender_nickname}撤回了一条消息`}</span>
                      {canReEdit ? <button onClick={() => reEditMessage(message.id)}>重新编辑</button> : null}
                    </div>
                  );
                }
                return (
                  <div key={message.id} className={`message-row ${mine ? "mine" : ""} ${selectedMessageIds.length > 0 ? "selecting" : ""}`}>
                    {selectedMessageIds.length > 0 ? (
                      <button
                        className={`select-dot ${selected ? "selected" : ""}`}
                        onClick={() => toggleMessageSelection(message.id)}
                        aria-label={selected ? "取消选择消息" : "选择消息"}
                      >
                        {selected ? <Check size={13} /> : null}
                      </button>
                    ) : null}
                    {!mine ? (
                      <button className={`avatar tiny avatar-button message-avatar ${avatarRoleClass(senderPhone)}`} onClick={() => void openDirect(message.sender_id)} aria-label={`打开和${message.sender_nickname}的聊天`}>
                        {avatarLabel(message.sender_nickname)}
                      </button>
                    ) : null}
                    <div className="bubble-wrap">
                      <span>{formatTime(message.created_at)}</span>
                      <button
                        className="bubble-button"
                        onClick={() => {
                          if (selectedMessageIds.length > 0) {
                            toggleMessageSelection(message.id);
                            return;
                          }
                          if (message.revoked_at) return;
                          if (message.type === "forward_bundle" && selectedMessageIds.length === 0) {
                            const bundle = parseBody<BundleBody>(message.body);
                            if (bundle) setViewingBundle(bundle);
                            return;
                          }
                          if (message.type === "image" || message.type === "video") {
                            const media = parseBody<MediaBody>(message.body);
                            if (media) setViewingMedia(media);
                          }
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          if (message.revoked_at) return;
                          openActionMenu(message.id, event.clientX, event.clientY);
                        }}
                        onPointerDown={(event) => startLongPress(message.id, event)}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                      >
                        <MessageBubble message={message} onMediaLoad={() => scrollToBottom("auto")} />
                      </button>
                    </div>
                    {mine ? (
                      <button className={`avatar tiny avatar-button message-avatar mine-avatar ${avatarRoleClass(currentUser.phone)}`} onClick={() => void openDirect(currentUser.id)} aria-label="打开自己的聊天">
                        {avatarLabel(message.sender_nickname)}
                      </button>
                    ) : null}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
            <div className="send-debug">{APP_VERSION} · {sendDebug || "等待发送"}</div>
            <div className="composer">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={(event) => void uploadFiles(event.target.files, "picker")}
              />
              <input
                ref={captureInputRef}
                type="file"
                accept="image/*,video/*"
                capture="environment"
                hidden
                onChange={(event) => void uploadFiles(event.target.files, "capture")}
              />
              <textarea
                ref={composerInputRef}
                value={draft}
                onPointerDown={focusComposer}
                onFocus={focusComposer}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="输入消息"
                rows={1}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage(event);
                  }
                }}
              />
              <button
                ref={bindSendButton}
                type="button"
                className={`send-button ${draft.trim() ? "" : "is-empty"}`}
                aria-disabled={!draft.trim()}
                onPointerDown={(event) => {
                  event.preventDefault();
                  void sendMessage(event);
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  void sendMessage(event);
                }}
                onClick={(event) => void sendMessage(event)}
                aria-label="发送消息"
              >
                <Send size={18} />
                <span className="button-hitbox" aria-hidden="true" />
              </button>
              <button type="button" className="plus-button" onClick={toggleToolPanel} aria-label="打开更多功能">
                <Plus size={24} />
              </button>
            </div>
            {toolPanelOpen ? (
              <div className="tool-panel">
                <ToolButton icon={<ImageIcon />} label="照片" onClick={() => fileInputRef.current?.click()} />
                <ToolButton icon={<Camera />} label="拍摄" onClick={() => void openCamera("photo")} />
                <ToolButton icon={<FileIcon />} label="文件" onClick={() => fileInputRef.current?.click()} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-chat">
            <MessageCircle size={42} />
            <strong>选择一个联系人开始聊天</strong>
            <span>本地版已支持两个窗口实时收发消息。</span>
          </div>
        )}
      </section>
      {forwardMode ? (
        <div className="modal-mask">
          <section className="forward-modal">
            <header>
              <strong>{forwardMode === "bundle" ? "合并转发到" : "逐条转发到"}</strong>
              <button className="plain-icon" onClick={() => setForwardMode(null)} aria-label="关闭">
                <X size={17} />
              </button>
            </header>
            <div className="forward-list">
              {conversations.map((conversation) => (
                <button key={conversation.id} onClick={() => void forwardTo(conversation.id)}>
                  <div className={`avatar small ${avatarRoleClass(conversation.peer_phone)}`}>{avatarLabel(conversation.peer_nickname)}</div>
                  <span>{conversation.peer_nickname ?? "会话"}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {viewingBundle ? (
        <div className="modal-mask">
          <section className="record-modal">
            <header>
              <div>
                <strong>{viewingBundle.title}</strong>
                <span>{viewingBundle.count} 条消息</span>
              </div>
              <button className="plain-icon" onClick={() => setViewingBundle(null)} aria-label="关闭聊天记录">
                <X size={18} />
              </button>
            </header>
            <div className="record-list">
              {viewingBundle.items.map((item, index) => (
                <article key={`${item.createdAt}-${index}`} className="record-item">
                  <div className="record-meta">
                    <strong>{item.sender}</strong>
                    <span>{formatTime(item.createdAt)}</span>
                  </div>
                  <RecordContent item={item} />
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {viewingMedia ? (
        <div className="media-viewer" onClick={() => setViewingMedia(null)}>
          <button className="media-viewer-close" onClick={() => setViewingMedia(null)} aria-label="关闭图片视频预览">
            <X size={30} />
          </button>
          {viewingMedia.mimeType.startsWith("video/") ? (
            <video src={`${API_URL}${viewingMedia.url}`} controls autoPlay onClick={(event) => event.stopPropagation()} />
          ) : (
            <img src={`${API_URL}${viewingMedia.url}`} alt={viewingMedia.name} onClick={(event) => event.stopPropagation()} />
          )}
        </div>
      ) : null}
      {actionMenu ? (
        <div className="message-action-layer" onClick={() => setActionMenu(null)}>
          <div
            className="message-action-menu"
            style={{ left: actionMenu.x, top: actionMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {messages.find((message) => message.id === actionMenu.messageId)?.sender_id === currentUser.id ? (
              <button onClick={() => void recallSelectedMessage()}>撤回</button>
            ) : null}
            <button onClick={() => startForwardFromMenu("separate")}>逐条转发</button>
            <button onClick={() => startForwardFromMenu("bundle")}>合并转发</button>
            <button
              onClick={() => {
                setSelectedMessageIds([actionMenu.messageId]);
                setActionMenu(null);
              }}
            >
              多选
            </button>
          </div>
        </div>
      ) : null}
      {conversationMenu ? (
        <div className="message-action-layer" onClick={() => setConversationMenu(null)}>
          <div
            className="message-action-menu conversation-action-menu"
            style={{ left: conversationMenu.x, top: conversationMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {(() => {
              const conversation = conversations.find((item) => item.id === conversationMenu.conversationId);
              if (!conversation) return null;
              return (
                <>
                  <button
                    onClick={() => {
                      setConversationMenu(null);
                      void togglePin(conversation);
                    }}
                  >
                    {conversation.is_pinned ? "取消置顶" : "置顶"}
                  </button>
                  {conversation.peer_id !== currentUser.id ? (
                    <button
                      onClick={() => {
                        setConversationMenu(null);
                        void deleteConversationFriend(conversation);
                      }}
                    >
                      删除
                    </button>
                  ) : null}
                </>
              );
            })()}
          </div>
        </div>
      ) : null}
      {notice ? (
        <div className="toast" onAnimationEnd={() => setNotice("")}>
          {notice}
        </div>
      ) : null}
      {cameraOpen ? (
        <div className="camera-layer">
          <button className="camera-close" onClick={closeCamera} aria-label="关闭拍摄">
            <X size={36} />
          </button>
          <div className="camera-preview">
            {capturedMedia ? (
              capturedMedia.type === "image" ? (
                <img src={capturedMedia.url} alt="拍摄预览" />
              ) : (
                <video src={capturedMedia.url} controls autoPlay loop />
              )
            ) : cameraError ? (
              <div className="camera-error">
                <Camera size={44} />
                <strong>无法直接打开摄像头</strong>
                <span>{cameraError}</span>
                <button onClick={() => captureInputRef.current?.click()}>用系统拍摄/选择</button>
              </div>
            ) : (
              <video ref={cameraVideoRef} autoPlay playsInline muted />
            )}
          </div>
          <div className="camera-hint">{captureMode === "photo" ? "轻触拍照，切到摄像可录制" : "轻触开始/停止摄像"}</div>
          <div className="camera-controls">
            <button className="camera-side" aria-label="闪光灯占位" disabled>
              <ZapOff size={28} />
            </button>
            {capturedMedia ? (
              <button className="capture-send" onClick={() => void uploadBlob(capturedMedia.blob, capturedMedia.fileName)} disabled={uploading}>
                <SendHorizontal size={30} />
              </button>
            ) : (
              <button className={`capture-button ${recording ? "recording" : ""}`} onClick={captureMode === "photo" ? takePhoto : toggleRecording} aria-label={captureMode === "photo" ? "拍照" : "录视频"} />
            )}
            <button
              className="camera-side"
              onClick={() => {
                if (capturedMedia) {
                  URL.revokeObjectURL(capturedMedia.url);
                  setCapturedMedia(null);
                  return;
                }
                setCaptureMode((mode) => (mode === "photo" ? "video" : "photo"));
              }}
              aria-label={capturedMedia ? "重拍" : "切换拍照摄像"}
            >
              {capturedMedia ? <RefreshCw size={28} /> : captureMode === "photo" ? <Camera size={28} /> : <RefreshCw size={28} />}
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function ToolButton({ icon, label, onClick, disabled = false }: { icon: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button className="tool-button" type="button" onClick={onClick} disabled={disabled}>
      <span>{icon}</span>
      <strong>{label}</strong>
    </button>
  );
}

function MessageBubble({ message, onMediaLoad }: { message: ChatMessage; onMediaLoad?: () => void }) {
  if (message.revoked_at) {
    return <p className="bubble">[已撤回]</p>;
  }

  if (message.type === "image") {
    const media = parseBody<MediaBody>(message.body);
    if (!media) return <p className="bubble">[图片]</p>;
    return (
      <div className="bubble media-bubble image-bubble">
        <img src={`${API_URL}${media.url}`} alt={media.name} onLoad={onMediaLoad} />
      </div>
    );
  }

  if (message.type === "video") {
    const media = parseBody<MediaBody>(message.body);
    if (!media) return <p className="bubble">[视频]</p>;
    return <VideoBubble media={media} onMediaLoad={onMediaLoad} />;
  }

  if (message.type === "forward_bundle") {
    const bundle = parseBody<BundleBody>(message.body);
    if (!bundle) return <p className="bubble">[聊天记录]</p>;
    return (
      <div className="bubble bundle-bubble">
        <FileStack size={18} />
        <strong>{bundle.title}</strong>
        <span>{bundle.count} 条消息</span>
        {bundle.items.slice(0, 3).map((item, index) => (
          <p key={`${item.createdAt}-${index}`}>
            {item.sender}: {item.type === "text" ? item.body : item.type === "image" ? "[图片]" : item.type === "video" ? "[视频]" : "[聊天记录]"}
          </p>
        ))}
      </div>
    );
  }

  return <p className="bubble">{message.body}</p>;
}

function VideoBubble({ media, onMediaLoad }: { media: MediaBody; onMediaLoad?: () => void }) {
  const [duration, setDuration] = useState<number | null>(null);
  const [poster, setPoster] = useState("");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const posterPendingRef = useRef(false);

  function capturePoster(video: HTMLVideoElement) {
    if (poster || !video.videoWidth || !video.videoHeight) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setPoster(canvas.toDataURL("image/jpeg", 0.72));
      posterPendingRef.current = false;
    } catch {
      // Some mobile browsers block canvas extraction for media; the video element still shows its first frame.
      posterPendingRef.current = false;
    }
  }

  return (
    <div className={`bubble media-bubble video-bubble ${orientation} ${poster ? "has-poster" : ""}`}>
      <video
        src={`${API_URL}${media.url}`}
        poster={poster || undefined}
        preload="metadata"
        muted
        playsInline
        crossOrigin="anonymous"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          setOrientation(video.videoHeight > video.videoWidth ? "portrait" : "landscape");
          posterPendingRef.current = true;
          try {
            video.currentTime = Math.min(0.1, Math.max(0, (video.duration || 1) - 0.05));
          } catch {
            capturePoster(video);
          }
          onMediaLoad?.();
        }}
        onLoadedData={(event) => {
          if (!posterPendingRef.current) capturePoster(event.currentTarget);
          onMediaLoad?.();
        }}
        onSeeked={(event) => {
          capturePoster(event.currentTarget);
          onMediaLoad?.();
        }}
      />
      {!poster ? <strong>视频</strong> : null}
      <span className="video-play">
        <Play size={26} fill="currentColor" />
      </span>
      {duration ? <em>{formatDuration(duration)}</em> : null}
    </div>
  );
}

function RecordContent({ item }: { item: BundleBody["items"][number] }) {
  if (item.type === "image") {
    const media = parseBody<MediaBody>(item.body);
    if (!media) return <p>[图片]</p>;
    return <img className="record-media" src={`${API_URL}${media.url}`} alt={media.name} />;
  }

  if (item.type === "video") {
    const media = parseBody<MediaBody>(item.body);
    if (!media) return <p>[视频]</p>;
    return <video className="record-media" src={`${API_URL}${media.url}`} controls preload="metadata" />;
  }

  if (item.type === "forward_bundle") {
    const bundle = parseBody<BundleBody>(item.body);
    return (
      <div className="record-nested">
        <FileStack size={16} />
        <span>{bundle ? `${bundle.title}（${bundle.count} 条）` : "[聊天记录]"}</span>
      </div>
    );
  }

  return <p>{item.body}</p>;
}

function formatConversationPreview(conversation: Conversation) {
  if (!conversation.last_message_body) return "暂无消息";
  if (conversation.last_message_body.startsWith('{"url":')) {
    return conversation.last_message_body.includes('"mimeType":"video/') ? "[视频]" : "[图片]";
  }
  if (conversation.last_message_body.startsWith('{"title":"聊天记录"')) return "[聊天记录]";
  return conversation.last_message_body;
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(window.location.pathname.startsWith("/admin") ? <AdminApp /> : <App />);


