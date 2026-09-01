import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import {
  Bell,
  Camera,
  Check,
  ChevronDown,
  Copy,
  Download,
  File as FileIcon,
  FileStack,
  GripVertical,
  ImageIcon,
  MessageCircle,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  SendHorizontal,
  UserPlus,
  UsersRound,
  X,
  ZapOff,
} from "lucide-react";
import "./styles.css";

const API_URL = window.location.origin;
const INVITE_CODE_STORAGE_KEY = "doudou-im-invite-code";
const MESSAGE_PAGE_SIZE = 50;
const MAX_VIDEO_UPLOAD_SIZE = 80 * 1024 * 1024;
const MAX_IMAGE_UPLOAD_EDGE = 1600;
const IMAGE_UPLOAD_QUALITY = 0.82;
const INVITE_COOKIE_NAME = "doudou_im_invite_code";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function getCookieValue(name: string) {
  const escapedName = `${name}=`;
  const entry = document.cookie.split("; ").find((item) => item.startsWith(escapedName));
  if (!entry) return "";
  const value = entry.slice(escapedName.length);
  return value ? decodeURIComponent(value) : "";
}

function setCookieValue(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=2592000; samesite=lax`;
}

function currentInviteCode() {
  const fromUrl = new URLSearchParams(window.location.search).get("invite")?.trim() ?? "";
  if (fromUrl) {
    localStorage.setItem(INVITE_CODE_STORAGE_KEY, fromUrl);
    setCookieValue(INVITE_COOKIE_NAME, fromUrl);
    return fromUrl;
  }
  const cookieInvite = getCookieValue(INVITE_COOKIE_NAME);
  const stored = localStorage.getItem(INVITE_CODE_STORAGE_KEY) ?? cookieInvite ?? "";
  if (stored && !window.location.pathname.startsWith("/admin")) {
    const url = new URL(window.location.href);
    url.searchParams.set("invite", stored);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return stored;
}

const INTERNAL_ERROR_MESSAGE_MAP: Record<string, string> = {
  NOT_CONVERSATION_MEMBER: "当前会话不可用，请返回列表后重试",
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app can still run if the browser blocks service worker registration.
    });
  });
}

function normalizeUserError(error: unknown, fallback = "操作失败，请稍后重试") {
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = rawMessage.trim();
  if (!message) return fallback;
  if (INTERNAL_ERROR_MESSAGE_MAP[message]) return INTERNAL_ERROR_MESSAGE_MAP[message];
  if (!/[\u4e00-\u9fff]/.test(message) && /[A-Za-z]/.test(message)) return fallback;
  if (/^[A-Z][A-Z0-9_:-]{2,}$/.test(message)) return fallback;
  if (/Error:|stack|SQLITE_|SQLITE_CONSTRAINT|ENOENT|ECONN|fetch failed|NetworkError|Failed to fetch|Unexpected token/i.test(message)) {
    return fallback;
  }
  return message;
}

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

function avatarUrl(value: string | null | undefined) {
  if (!value) return "";
  return value.startsWith("http") ? value : `${API_URL}${value}`;
}

function avatarStyle(value: string | null | undefined): React.CSSProperties | undefined {
  if (!value) return undefined;
  return {
    backgroundImage: `url(${avatarUrl(value)})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    color: "transparent",
  };
}

function displayNameForConversation(conversation: Conversation) {
  return conversation.peer_nickname ?? "会话";
}

type User = {
  id: number;
  phone: string;
  nickname: string;
  avatar_url: string | null;
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
  peer_avatar_url: string | null;
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
  sender_avatar_url: string | null;
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
  originalUrl?: string | null;
  originalMimeType?: string | null;
  posterUrl?: string | null;
  name: string;
  size: number;
  originalSize?: number;
  mimeType: string;
  transcoded?: boolean;
};

type WebKitVideoElement = HTMLVideoElement & {
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
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

type QuoteBody = {
  text: string;
  quote: {
    messageId: number;
    sender: string;
    preview: string;
  };
};

type QuoteTarget = QuoteBody["quote"];

type QuickReply = {
  id: number;
  staff_id: number;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
  parent_name: string | null;
  chat_nickname: string | null;
  avatar_url: string | null;
  retention_popup_enabled: number;
  retention_popup_text: string;
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
  today_visits: number;
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
  const text = await response.text();
  let data: { error?: unknown } | null = null;
  try {
    data = text ? (JSON.parse(text) as { error?: unknown }) : null;
  } catch {
    if (!response.ok) throw new Error("请求失败");
    throw new Error("数据加载失败，请刷新后重试");
  }
  if (!response.ok) throw new Error(normalizeUserError(data?.error ?? response.statusText ?? "请求失败", "请求失败"));
  return (data ?? {}) as T;
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
  const text = await response.text();
  let data: { error?: unknown } | null = null;
  try {
    data = text ? (JSON.parse(text) as { error?: unknown }) : null;
  } catch {
    if (!response.ok) throw new Error("请求失败");
    throw new Error("数据加载失败，请刷新后重试");
  }
  if (!response.ok) throw new Error(normalizeUserError(data?.error ?? response.statusText ?? "请求失败", "请求失败"));
  return (data ?? {}) as T;
}

function formatDateTime(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(`${value}Z`));
}

function formatClockTime(value: string | null) {
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

function displayTextBody(body: string) {
  const quoteBody = parseBody<QuoteBody>(body);
  if (quoteBody?.quote) return quoteBody.text;
  const mediaBody = parseBody<MediaBody>(body);
  if (mediaBody?.url) return mediaBody.mimeType?.startsWith("video/") ? "[视频]" : "[图片]";
  const bundleBody = parseBody<BundleBody>(body);
  if (bundleBody?.title) return "[聊天记录]";
  if (/^\s*[{[]/.test(body)) return "[消息]";
  return body;
}

function messagePreview(message: ChatMessage) {
  if (message.revoked_at) return "[撤回了一条消息]";
  if (message.type === "image") return "[图片]";
  if (message.type === "video") return "[视频]";
  if (message.type === "forward_bundle") return "[聊天记录]";
  return displayTextBody(message.body);
}

function quotePreviewForMessage(message: ChatMessage) {
  if (message.revoked_at) return "[撤回了一条消息]";
  if (message.type === "image") return "[图片]";
  if (message.type === "video") return "[视频]";
  if (message.type === "forward_bundle") return "[聊天记录]";
  return displayTextBody(message.body).slice(0, 80);
}

function copyTextForMessage(message: ChatMessage) {
  if (message.revoked_at) return "";
  if (message.type === "image" || message.type === "video") {
    const media = parseBody<MediaBody>(message.body);
    return media?.url ? `${API_URL}${media.url}` : "";
  }
  if (message.type === "forward_bundle") {
    const bundle = parseBody<BundleBody>(message.body);
    if (!bundle) return "[聊天记录]";
    return [
      bundle.title,
      ...bundle.items.map((item) => `${item.sender}: ${displayTextBody(item.body)}`),
    ].join("\n");
  }
  return displayTextBody(message.body);
}

function formatDuration(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function userUploadErrorMessage(error: unknown, fallback = "上传失败，请稍后重试") {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  if (/ffmpeg|encoder|libx264|spawn|ENOENT|\/uploads|\\uploads|configuration:|Input #|Output #/i.test(message)) {
    return "视频处理失败，请换个视频或压缩后重试";
  }
  return normalizeUserError(message, fallback);
}

function isVideoFile(file: File | { name?: string; type?: string }) {
  const extension = file.name?.split(".").pop()?.toLowerCase() ?? "";
  return Boolean(file.type?.startsWith("video/")) || ["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(extension);
}

function isImageFile(file: File | { name?: string; type?: string }) {
  return Boolean(file.type?.startsWith("image/"));
}

async function compressImageForUpload(file: File) {
  if (!isImageFile(file) || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size <= 1.2 * 1024 * 1024) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_UPLOAD_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const fileName = file.name.replace(/\.[^.]+$/, "") || `image-${Date.now()}`;
    return new File([blob], `${fileName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}

function captureVideoPoster(file: File | Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (poster: string | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load();
      resolve(poster);
    };
    const timer = window.setTimeout(() => finish(null), 1200);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = objectUrl;
    video.onloadedmetadata = () => {
      try {
        video.currentTime = Math.min(0.2, Math.max(0, (video.duration || 1) - 0.05));
      } catch {
        window.clearTimeout(timer);
        finish(null);
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 568;
        const context = canvas.getContext("2d");
        if (!context) {
          window.clearTimeout(timer);
          finish(null);
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        window.clearTimeout(timer);
        finish(canvas.toDataURL("image/jpeg", 0.78));
      } catch {
        window.clearTimeout(timer);
        finish(null);
      }
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      finish(null);
    };
  });
}

function captureVideoPosterFromUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (poster: string | null) => {
      if (settled) return;
      settled = true;
      video.removeAttribute("src");
      video.load();
      resolve(poster);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;
    video.onloadedmetadata = () => {
      try {
        video.currentTime = Math.min(0.2, Math.max(0, (video.duration || 1) - 0.05));
      } catch {
        window.clearTimeout(timer);
        finish(null);
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 568;
        const context = canvas.getContext("2d");
        if (!context) {
          window.clearTimeout(timer);
          finish(null);
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        window.clearTimeout(timer);
        finish(canvas.toDataURL("image/jpeg", 0.78));
      } catch {
        window.clearTimeout(timer);
        finish(null);
      }
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      finish(null);
    };
  });
}

type RetentionPopup = {
  text: string;
};

function Login({
  onLogin,
}: {
  onLogin: (
    user: User,
    openConversationId?: number | null,
    retentionPopup?: RetentionPopup | null,
    retentionNotice?: RetentionPopup | null,
  ) => void;
}) {
  const [loginMode, setLoginMode] = useState<"customer" | "service">("customer");
  const [phone, setPhone] = useState("");
  const [serviceUsername, setServiceUsername] = useState("");
  const [servicePassword, setServicePassword] = useState("");
  const inviteCode = useMemo(() => currentInviteCode(), []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function focusLoginInput() {
    window.setTimeout(() => {
      const width = window.visualViewport?.width ?? window.innerWidth;
      const isTouchDevice = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
      if (isTouchDevice && width <= 920) {
        document.documentElement.classList.add("keyboard-open");
        window.scrollTo(0, 0);
      }
    }, 80);
  }

  function blurLoginInput() {
    window.setTimeout(() => {
      if (document.activeElement instanceof HTMLInputElement) return;
      document.documentElement.classList.remove("keyboard-open");
      window.scrollTo(0, 0);
    }, 120);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (loginMode === "customer" && !/^\d{11}$/.test(phone)) {
      setError("请输入 11 位手机号");
      return;
    }
    setLoading(true);
    try {
      const result: {
        user: User;
        openConversationId?: number | null;
        retentionPopup?: RetentionPopup | null;
        retentionNotice?: RetentionPopup | null;
      } =
        loginMode === "service"
          ? await api<{ user: User }>("/api/staff-chat/login", {
              method: "POST",
              body: JSON.stringify({ username: serviceUsername, password: servicePassword }),
            })
          : await api<{
              user: User;
              openConversationId: number | null;
              retentionPopup?: RetentionPopup | null;
              retentionNotice?: RetentionPopup | null;
            }>("/api/login", {
              method: "POST",
              body: JSON.stringify({ phone, inviteCode: inviteCode || undefined }),
            });
      if (inviteCode) localStorage.setItem(INVITE_CODE_STORAGE_KEY, inviteCode);
      localStorage.setItem("local-chat-user", JSON.stringify(result.user));
      const openConversationId =
        "openConversationId" in result && typeof result.openConversationId === "number"
          ? result.openConversationId
          : null;
      const retentionPopup = "retentionPopup" in result ? result.retentionPopup : null;
      const retentionNotice = "retentionNotice" in result ? result.retentionNotice : null;
      onLogin(result.user, openConversationId, retentionPopup, retentionNotice);
    } catch (requestError) {
      setError(normalizeUserError(requestError, "登录失败"));
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
        <h1>抖抖IM</h1>
        <p>{loginMode === "service" ? "请输入客服账号信息进入聊天。" : inviteCode ? "请输入手机号进入专属服务。" : "请输入手机号进入聊天。"}</p>
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
                onFocus={focusLoginInput}
                onBlur={blurLoginInput}
                onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
                placeholder="请输入手机号"
                inputMode="numeric"
                maxLength={11}
                pattern="\d{11}"
                autoComplete="tel"
              />
            </>
          ) : (
            <>
              <label htmlFor="service-username">客服账号</label>
              <input id="service-username" value={serviceUsername} onFocus={focusLoginInput} onBlur={blurLoginInput} onChange={(event) => setServiceUsername(event.target.value)} placeholder="请输入客服账号" autoComplete="username" />
              <label htmlFor="service-password">客服密码</label>
              <input id="service-password" type="password" value={servicePassword} onFocus={focusLoginInput} onBlur={blurLoginInput} onChange={(event) => setServicePassword(event.target.value)} placeholder="请输入客服密码" autoComplete="current-password" />
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
  const [linkQuery, setLinkQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeAdminPage, setActiveAdminPage] = useState<AdminPage>("staff");
  const [customerPage, setCustomerPage] = useState(1);
  const [linkPage, setLinkPage] = useState(1);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<number[]>([]);
  const [staffForm, setStaffForm] = useState({ username: "", password: "", displayName: "" });
  const [staffRetentionDrafts, setStaffRetentionDrafts] = useState<Record<number, { enabled: boolean; text: string }>>({});
  const [linkForm, setLinkForm] = useState({ title: "", ownerStaffId: "", autoReplyEnabled: true, autoReplyText: "{nickname} 你好抖音评论 0.3元一条有效评论，没有数量限制。24小时都可以发 当天晚上10点前统一结算。" });
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const staffAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const staffAvatarTargetRef = useRef<number | null>(null);

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
      setStaffRetentionDrafts(
        Object.fromEntries(
          result.staffAccounts
            .filter((item) => item.role === "service")
            .map((item) => [
              item.id,
              {
                enabled: Boolean(item.retention_popup_enabled),
                text: item.retention_popup_text || "跟着客服操作完，至少可得1.5元。",
              },
            ]),
        ),
      );
    } catch (requestError) {
      setError(normalizeUserError(requestError, "加载失败"));
      localStorage.removeItem("local-chat-admin-token");
      setToken("");
    }
  }

  function showError(message: string) {
    const nextMessage = normalizeUserError(message);
    setError(nextMessage);
    window.alert(nextMessage);
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
      showError(normalizeUserError(requestError, "登录失败"));
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
      showError(normalizeUserError(requestError, "保存失败"));
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
        }),
      });
      setStaffForm({ username: "", password: "", displayName: "" });
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, "创建失败"));
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
      showError(normalizeUserError(requestError, "更新失败"));
    }
  }

  async function saveStaffRetentionPopup(staff: StaffAccount) {
    const draft = staffRetentionDrafts[staff.id] ?? {
      enabled: Boolean(staff.retention_popup_enabled),
      text: staff.retention_popup_text,
    };
    setError("");
    try {
      await adminApi<{ staff: StaffAccount }>(`/api/admin/staff/${staff.id}/retention-popup`, token, {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      await loadOverview();
      window.alert("弹框配置已保存");
    } catch (requestError) {
      showError(normalizeUserError(requestError, "保存失败"));
    }
  }

  async function deleteStaff(staff: StaffAccount) {
    if (!window.confirm(`确定删除客服「${staff.display_name}」吗？删除后该客服账号不能再登录。`)) return;
    setError("");
    try {
      await adminApi<{ ok: true }>(`/api/admin/staff/${staff.id}`, token, { method: "DELETE" });
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, "删除失败"));
    }
  }

  async function uploadStaffAvatar(staff: StaffAccount, file: File | null) {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    setError("");
    try {
      await fetch(`${API_URL}/api/admin/staff/${staff.id}/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }).then(async (response) => {
        const text = await response.text();
        let data: { error?: unknown } = {};
        try {
          data = text ? (JSON.parse(text) as { error?: unknown }) : {};
        } catch {
          if (!response.ok) throw new Error("上传失败");
          throw new Error("数据加载失败，请刷新后重试");
        }
        if (!response.ok) throw new Error(normalizeUserError(data.error, "上传失败"));
        return data;
      });
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, "上传失败"));
    } finally {
      if (staffAvatarInputRef.current) staffAvatarInputRef.current.value = "";
    }
  }

  async function saveLink(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const payload = {
        title: linkForm.title.trim(),
        ownerStaffId: Number(linkForm.ownerStaffId),
        autoReplyEnabled: linkForm.autoReplyEnabled,
        autoReplyText: linkForm.autoReplyText,
      };
      await adminApi<{ inviteLink: InviteLink }>(editingLinkId ? `/api/admin/invite-links/${editingLinkId}` : "/api/admin/invite-links", token, {
        method: editingLinkId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      setLinkForm((form) => ({ ...form, title: "" }));
      setEditingLinkId(null);
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, editingLinkId ? "修改失败" : "创建失败"));
    }
  }

  function startEditLink(link: InviteLink) {
    setEditingLinkId(link.id);
    setLinkForm({
      title: link.title,
      ownerStaffId: String(link.owner_staff_id),
      autoReplyEnabled: Boolean(link.auto_reply_enabled),
      autoReplyText: link.auto_reply_text,
    });
    setError("");
  }

  function cancelEditLink() {
    setEditingLinkId(null);
    setLinkForm((form) => ({ ...form, title: "" }));
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
      showError(normalizeUserError(requestError, "更新失败"));
    }
  }

  async function deleteLink(link: InviteLink) {
    if (!window.confirm(`确定删除链接「${link.title}」吗？删除后二维码和链接将不可用。`)) return;
    setError("");
    try {
      await adminApi<{ ok: true }>(`/api/admin/invite-links/${link.id}`, token, { method: "DELETE" });
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, "删除失败"));
    }
  }

  async function copyInviteLink(code: string) {
    const url = inviteUrl(code);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement("input");
        input.value = url;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      setError("");
      window.alert("链接已复制");
    } catch {
      showError("复制失败，请手动复制链接");
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
      showError(normalizeUserError(requestError, "更新失败"));
    }
  }

  async function batchUpdateUsers(status: "active" | "disabled") {
    if (selectedCustomerIds.length === 0) return;
    const actionText = status === "disabled" ? "禁用" : "启用";
    if (!window.confirm(`确定${actionText}选中的 ${selectedCustomerIds.length} 位客户吗？`)) return;
    setError("");
    try {
      await adminApi<{ count: number }>("/api/admin/users/batch/status", token, {
        method: "PATCH",
        body: JSON.stringify({ userIds: selectedCustomerIds, status }),
      });
      setSelectedCustomerIds([]);
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, `批量${actionText}失败`));
    }
  }

  async function batchDeleteSelectedUsers() {
    if (selectedCustomerIds.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${selectedCustomerIds.length} 位客户吗？删除后客户不能登录，后台列表也会隐藏。`)) return;
    setError("");
    try {
      await adminApi<{ count: number }>("/api/admin/users/batch", token, {
        method: "DELETE",
        body: JSON.stringify({ userIds: selectedCustomerIds }),
      });
      setSelectedCustomerIds([]);
      await loadOverview();
    } catch (requestError) {
      showError(normalizeUserError(requestError, "批量删除失败"));
    }
  }

  useEffect(() => {
    setCustomerPage(1);
    setSelectedCustomerIds([]);
  }, [query]);

  useEffect(() => {
    setLinkPage(1);
  }, [linkQuery]);

  if (!token || (!overview && !error)) {
    return (
      <main className="admin-login-shell">
        <form className="admin-login-panel" onSubmit={login}>
          <strong>后台管理</strong>
          <span>请输入管理员账号信息。</span>
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
  const normalizedLinkQuery = linkQuery.trim().toLowerCase();
  const filteredInviteLinks = overview?.inviteLinks.filter((link) => {
    if (!normalizedLinkQuery) return true;
    const url = inviteUrl(link.code);
    return `${link.title}${link.owner_name}${link.code}${url}${link.status}`.toLowerCase().includes(normalizedLinkQuery);
  }) ?? [];
  const pageSize = 10;
  const linkPageSize = 10;
  const totalLinkPages = Math.max(1, Math.ceil(filteredInviteLinks.length / linkPageSize));
  const safeLinkPage = Math.min(linkPage, totalLinkPages);
  const pagedInviteLinks = filteredInviteLinks.slice((safeLinkPage - 1) * linkPageSize, safeLinkPage * linkPageSize);
  const totalCustomerPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const safeCustomerPage = Math.min(customerPage, totalCustomerPages);
  const pagedUsers = filteredUsers.slice((safeCustomerPage - 1) * pageSize, safeCustomerPage * pageSize);
  const selectablePagedUsers = pagedUsers.filter((user) => user.sequence_number !== 1);
  const allPagedUsersSelected = selectablePagedUsers.length > 0 && selectablePagedUsers.every((user) => selectedCustomerIds.includes(user.id));

  function toggleCustomerSelection(userId: number) {
    setSelectedCustomerIds((ids) => (ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId]));
  }

  function togglePagedCustomerSelection() {
    if (allPagedUsersSelected) {
      setSelectedCustomerIds((ids) => ids.filter((id) => !selectablePagedUsers.some((user) => user.id === id)));
      return;
    }
    setSelectedCustomerIds((ids) => Array.from(new Set([...ids, ...selectablePagedUsers.map((user) => user.id)])));
  }

  return (
    <main className="admin-shell">
      <aside className="admin-side">
        <div className="admin-brand">
          <MessageCircle size={24} />
          <strong>抖抖IM后台</strong>
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
              <span>添加客服账号后，客服可直接用账号和密码登录聊天端。</span>
            </div>
          </header>
          <form className="admin-form-grid service-form" onSubmit={createStaff}>
            <input value={staffForm.displayName} onChange={(event) => setStaffForm((form) => ({ ...form, displayName: event.target.value }))} placeholder="客服名称" />
            <input value={staffForm.username} onChange={(event) => setStaffForm((form) => ({ ...form, username: event.target.value }))} placeholder="登录账号" />
            <input type="password" value={staffForm.password} onChange={(event) => setStaffForm((form) => ({ ...form, password: event.target.value }))} placeholder="初始密码" autoComplete="new-password" />
            <button className="admin-primary" type="submit">添加客服</button>
          </form>
          <input
            ref={staffAvatarInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const targetId = staffAvatarTargetRef.current;
              const staffItem = serviceAccounts.find((item) => item.id === targetId);
              const file = event.target.files?.[0] ?? null;
              if (staffItem && file) void uploadStaffAvatar(staffItem, file);
            }}
          />
          <div className="admin-table staff-table simple-staff-table">
            <div className="admin-table-head"><span>头像</span><span>客服名称</span><span>账号</span><span>聊天显示</span><span>留存弹框</span><span>状态</span><span>操作</span></div>
            {serviceAccounts.map((item) => (
              <div className="admin-table-row" key={item.id}>
                <button
                  className={`avatar tiny avatar-button admin-avatar-picker ${avatarRoleClass(`staff:${item.username}`)}`}
                  type="button"
                  style={avatarStyle(item.avatar_url)}
                  onClick={() => {
                    staffAvatarTargetRef.current = item.id;
                    staffAvatarInputRef.current?.click();
                  }}
                  aria-label={`设置${item.display_name}头像`}
                >
                  {avatarLabel(item.display_name)}
                </button>
                <strong>{item.display_name}</strong>
                <span>{item.username}</span>
                <span>{item.display_name}</span>
                <div className="retention-config">
                  <label className="admin-switch">
                    <input
                      type="checkbox"
                      checked={staffRetentionDrafts[item.id]?.enabled ?? Boolean(item.retention_popup_enabled)}
                      onChange={(event) =>
                        setStaffRetentionDrafts((drafts) => ({
                          ...drafts,
                          [item.id]: {
                            enabled: event.target.checked,
                            text: drafts[item.id]?.text ?? item.retention_popup_text,
                          },
                        }))
                      }
                    />
                    启用
                  </label>
                  <textarea
                    value={staffRetentionDrafts[item.id]?.text ?? item.retention_popup_text}
                    onChange={(event) =>
                      setStaffRetentionDrafts((drafts) => ({
                        ...drafts,
                        [item.id]: {
                          enabled: drafts[item.id]?.enabled ?? Boolean(item.retention_popup_enabled),
                          text: event.target.value,
                        },
                      }))
                    }
                    placeholder="跟着客服操作完，至少可得1.5元。"
                    maxLength={120}
                  />
                  <button type="button" onClick={() => void saveStaffRetentionPopup(item)}>保存弹框</button>
                </div>
                <span className={item.status === "active" ? "status-active" : "status-disabled"}>{item.status === "active" ? "启用" : "禁用"}</span>
                <div className="row-actions staff-row-actions">
                  <button onClick={() => {
                    staffAvatarTargetRef.current = item.id;
                    staffAvatarInputRef.current?.click();
                  }}>头像</button>
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
          <form className="admin-form-grid link-form" onSubmit={saveLink}>
            <input value={linkForm.title} onChange={(event) => setLinkForm((form) => ({ ...form, title: event.target.value }))} placeholder="链接名称，如 抖音评论" />
            <select value={linkForm.ownerStaffId} onChange={(event) => setLinkForm((form) => ({ ...form, ownerStaffId: event.target.value }))}>
              <option value="">选择客服</option>
              {activeServiceAccounts.map((service) => (
                <option key={service.id} value={service.id}>{service.display_name}</option>
              ))}
            </select>
            <label className="admin-switch"><input type="checkbox" checked={linkForm.autoReplyEnabled} onChange={(event) => setLinkForm((form) => ({ ...form, autoReplyEnabled: event.target.checked }))} />启用回复</label>
            <textarea value={linkForm.autoReplyText} onChange={(event) => setLinkForm((form) => ({ ...form, autoReplyText: event.target.value }))} />
            <button className="admin-primary" type="submit">{editingLinkId ? "保存修改" : "添加链接"}</button>
            {editingLinkId ? <button className="admin-secondary" type="button" onClick={cancelEditLink}>取消</button> : null}
          </form>
          <div className="admin-link-search">
            <Search size={16} />
            <input value={linkQuery} onChange={(event) => setLinkQuery(event.target.value)} placeholder="搜索链接名称、客服、邀请码" />
            {linkQuery ? (
              <button type="button" onClick={() => setLinkQuery("")} aria-label="清空链接搜索">
                <X size={15} />
              </button>
            ) : null}
          </div>
          <div className="link-card-grid">
            {pagedInviteLinks.map((link) => (
              <article className="link-card" key={link.id}>
                <QrCodeImage value={inviteUrl(link.code)} />
                <div className="link-card-main">
                  <header><strong>{link.title}</strong><span className={link.status === "active" ? "status-active" : "status-disabled"}>{link.status === "active" ? "启用" : "停用"}</span></header>
                  <p>客服：{link.owner_name}</p>
                  <p>访问 {link.visits} · 今日访问 {link.today_visits} · 客户 {link.customers}</p>
                  <div className="admin-link-url-row">
                    <div className="admin-url">{inviteUrl(link.code)}</div>
                    <button type="button" onClick={() => void copyInviteLink(link.code)}>复制</button>
                  </div>
                  <div className="row-actions">
                    <button onClick={() => startEditLink(link)}>修改</button>
                    <button onClick={() => void toggleLinkStatus(link)}>{link.status === "active" ? "停用" : "启用"}</button>
                    <button className="danger-action" onClick={() => void deleteLink(link)}>删除</button>
                  </div>
                </div>
              </article>
            ))}
            {filteredInviteLinks.length === 0 ? (
              <div className="admin-empty-row">{linkQuery ? "没有找到链接" : "暂无链接"}</div>
            ) : null}
          </div>
          {filteredInviteLinks.length > 0 ? (
            <div className="pagination-bar">
              <span>共 {filteredInviteLinks.length} 条链接 · 第 {safeLinkPage} / {totalLinkPages} 页</span>
              <button onClick={() => setLinkPage((page) => Math.max(1, page - 1))} disabled={safeLinkPage <= 1}>上一页</button>
              <button onClick={() => setLinkPage((page) => Math.min(totalLinkPages, page + 1))} disabled={safeLinkPage >= totalLinkPages}>下一页</button>
            </div>
          ) : null}
        </section>
        ) : null}

        {activeAdminPage === "reply" ? (
        <section className="admin-section">
          <header>
            <div>
              <strong>全局自动回复</strong>
              <span>配置通用自动回复内容。</span>
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
              <span>查看客户昵称、手机号、状态和最近在线。</span>
            </div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索昵称 / 手机号 / 状态" />
          </header>
          {selectedCustomerIds.length > 0 ? (
            <div className="bulk-action-bar">
              <span>已选 {selectedCustomerIds.length} 位客户</span>
              <button onClick={() => void batchUpdateUsers("disabled")}>批量禁用</button>
              <button onClick={() => void batchUpdateUsers("active")}>批量启用</button>
              <button className="danger-action" onClick={() => void batchDeleteSelectedUsers()}>批量删除</button>
              <button onClick={() => setSelectedCustomerIds([])}>取消选择</button>
            </div>
          ) : null}
          <div className="admin-table customer-table">
            <div className="admin-table-head">
              <label className="admin-check-cell">
                <input type="checkbox" checked={allPagedUsersSelected} onChange={togglePagedCustomerSelection} disabled={selectablePagedUsers.length === 0} />
              </label>
              <span>昵称</span><span>手机号</span><span>状态</span><span>最近在线</span><span>操作</span>
            </div>
            {pagedUsers.map((user) => (
              <div className="admin-table-row" key={user.id}>
                <label className="admin-check-cell">
                  <input
                    type="checkbox"
                    checked={selectedCustomerIds.includes(user.id)}
                    onChange={() => toggleCustomerSelection(user.id)}
                    disabled={user.sequence_number === 1}
                  />
                </label>
                <strong>{user.nickname}</strong>
                <span>{user.phone}</span>
                <span className={user.status === "active" ? "status-active" : "status-disabled"}>{user.status === "active" ? "启用" : "禁用"}</span>
                <span>{formatDateTime(user.last_seen_at)}</span>
                <div className="row-actions">
                  <button onClick={() => void toggleUserStatus(user)} disabled={user.sequence_number === 1}>{user.sequence_number === 1 ? "保留" : user.status === "active" ? "禁用" : "启用"}</button>
                </div>
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
  const [pendingConversationId, setPendingConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  const [query, setQuery] = useState("");
  const [selectedMessageIds, setSelectedMessageIds] = useState<number[]>([]);
  const [forwardMode, setForwardMode] = useState<ForwardMode | null>(null);
  const [forwardTargetIds, setForwardTargetIds] = useState<number[]>([]);
  const [forwardSending, setForwardSending] = useState(false);
  const [viewingBundle, setViewingBundle] = useState<BundleBody | null>(null);
  const [viewingMedia, setViewingMedia] = useState<MediaBody | null>(null);
  const [retentionPopup, setRetentionPopup] = useState<RetentionPopup | null>(null);
  const [retentionNotice, setRetentionNotice] = useState<RetentionPopup | null>(null);
  const [mediaViewerUrl, setMediaViewerUrl] = useState("");
  const [mediaViewerError, setMediaViewerError] = useState("");
  const [mediaViewerLoading, setMediaViewerLoading] = useState(false);
  const [mediaViewerClosing, setMediaViewerClosing] = useState(false);
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
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [uploading, setUploading] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [returnBottomVisible, setReturnBottomVisible] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const [quickPanelCollapsed, setQuickPanelCollapsed] = useState(false);
  const [quickForm, setQuickForm] = useState({ id: 0, content: "" });
  const [draggingQuickId, setDraggingQuickId] = useState<number | null>(null);
  const [editingRemark, setEditingRemark] = useState<{ conversationId: number; value: string } | null>(null);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [contactsSelectionMode, setContactsSelectionMode] = useState(false);
  const [contactsConfirmDelete, setContactsConfirmDelete] = useState(false);
  const [contactsCleanupScope, setContactsCleanupScope] = useState<"3d" | "7d" | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const mediaViewerVideoRef = useRef<HTMLVideoElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const contactLongPressTimerRef = useRef<number | null>(null);
  const conversationPressTimerRef = useRef<number | null>(null);
  const conversationTouchStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeConversationIdRef = useRef<number | null>(null);
  const messageLoadSeqRef = useRef(0);
  const currentUserRef = useRef<User | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const autoOpenedCustomerConversationRef = useRef(false);
  const draftRef = useRef("");
  const sendingRef = useRef(false);
  const sessionBlockedRef = useRef(false);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendButtonCleanupRef = useRef<(() => void) | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const lastNotifiedMessageIdRef = useRef<number | null>(null);
  const hasMoreMessagesRef = useRef(false);
  const olderMessagesLoadingRef = useRef(false);
  const skipNextMessageAutoScrollRef = useRef(false);
  const mediaViewerScrollTopRef = useRef(0);
  const mediaViewerHeightLockedRef = useRef(false);
  const mediaViewerRecoverTimerRef = useRef<number | null>(null);
  const mediaViewerCloseTimerRef = useRef<number | null>(null);
  const mediaViewerObjectUrlRef = useRef("");
  const mediaViewerVideoCleanupRef = useRef<(() => void) | null>(null);
  const conversationRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setInstallPromptEvent(null);
      setNotice("已添加到主屏幕");
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    const updateAppHeight = () => {
      if (mediaViewerHeightLockedRef.current) return;
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const keyboardOffset = Math.max(0, Math.round(window.innerHeight - height - (viewport?.offsetTop ?? 0)));
      const isTouchDevice = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
      const isMobileLayout = isTouchDevice && width <= 920;
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
      document.documentElement.style.setProperty("--keyboard-offset", `${keyboardOffset}px`);
      document.documentElement.classList.toggle("force-mobile-layout", isMobileLayout);
      document.documentElement.classList.toggle("keyboard-open", isMobileLayout && keyboardOffset > 80);
    };
    updateAppHeight();
    window.addEventListener("resize", updateAppHeight);
    window.visualViewport?.addEventListener("resize", updateAppHeight);
    window.visualViewport?.addEventListener("scroll", updateAppHeight);
    return () => {
      window.removeEventListener("resize", updateAppHeight);
      window.visualViewport?.removeEventListener("resize", updateAppHeight);
      window.visualViewport?.removeEventListener("scroll", updateAppHeight);
      document.documentElement.classList.remove("keyboard-open");
    };
  }, []);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    window.scrollTo(0, 0);
  }, [activeConversationId]);

  useEffect(() => {
    currentUserRef.current = currentUser;
    autoOpenedCustomerConversationRef.current = false;
  }, [currentUser]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    hasMoreMessagesRef.current = hasMoreMessages;
  }, [hasMoreMessages]);

  useEffect(() => {
    olderMessagesLoadingRef.current = olderMessagesLoading;
  }, [olderMessagesLoading]);

  useEffect(() => {
    const unreadTotal = conversations.reduce((sum, conversation) => sum + conversation.unread_count, 0);
    if (unreadTotal <= 0) {
      document.title = "抖抖IM";
      return () => {
        document.title = "抖抖IM";
      };
    }
    let visible = true;
    document.title = `【您有${unreadTotal}条新消息】`;
    const timer = window.setInterval(() => {
      visible = !visible;
      document.title = visible ? `【您有${unreadTotal}条新消息】` : "抖抖IM";
    }, 900);
    return () => {
      window.clearInterval(timer);
      document.title = "抖抖IM";
    };
  }, [conversations]);

  async function goAddToHomeScreen() {
    if (installPromptEvent) {
      try {
        await installPromptEvent.prompt();
        const choice = await installPromptEvent.userChoice;
        setInstallPromptEvent(null);
        if (choice.outcome === "accepted") {
          setNotice("已添加到主屏幕");
          return;
        }
        setNotice("可以先继续聊天，稍后再保存链接");
        return;
      } catch {
        setNotice("当前浏览器不支持一键添加，请复制链接保存");
        return;
      }
    }
    setNotice("当前浏览器不支持一键添加，请复制链接保存");
  }

  function customerChatLink() {
    const inviteCode = currentInviteCode();
    const url = new URL(window.location.href);
    if (inviteCode) url.searchParams.set("invite", inviteCode);
    return url.toString();
  }

  async function copyCustomerChatLink() {
    try {
      await writeClipboardText(customerChatLink());
      setNotice("专属聊天链接已复制");
    } catch (error) {
      setNotice(normalizeUserError(error, "复制失败，请长按地址栏复制链接"));
    }
  }

  function notifyIncomingMessage(message: ChatMessage) {
    const user = currentUserRef.current;
    if (!user || message.sender_id === user.id) return;
    if (lastNotifiedMessageIdRef.current === message.id) return;
    lastNotifiedMessageIdRef.current = message.id;

    const sender = message.sender_nickname || "新消息";
    const body = message.type === "text" ? displayTextBody(message.body) : displayTextBody(message.body);
    setNotice(`${sender} 发来新消息`);
    navigator.vibrate?.([80, 40, 80]);

  }

  useEffect(() => {
    if (!pendingConversationId || !currentUser) return;
    const nextConversationId = pendingConversationId;
    setPendingConversationId(null);
    openConversation(nextConversationId);
    setMode("chats");
  }, [pendingConversationId, currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    const conversationId = Number(new URLSearchParams(window.location.search).get("conversation"));
    if (!Number.isInteger(conversationId) || conversationId <= 0) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setPendingConversationId(conversationId);
  }, [currentUser]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );

  function openConversation(conversationId: number) {
    setActionMenu(null);
    setConversationMenu(null);
    setSelectedMessageIds([]);
    setForwardMode(null);
    setForwardTargetIds([]);
    setToolPanelOpen(false);
    setEditingRemark(null);
    setReturnBottomVisible(false);
    setHasMoreMessages(false);
    setActiveConversationId(conversationId);
    setMessages([]);
    setMessagesLoading(true);
    void loadMessages(conversationId, { showSwitching: true }).catch(handleSessionError);
  }

  function openUnreadConversation() {
    setMode("chats");
    const unreadConversation = conversations.find((conversation) => conversation.unread_count > 0);
    if (!unreadConversation) return;
    if (unreadConversation.id === activeConversationId) {
      scrollToBottom("smooth");
      return;
    }
    openConversation(unreadConversation.id);
  }

  function upsertMessage(message: ChatMessage) {
    setMessages((current) => {
      const existingIndex = current.findIndex(
        (item) => item.id === message.id || (message.client_id && item.client_id === message.client_id),
      );
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = message;
        return next;
      }
      return [...current, message];
    });
    window.setTimeout(() => scrollToBottom("smooth"), 0);
  }

  function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
    const byId = new Map<number, ChatMessage>();
    for (const message of [...current, ...incoming]) {
      byId.set(message.id, message);
    }
    return [...byId.values()].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id,
    );
  }

  function updateConversationWithMessage(message: ChatMessage, options: { read: boolean; incrementUnread: boolean }) {
    const found = conversationsRef.current.some((conversation) => conversation.id === message.conversation_id);
    if (!found) return false;
    setConversations((current) => {
      const next = current.map((conversation) => {
        if (conversation.id !== message.conversation_id) return conversation;
        return {
          ...conversation,
          unread_count: options.read ? 0 : conversation.unread_count + (options.incrementUnread ? 1 : 0),
          last_message_body: message.revoked_at ? "[撤回了一条消息]" : message.body,
          last_message_at: message.created_at,
        };
      });
      return next.sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
        return new Date(b.last_message_at ?? 0).getTime() - new Date(a.last_message_at ?? 0).getTime();
      });
    });
    return true;
  }

  async function markActiveConversationRead(conversationId: number) {
    const user = currentUserRef.current;
    if (!user) return;
    await api<{ ok: true }>(`/api/conversations/${conversationId}/read`, {
      method: "PATCH",
      body: JSON.stringify({ userId: user.id }),
    });
  }

  function forceLogout(message: string) {
    if (sessionBlockedRef.current) return;
    sessionBlockedRef.current = true;
    window.alert(message);
    logout();
  }

  function handleSessionError(error: unknown) {
    const message = normalizeUserError(error, "账号不可用");
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
    nextSocket.on("connect", () => {
      nextSocket.emit("user:online", currentUser.id);
      scheduleConversationListRefresh(0);
      if (activeConversationIdRef.current) {
        void refreshActiveConversation();
      }
    });
    nextSocket.on("message:new", (message: ChatMessage) => {
      const isCurrentConversation = message.conversation_id === activeConversationIdRef.current;
      if (!isCurrentConversation) {
        notifyIncomingMessage(message);
      }
      if (isCurrentConversation) {
        upsertMessage(message);
        updateConversationWithMessage(message, { read: true, incrementUnread: false });
        void markActiveConversationRead(message.conversation_id)
          .catch(handleSessionError);
      } else {
        const updated = updateConversationWithMessage(message, {
          read: false,
          incrementUnread: message.sender_id !== currentUser.id,
        });
        if (!updated) {
          scheduleConversationListRefresh();
        } else if (message.sender_id !== currentUser.id) {
          scheduleConversationListRefresh(800);
        }
      }
    });
    nextSocket.on("message:changed", (message: ChatMessage) => {
      if (message.conversation_id === activeConversationIdRef.current) {
        void refreshActiveConversation();
      }
      const updated = updateConversationWithMessage(message, {
        read: message.conversation_id === activeConversationIdRef.current,
        incrementUnread: false,
      });
      if (!updated) scheduleConversationListRefresh();
    });
    nextSocket.on("conversation:changed", ({ conversationId }: { conversationId: number }) => {
      scheduleConversationListRefresh(conversationId === activeConversationIdRef.current ? 600 : 350);
    });
    nextSocket.on("presence:changed", ({ userId, lastSeenAt }: { userId: number; online?: boolean; lastSeenAt?: string }) => {
      const nextLastSeenAt = lastSeenAt ?? new Date().toISOString();
      setUsers((current) => current.map((user) => (user.id === userId ? { ...user, last_seen_at: nextLastSeenAt } : user)));
      setConversations((current) =>
        current.map((conversation) =>
          conversation.peer_id === userId ? { ...conversation, peer_last_seen_at: nextLastSeenAt } : conversation,
        ),
      );
    });
    setSocket(nextSocket);
    void Promise.all([
      syncInviteAssignment(currentUser),
      loadUsers(currentUser.id),
      loadQuickReplies(currentUser),
      loadRetentionNotice(currentUser.id),
    ])
      .then(() => loadConversationList())
      .catch(handleSessionError);
    return () => {
      nextSocket.disconnect();
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    const syncAfterResume = () => {
      if (document.visibilityState === "hidden") return;
      scheduleConversationListRefresh(0);
      if (activeConversationIdRef.current) {
        void refreshActiveConversation();
      }
      socket?.emit("user:online", currentUser.id);
    };

    window.addEventListener("focus", syncAfterResume);
    window.addEventListener("online", syncAfterResume);
    document.addEventListener("visibilitychange", syncAfterResume);
    return () => {
      window.removeEventListener("focus", syncAfterResume);
      window.removeEventListener("online", syncAfterResume);
      document.removeEventListener("visibilitychange", syncAfterResume);
    };
  }, [currentUser, socket]);

  useEffect(() => {
    if (!socket || !activeConversationId) return;
    socket.emit("conversation:join", activeConversationId);
    return () => {
      socket.emit("conversation:leave", activeConversationId);
    };
  }, [socket, activeConversationId]);

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    setReturnBottomVisible(false);
    window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list) {
        list.scrollTo({ top: list.scrollHeight, behavior });
        return;
      }
      bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    });
  }

  function scrollToBottomIfNearBottom() {
    const list = messageListRef.current;
    if (!list) {
      scrollToBottom("auto");
      return;
    }
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceToBottom < 240) {
      scrollToBottom("auto");
    }
  }

  function scrollToMessageElement(messageId: number) {
    const target = messageListRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!target) return false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setReturnBottomVisible(true);
    setHighlightedMessageId(messageId);
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightedMessageId(null), 1800);
    return true;
  }

  function findLoadedQuotedMessage(quote: QuoteTarget) {
    const sameSenderMessages = messagesRef.current.filter((message) => message.sender_nickname === quote.sender && !message.revoked_at);
    return (
      sameSenderMessages.find((message) => quotePreviewForMessage(message) === quote.preview) ??
      sameSenderMessages.find((message) => quotePreviewForMessage(message).includes(quote.preview) || quote.preview.includes(quotePreviewForMessage(message))) ??
      null
    );
  }

  async function loadQuotedMessage(messageId: number) {
    const conversationId = activeConversationIdRef.current;
    const user = currentUserRef.current;
    if (!conversationId || !user) return null;
    try {
      const result = await api<{ message: ChatMessage }>(
        `/api/conversations/${conversationId}/messages/${messageId}?userId=${user.id}`,
      );
      setMessages((current) => mergeMessages(current, [result.message]));
      messagesRef.current = mergeMessages(messagesRef.current, [result.message]);
      return result.message;
    } catch {
      return null;
    }
  }

  async function jumpToMessage(messageId: number, quote?: QuoteTarget) {
    if (scrollToMessageElement(messageId)) return;

    if (quote) {
      const loadedMatch = findLoadedQuotedMessage(quote);
      if (loadedMatch && scrollToMessageElement(loadedMatch.id)) return;
    }

    const fetchedMessage = await loadQuotedMessage(messageId);
    if (fetchedMessage) {
      window.setTimeout(() => {
        if (!scrollToMessageElement(fetchedMessage.id) && quote) {
          const loadedMatch = findLoadedQuotedMessage(quote);
          if (loadedMatch) scrollToMessageElement(loadedMatch.id);
        }
      }, 0);
      return;
    }

    const target = messageListRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!target) {
      const loaded = await loadOlderMessagesUntil(messageId);
      if (loaded) {
        window.setTimeout(() => {
          void jumpToMessage(messageId, quote);
        }, 0);
        return;
      }
      if (quote) {
        const loadedMatch = findLoadedQuotedMessage(quote);
        if (loadedMatch && scrollToMessageElement(loadedMatch.id)) return;
      }
      setNotice("引用的消息较早，暂时定位不到");
      return;
    }
    scrollToMessageElement(messageId);
  }

  function handleMessageListScroll() {
    const list = messageListRef.current;
    if (!list) return;
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const shouldShowReturnButton = !messagesLoading && distanceToBottom > 160;
    setReturnBottomVisible((visible) => (visible === shouldShowReturnButton ? visible : shouldShowReturnButton));
    if (list.scrollTop < 80 && hasMoreMessagesRef.current && !olderMessagesLoadingRef.current && activeConversationIdRef.current) {
      void loadOlderMessages();
    }
  }

  async function loadOlderMessages() {
    const conversationId = activeConversationIdRef.current;
    const oldestMessageId = messagesRef.current[0]?.id;
    if (!conversationId || !oldestMessageId || olderMessagesLoadingRef.current || !hasMoreMessagesRef.current) return [];
    return loadMessages(conversationId, { beforeMessageId: oldestMessageId, prepend: true });
  }

  async function loadOlderMessagesUntil(messageId: number) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (messagesRef.current.some((message) => message.id === messageId)) return true;
      if (!hasMoreMessagesRef.current || olderMessagesLoadingRef.current) return false;
      const loadedMessages = await loadOlderMessages();
      if (loadedMessages.length === 0) return false;
      if (loadedMessages.some((message) => message.id === messageId)) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return messagesRef.current.some((message) => message.id === messageId);
  }

  useEffect(() => {
    if (skipNextMessageAutoScrollRef.current) {
      skipNextMessageAutoScrollRef.current = false;
      return;
    }
    if (olderMessagesLoadingRef.current) return;
    const list = messageListRef.current;
    const distanceToBottom = list ? list.scrollHeight - list.scrollTop - list.clientHeight : 0;
    if (distanceToBottom > 220) return;
    scrollToBottom(messages.length > 2 ? "auto" : "smooth");
    const timer = window.setTimeout(() => scrollToBottom("auto"), 160);
    return () => window.clearTimeout(timer);
  }, [messages, activeConversationId]);

  useEffect(() => {
    return () => {
      stopCamera();
      stopViewerVideo();
      mediaViewerVideoCleanupRef.current?.();
      if (capturedMedia) URL.revokeObjectURL(capturedMedia.url);
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
      if (mediaViewerRecoverTimerRef.current) window.clearTimeout(mediaViewerRecoverTimerRef.current);
      if (mediaViewerCloseTimerRef.current) window.clearTimeout(mediaViewerCloseTimerRef.current);
      if (conversationRefreshTimerRef.current) window.clearTimeout(conversationRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!viewingMedia?.mimeType.startsWith("video/")) return;
    setMediaViewerViewportVars();
    const stopWhenHidden = () => {
      if (document.hidden) stopViewerVideo();
    };
    const closeOnFullscreenExit = () => {
      const video = mediaViewerVideoRef.current as WebKitVideoElement | null;
      if (!document.fullscreenElement && !video?.webkitDisplayingFullscreen) {
        closeMediaViewer();
      }
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    document.addEventListener("fullscreenchange", closeOnFullscreenExit);
    window.addEventListener("resize", setMediaViewerViewportVars);
    window.visualViewport?.addEventListener("resize", setMediaViewerViewportVars);
    window.visualViewport?.addEventListener("scroll", setMediaViewerViewportVars);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      document.removeEventListener("fullscreenchange", closeOnFullscreenExit);
      window.removeEventListener("resize", setMediaViewerViewportVars);
      window.visualViewport?.removeEventListener("resize", setMediaViewerViewportVars);
      window.visualViewport?.removeEventListener("scroll", setMediaViewerViewportVars);
    };
  }, [viewingMedia]);

  useEffect(() => {
    if (!viewingMedia?.mimeType.startsWith("video/") || !mediaViewerLoading || mediaViewerError) return;
    const timer = window.setTimeout(() => {
      setMediaViewerLoading(false);
      setMediaViewerError("视频加载较慢，可先保存到手机相册查看");
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [viewingMedia, mediaViewerLoading, mediaViewerError]);

  async function loadUsers(userId: number) {
    const result = await api<{ users: User[] }>(`/api/users?userId=${userId}`);
    setUsers(result.users);
  }

  async function loadRetentionNotice(userId: number) {
    const result = await api<{ retentionNotice: RetentionPopup | null }>(`/api/users/${userId}/retention-notice`);
    setRetentionNotice(result.retentionNotice);
  }

  async function syncInviteAssignment(user: User) {
    if (user.phone.startsWith("staff:")) return null;
    const inviteCode = currentInviteCode();
    if (!inviteCode) return null;
    try {
      const result = await api<{ openConversationId: number | null; retentionNotice: RetentionPopup | null }>(
        `/api/users/${user.id}/invite-assignment`,
        {
          method: "POST",
          body: JSON.stringify({ inviteCode }),
        },
      );
      setRetentionNotice(result.retentionNotice);
      if (result.openConversationId) {
        autoOpenedCustomerConversationRef.current = true;
        setPendingConversationId(result.openConversationId);
      }
      return result.openConversationId;
    } catch (error) {
      setNotice(normalizeUserError(error, "未匹配到专属客服，请重新扫码进入"));
      return null;
    }
  }

  async function loadConversations(userId: number) {
    const result = await api<{ conversations: Conversation[] }>(`/api/conversations?userId=${userId}`);
    setConversations(result.conversations);
    const user = currentUserRef.current;
    if (
      user &&
      user.id === userId &&
      !user.phone.startsWith("staff:") &&
      !activeConversationIdRef.current &&
      !autoOpenedCustomerConversationRef.current
    ) {
      const serviceConversation = result.conversations.find((conversation) => conversation.peer_id && conversation.peer_id !== user.id);
      if (serviceConversation) {
        autoOpenedCustomerConversationRef.current = true;
        setMode("chats");
        openConversation(serviceConversation.id);
      }
    }
  }

  async function loadConversationList() {
    const user = currentUserRef.current;
    if (!user) return;
    await loadConversations(user.id);
  }

  async function loadActiveConversation() {
    const conversationId = activeConversationIdRef.current;
    const user = currentUserRef.current;
    if (!conversationId || !user) return;
    await loadMessages(conversationId, { showSwitching: false });
  }

  function refreshConversationList() {
    return loadConversationList().catch(handleSessionError);
  }

  function scheduleConversationListRefresh(delay = 350) {
    if (conversationRefreshTimerRef.current) return;
    conversationRefreshTimerRef.current = window.setTimeout(() => {
      conversationRefreshTimerRef.current = null;
      void refreshConversationList();
    }, delay);
  }

  function refreshActiveConversation() {
    return loadActiveConversation().catch(handleSessionError);
  }

  async function loadQuickReplies(user: User) {
    if (!user.phone.startsWith("staff:")) {
      setQuickReplies([]);
      return;
    }
    const result = await api<{ quickReplies: QuickReply[] }>(`/api/quick-replies?userId=${user.id}`);
    setQuickReplies(result.quickReplies);
  }

  async function openDirect(peerId: number) {
    if (!currentUser) return;
    const result = await api<{ conversationId: number }>("/api/conversations/direct", {
      method: "POST",
      body: JSON.stringify({ userId: currentUser.id, peerId }),
    });
    openConversation(result.conversationId);
    setMode("chats");
    await loadConversationList();
  }

  async function loadMessages(
    conversationId: number,
    options: { showSwitching?: boolean; beforeMessageId?: number; prepend?: boolean } = {},
  ): Promise<ChatMessage[]> {
    if (!currentUser) return [];
    const loadSeq = options.prepend ? messageLoadSeqRef.current : ++messageLoadSeqRef.current;
    if (options.showSwitching) setMessagesLoading(true);
    if (options.prepend) {
      olderMessagesLoadingRef.current = true;
      setOlderMessagesLoading(true);
    }
    const list = messageListRef.current;
    const previousScrollHeight = list?.scrollHeight ?? 0;
    const previousScrollTop = list?.scrollTop ?? 0;
    try {
      const params = new URLSearchParams({
        userId: String(currentUser.id),
        limit: String(MESSAGE_PAGE_SIZE),
      });
      if (options.beforeMessageId) params.set("beforeMessageId", String(options.beforeMessageId));
      const result = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
        `/api/conversations/${conversationId}/messages?${params.toString()}`,
      );
      if (loadSeq !== messageLoadSeqRef.current || activeConversationIdRef.current !== conversationId) {
        return [];
      }
      hasMoreMessagesRef.current = result.hasMore;
      setHasMoreMessages(result.hasMore);
      if (options.prepend) {
        skipNextMessageAutoScrollRef.current = true;
        setMessages((current) => mergeMessages(result.messages, current));
        window.requestAnimationFrame(() => {
          const nextList = messageListRef.current;
          if (!nextList) return;
          nextList.scrollTop = nextList.scrollHeight - previousScrollHeight + previousScrollTop;
        });
      } else {
        setMessages(result.messages);
        window.setTimeout(() => scrollToBottom("auto"), 0);
        window.setTimeout(() => scrollToBottom("auto"), 220);
      }
      return result.messages;
    } finally {
      if (loadSeq === messageLoadSeqRef.current) setMessagesLoading(false);
      if (options.prepend) {
        olderMessagesLoadingRef.current = false;
        setOlderMessagesLoading(false);
      }
    }
  }

  async function sendMessage(event?: React.SyntheticEvent) {
    event?.preventDefault();
    if (sendingRef.current) {
      return;
    }
    const inputValue = composerInputRef.current?.value ?? draftRef.current;
    const currentUserValue = currentUserRef.current;
    const activeConversationIdValue = activeConversationIdRef.current;
    if (!currentUserValue) {
      setNotice("未登录，不能发送");
      return;
    }
    if (!activeConversationIdValue) {
      setNotice("没有打开会话");
      return;
    }
    if (!inputValue.trim()) {
      return;
    }
    const body = inputValue.trim();
    setDraft("");
    setQuoteTarget(null);
    sendingRef.current = true;
    try {
      const result = await api<{ message: ChatMessage }>(`/api/conversations/${activeConversationIdValue}/messages`, {
        method: "POST",
        body: JSON.stringify({
          userId: currentUserValue.id,
          body: quoteTarget ? JSON.stringify({ text: body, quote: quoteTarget } satisfies QuoteBody) : body,
          clientId: makeClientId(currentUserValue.id),
        }),
      });
      upsertMessage(result.message);
      updateConversationWithMessage(result.message, { read: true, incrementUnread: false });
      scrollToBottom("smooth");
    } catch (error) {
      setNotice(`发送失败：${normalizeUserError(error, "请检查网络后重试")}`);
      setDraft(body);
      setQuoteTarget(quoteTarget);
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
    await loadConversationList();
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
      await loadConversationList();
      setNotice("已删除好友");
    } catch (error) {
      setNotice(normalizeUserError(error, "删除好友失败"));
    }
  }

  function contactCandidates() {
    const contactList = conversations
      .filter((conversation) => conversation.peer_id && conversation.peer_id !== currentUser?.id)
      .map((conversation) => ({
        conversation,
        lastSeenAt: conversation.peer_last_seen_at,
        daysSinceLastSeen: conversation.peer_last_seen_at
          ? Math.floor((Date.now() - new Date(`${conversation.peer_last_seen_at}Z`).getTime()) / (1000 * 60 * 60 * 24))
          : Number.POSITIVE_INFINITY,
      }));
    return contactList.filter(({ conversation }) => {
      if (query.trim()) {
        const keyword = query.trim().toLowerCase();
        return `${conversation.peer_nickname ?? ""}${conversation.peer_phone ?? ""}`.toLowerCase().includes(keyword);
      }
      return true;
    });
  }

  function toggleContactSelection(userId: number) {
    setSelectedContactIds((current) => (current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]));
  }

  function beginContactSelection(userId: number) {
    setContactsSelectionMode(true);
    setSelectedContactIds((current) => (current.includes(userId) ? current : [...current, userId]));
  }

  function clearContactSelection() {
    setContactsSelectionMode(false);
    setSelectedContactIds([]);
    setContactsConfirmDelete(false);
    setContactsCleanupScope(null);
  }

  async function deleteContacts(userIds: number[]) {
    if (!currentUser || userIds.length === 0) return;
    const uniqueIds = Array.from(new Set(userIds));
    try {
      const conversationIds = conversations
        .filter((conversation) => uniqueIds.includes(conversation.peer_id ?? -1))
        .map((conversation) => conversation.id);
      await api<{ ok: true; count: number }>("/api/friends", {
        method: "DELETE",
        body: JSON.stringify({ userId: currentUser.id, peerIds: uniqueIds }),
      });
      if (activeConversation && uniqueIds.includes(activeConversation.peer_id ?? -1)) {
        setActiveConversationId(null);
        setMessages([]);
      }
      if (conversationIds.includes(activeConversationId ?? -1)) {
        setActiveConversationId(null);
        setMessages([]);
      }
      setConversationMenu(null);
      setSwipedConversationId(null);
      await loadUsers(currentUser.id);
      await loadConversationList();
      clearContactSelection();
      setNotice("已删除联系人");
    } catch (error) {
      setNotice(normalizeUserError(error, "删除失败"));
    }
  }

  async function deleteContactsByScope(scope: "3d" | "7d") {
    const items = contactCandidates().filter(({ daysSinceLastSeen }) => daysSinceLastSeen >= (scope === "3d" ? 3 : 7));
    if (items.length === 0) {
      setNotice(scope === "3d" ? "没有三天未联系的联系人" : "没有七天未联系的联系人");
      return;
    }
    await deleteContacts(items.map(({ conversation }) => conversation.peer_id!).filter((id): id is number => Boolean(id)));
  }

  async function confirmContactDelete() {
    try {
      if (contactsCleanupScope) {
        await deleteContactsByScope(contactsCleanupScope);
        return;
      }
      await deleteContacts(selectedContactIds);
    } finally {
      setContactsConfirmDelete(false);
      setContactsCleanupScope(null);
    }
  }

  async function remarkConversation(conversation: Conversation, remarkName: string) {
    if (!currentUser || !currentUser.phone.startsWith("staff:") || !conversation.peer_id || conversation.peer_id === currentUser.id) return;
    try {
      await api<{ ok: true }>(`/api/conversations/${conversation.id}/remark`, {
        method: "POST",
        body: JSON.stringify({ userId: currentUser.id, remarkName }),
      });
      setConversationMenu(null);
      setEditingRemark(null);
      await loadConversationList();
      if (activeConversationId === conversation.id) await loadActiveConversation();
      setNotice("备注已更新");
    } catch (error) {
      setNotice(normalizeUserError(error, "备注失败"));
    }
  }

  function openConversationMenu(conversationId: number, x: number, y: number) {
    const menuWidth = 228;
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

  function startContactPress(userId: number, event: React.PointerEvent) {
    if (event.pointerType === "mouse") return;
    contactLongPressTimerRef.current = window.setTimeout(() => {
      beginContactSelection(userId);
    }, 520);
  }

  function cancelContactPress() {
    if (contactLongPressTimerRef.current) window.clearTimeout(contactLongPressTimerRef.current);
    contactLongPressTimerRef.current = null;
  }

  async function uploadFiles(files: FileList | null, source: "picker" | "capture" = "picker") {
    const conversationId = activeConversationIdRef.current;
    if (!currentUser || !conversationId || !files?.length || uploading) return;
    const selectedFiles = Array.from(files);
    const oversizedVideo = selectedFiles.find((file) => isVideoFile(file) && file.size > MAX_VIDEO_UPLOAD_SIZE);
    if (oversizedVideo) {
      setNotice(`视频太大（${formatFileSize(oversizedVideo.size)}），请压缩到 80MB 内再发`);
      return;
    }
    let uploaded = false;
    setUploading(true);
    const hasVideo = selectedFiles.some((file) => isVideoFile(file));
    setNotice(hasVideo ? "正在上传并处理视频..." : `正在上传 ${selectedFiles.length} 个文件...`);
    try {
      for (const file of selectedFiles) {
        const uploadFile = isImageFile(file) ? await compressImageForUpload(file) : file;
        const formData = new FormData();
        formData.append("userId", String(currentUser.id));
        if (isVideoFile(uploadFile)) {
          setNotice("正在生成视频封面...");
          const poster = await captureVideoPoster(uploadFile);
          if (poster) formData.append("poster", poster);
          setNotice("正在上传并处理视频...");
        }
        formData.append("file", uploadFile);
        const response = await fetch(`${API_URL}/api/conversations/${conversationId}/uploads`, {
          method: "POST",
          body: formData,
        });
        const text = await response.text();
        let data: { message?: ChatMessage; error?: unknown } = {};
        try {
          data = text ? (JSON.parse(text) as { message?: ChatMessage; error?: unknown }) : {};
        } catch {
          if (!response.ok) throw new Error("上传失败");
          throw new Error("上传完成后数据读取失败，请刷新后查看");
        }
        if (!response.ok) throw new Error(normalizeUserError(data.error, "上传失败"));
        if (data.message) upsertMessage(data.message);
        uploaded = true;
      }
      if (uploaded) {
        setNotice("已发送");
        scrollToBottom("smooth");
      }
      if (uploaded && source === "capture") closeCamera();
    } catch (error) {
      setNotice(userUploadErrorMessage(error));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (captureInputRef.current) captureInputRef.current.value = "";
    }
  }

  async function uploadDroppedFiles(files: File[]) {
    const transfer = new DataTransfer();
    files
      .filter((file) => file.type.startsWith("image/") || isVideoFile(file))
      .forEach((file) => transfer.items.add(file));
    if (transfer.files.length === 0) {
      setNotice("只能发送图片或视频");
      return;
    }
    await uploadFiles(transfer.files, "picker");
  }

  async function uploadBlob(blob: Blob, fileName: string) {
    const conversationId = activeConversationIdRef.current;
    if (!currentUser || !conversationId || uploading) return;
    const isVideoBlob = blob.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(fileName);
    if (isVideoBlob && blob.size > MAX_VIDEO_UPLOAD_SIZE) {
      setNotice(`视频太大（${formatFileSize(blob.size)}），请压缩到 80MB 内再发`);
      return;
    }
    setUploading(true);
    setNotice(isVideoBlob ? "正在上传并处理视频..." : "正在上传文件...");
    try {
      const formData = new FormData();
      formData.append("userId", String(currentUser.id));
      if (isVideoBlob) {
        setNotice("正在生成视频封面...");
        const poster = await captureVideoPoster(blob);
        if (poster) formData.append("poster", poster);
        setNotice("正在上传并处理视频...");
      }
      formData.append("file", new File([blob], fileName, { type: blob.type }));
      const response = await fetch(`${API_URL}/api/conversations/${conversationId}/uploads`, {
        method: "POST",
        body: formData,
      });
      const text = await response.text();
      let data: { message?: ChatMessage; error?: unknown } = {};
      try {
        data = text ? (JSON.parse(text) as { message?: ChatMessage; error?: unknown }) : {};
      } catch {
        if (!response.ok) throw new Error("上传失败");
        throw new Error("上传完成后数据读取失败，请刷新后查看");
      }
      if (!response.ok) throw new Error(normalizeUserError(data.error, "上传失败"));
      if (data.message) upsertMessage(data.message);
      closeCamera();
    } catch (error) {
      setNotice(userUploadErrorMessage(error));
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
      setCameraError(normalizeUserError(error, "无法打开摄像头，请允许浏览器摄像头权限"));
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
    window.setTimeout(() => {
      window.scrollTo(0, 0);
      scrollToBottom("auto");
    }, 80);
  }

  function blurComposer() {
    window.setTimeout(() => {
      if (document.activeElement === composerInputRef.current) return;
      document.documentElement.classList.remove("keyboard-open");
      window.scrollTo(0, 0);
    }, 120);
  }

  function toggleToolPanel() {
    setSelectedMessageIds([]);
    setActionMenu(null);
    setQuickPanelOpen(false);
    composerInputRef.current?.blur();
    setToolPanelOpen((open) => !open);
  }

  function toggleQuickPanel() {
    setSelectedMessageIds([]);
    setActionMenu(null);
    setToolPanelOpen(false);
    composerInputRef.current?.blur();
    setQuickPanelCollapsed(false);
    setQuickPanelOpen((open) => !open);
  }

  function insertQuickReply(reply: QuickReply) {
    setDraft(reply.content);
    draftRef.current = reply.content;
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }

  async function sendQuickReply(reply: QuickReply) {
    if (!currentUser || !activeConversationId) return;
    const body = reply.content.trim();
    if (!body) return;
    try {
      const result = await api<{ message: ChatMessage }>(`/api/conversations/${activeConversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          userId: currentUser.id,
          body,
          clientId: makeClientId(currentUser.id),
        }),
      });
      upsertMessage(result.message);
      updateConversationWithMessage(result.message, { read: true, incrementUnread: false });
      scrollToBottom("smooth");
      setNotice("已发送");
    } catch (error) {
      setNotice(`发送失败：${normalizeUserError(error, "请检查网络后重试")}`);
    }
  }

  async function saveQuickReply() {
    if (!currentUser || !currentUser.phone.startsWith("staff:")) return;
    const content = quickForm.content.trim();
    if (!content) {
      setNotice("快捷语内容不能为空");
      return;
    }
    const title = content.slice(0, 40);
    try {
      const path = quickForm.id ? `/api/quick-replies/${quickForm.id}` : "/api/quick-replies";
      await api<{ quickReply: QuickReply }>(path, {
        method: quickForm.id ? "PATCH" : "POST",
        body: JSON.stringify({ userId: currentUser.id, title, content }),
      });
      setQuickForm({ id: 0, content: "" });
      await loadQuickReplies(currentUser);
      setNotice(quickForm.id ? "快捷语已更新" : "快捷语已添加");
    } catch (error) {
      setNotice(normalizeUserError(error, "快捷语保存失败"));
    }
  }

  async function removeQuickReply(reply: QuickReply) {
    if (!currentUser || !window.confirm(`确定删除快捷语「${reply.title}」吗？`)) return;
    try {
      await api<{ ok: true }>(`/api/quick-replies/${reply.id}?userId=${currentUser.id}`, { method: "DELETE" });
      if (quickForm.id === reply.id) setQuickForm({ id: 0, content: "" });
      await loadQuickReplies(currentUser);
      setNotice("快捷语已删除");
    } catch (error) {
      setNotice(normalizeUserError(error, "快捷语删除失败"));
    }
  }

  async function saveQuickReplyOrder(nextReplies: QuickReply[]) {
    if (!currentUser || !currentUser.phone.startsWith("staff:")) return;
    setQuickReplies(nextReplies);
    try {
      const result = await api<{ quickReplies: QuickReply[] }>("/api/quick-replies/reorder/list", {
        method: "PATCH",
        body: JSON.stringify({ userId: currentUser.id, replyIds: nextReplies.map((reply) => reply.id) }),
      });
      setQuickReplies(result.quickReplies);
    } catch (error) {
      setNotice(normalizeUserError(error, "快捷语排序失败"));
      await loadQuickReplies(currentUser);
    }
  }

  function moveQuickReply(dragId: number, targetId: number) {
    if (dragId === targetId) return;
    const fromIndex = quickReplies.findIndex((reply) => reply.id === dragId);
    const toIndex = quickReplies.findIndex((reply) => reply.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextReplies = [...quickReplies];
    const [moved] = nextReplies.splice(fromIndex, 1);
    nextReplies.splice(toIndex, 0, moved);
    void saveQuickReplyOrder(nextReplies);
  }

  function openActionMenu(messageId: number, x: number, y: number) {
    setToolPanelOpen(false);
    const menuWidth = Math.min(440, window.innerWidth - 24);
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
      if (activeConversationId) await loadActiveConversation();
    } catch (error) {
      setNotice(normalizeUserError(error, "撤回失败"));
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
    setSelectedMessageIds((ids) => {
      if (ids.length > 0) return ids.includes(actionMenu.messageId) ? ids : [...ids, actionMenu.messageId];
      return [actionMenu.messageId];
    });
    setActionMenu(null);
    openForwardModal(mode);
  }

  function startForwardFromSelection(mode: ForwardMode) {
    if (selectedMessageIds.length === 0) return;
    setActionMenu(null);
    setToolPanelOpen(false);
    setQuickPanelOpen(false);
    openForwardModal(mode);
  }

  function cancelMessageSelection() {
    setSelectedMessageIds([]);
    setForwardMode(null);
    setForwardTargetIds([]);
    setActionMenu(null);
  }

  function beginRemarkEditing(conversation: Conversation) {
    if (!currentUser || !currentUser.phone.startsWith("staff:") || !conversation.peer_id || conversation.peer_id === currentUser.id) return;
    setConversationMenu(null);
    setEditingRemark({ conversationId: conversation.id, value: conversation.peer_nickname ?? "" });
  }

  function openForwardModal(mode: ForwardMode) {
    setForwardMode(mode);
    setForwardTargetIds([]);
  }

  function closeForwardModal() {
    if (forwardSending) return;
    setForwardMode(null);
    setForwardTargetIds([]);
  }

  async function saveMedia(media: MediaBody) {
    try {
      const sourceUrl = mediaViewerUrl || media.url;
      const response = await fetch(`${API_URL}${sourceUrl}`);
      if (!response.ok) throw new Error("下载失败");
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = media.name || (media.mimeType.startsWith("video/") ? "video" : "image");
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 800);
      setNotice("已保存");
    } catch (error) {
      setNotice(normalizeUserError(error, "保存失败"));
    }
  }

  function openMediaViewer(media: MediaBody) {
    if (mediaViewerRecoverTimerRef.current) {
      window.clearTimeout(mediaViewerRecoverTimerRef.current);
      mediaViewerRecoverTimerRef.current = null;
    }
    if (mediaViewerCloseTimerRef.current) {
      window.clearTimeout(mediaViewerCloseTimerRef.current);
      mediaViewerCloseTimerRef.current = null;
    }
    mediaViewerScrollTopRef.current = messageListRef.current?.scrollTop ?? 0;
    mediaViewerHeightLockedRef.current = true;
    setMediaViewerViewportVars();
    document.documentElement.classList.add("media-viewer-open");
    setMediaViewerClosing(false);
    setMediaViewerError("");
    setMediaViewerLoading(false);
    setMediaViewerUrl(media.url);
    setViewingMedia(media);
  }

  function tryPlayViewerVideo(video: HTMLVideoElement) {
    const playResult = video.play();
    if (playResult) {
      playResult.catch(() => {
        setMediaViewerLoading(false);
      });
    }
  }

  function setMediaViewerViewportVars() {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const width = viewport?.width ?? window.innerWidth;
    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    const isMobileLayout = isTouchDevice && width <= 920;
    const topReserve = isMobileLayout ? 92 : 82;
    const bottomReserve = isMobileLayout ? Math.max(150, Math.round(height * 0.18)) : 34;
    const usableHeight = Math.max(220, Math.round(height - topReserve - bottomReserve));
    document.documentElement.style.setProperty("--media-viewer-height", `${usableHeight}px`);
  }

  function stopViewerVideo() {
    mediaViewerVideoCleanupRef.current?.();
    mediaViewerVideoCleanupRef.current = null;
    const video = mediaViewerVideoRef.current as WebKitVideoElement | null;
    if (!video) return;
    try {
      if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
    } catch {
      // Ignore browser-specific fullscreen cleanup errors.
    }
    try {
      video.pause();
      video.muted = true;
      video.currentTime = 0;
    } catch {
      // Ignore browser-specific media cleanup errors.
    }
    try {
      video.removeAttribute("src");
      video.src = "";
      video.load();
    } catch {
      // Ignore browser-specific media cleanup errors.
    }
    if (mediaViewerObjectUrlRef.current) {
      URL.revokeObjectURL(mediaViewerObjectUrlRef.current);
      mediaViewerObjectUrlRef.current = "";
    }
    mediaViewerVideoRef.current = null;
  }

  function bindMediaViewerVideo(video: HTMLVideoElement | null) {
    mediaViewerVideoCleanupRef.current?.();
    mediaViewerVideoCleanupRef.current = null;
    mediaViewerVideoRef.current = video;
    if (!video) return;
    const handleWebkitEndFullscreen = () => {
      stopViewerVideo();
      closeMediaViewer();
    };
    video.addEventListener("webkitendfullscreen", handleWebkitEndFullscreen);
    mediaViewerVideoCleanupRef.current = () => {
      video.removeEventListener("webkitendfullscreen", handleWebkitEndFullscreen);
    };
  }

  function recoverAfterMediaViewerClose() {
    if (mediaViewerRecoverTimerRef.current) window.clearTimeout(mediaViewerRecoverTimerRef.current);
    mediaViewerRecoverTimerRef.current = window.setTimeout(() => {
      mediaViewerHeightLockedRef.current = false;
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
      mediaViewerRecoverTimerRef.current = null;
    }, 180);
  }

  function closeMediaViewer() {
    if (mediaViewerClosing) return;
    const isVideo = Boolean(viewingMedia?.mimeType.startsWith("video/"));
    setMediaViewerClosing(true);
    stopViewerVideo();
    skipNextMessageAutoScrollRef.current = true;
    setMediaViewerError("");
    setMediaViewerLoading(false);
    setMediaViewerUrl("");
    const finishClose = () => {
      setViewingMedia(null);
      setMediaViewerClosing(false);
      document.documentElement.classList.remove("media-viewer-open");
      document.documentElement.style.removeProperty("--media-viewer-height");
      mediaViewerCloseTimerRef.current = null;
      recoverAfterMediaViewerClose();
    };
    if (isVideo) {
      finishClose();
    } else {
      mediaViewerCloseTimerRef.current = window.setTimeout(finishClose, 120);
    }
    window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list) {
        list.style.scrollBehavior = "auto";
        list.scrollTop = mediaViewerScrollTopRef.current;
        window.setTimeout(() => {
          list.style.scrollBehavior = "";
        }, 120);
      }
    });
  }

  async function writeClipboardText(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    document.body.appendChild(input);
    input.focus();
    input.select();
    const ok = document.execCommand("copy");
    input.remove();
    if (!ok) throw new Error("复制失败");
  }

  async function copyMessageFromMenu() {
    if (!actionMenu) return;
    const message = messages.find((item) => item.id === actionMenu.messageId);
    if (!message || message.revoked_at) return;
    const text = copyTextForMessage(message).trim();
    if (!text) {
      setNotice("这条消息暂不支持复制");
      setActionMenu(null);
      return;
    }
    try {
      await writeClipboardText(text);
      setNotice("已复制");
    } catch (error) {
      setNotice(normalizeUserError(error, "复制失败"));
    } finally {
      setActionMenu(null);
    }
  }

  function quoteMessageFromMenu() {
    if (!actionMenu) return;
    const message = messages.find((item) => item.id === actionMenu.messageId);
    if (!message || message.revoked_at) return;
    setQuoteTarget({
      messageId: message.id,
      sender: message.sender_nickname,
      preview: quotePreviewForMessage(message),
    });
    setActionMenu(null);
    setSelectedMessageIds([]);
    setToolPanelOpen(false);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
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

  function toggleForwardTarget(conversationId: number) {
    if (forwardSending) return;
    setForwardTargetIds((ids) => (ids.includes(conversationId) ? ids.filter((id) => id !== conversationId) : [...ids, conversationId]));
  }

  async function forwardToSelectedTargets() {
    if (!currentUser || !forwardMode || selectedMessageIds.length === 0 || forwardTargetIds.length === 0 || forwardSending) return;
    const mode = forwardMode;
    const targetIds = [...forwardTargetIds];
    setForwardSending(true);
    setNotice("正在转发...");
    try {
      for (const conversationId of targetIds) {
        await api<{ messages: ChatMessage[] }>(`/api/conversations/${conversationId}/forward`, {
          method: "POST",
          body: JSON.stringify({
            userId: currentUser.id,
            messageIds: selectedMessageIds,
            mode,
          }),
        });
      }
      setNotice(`${mode === "bundle" ? "已合并转发" : "已逐条转发"}到 ${targetIds.length} 个会话`);
      setSelectedMessageIds([]);
      setForwardMode(null);
      setForwardTargetIds([]);
      setActionMenu(null);
      await loadConversationList();
      if (activeConversationId && targetIds.includes(activeConversationId)) await loadActiveConversation();
    } catch (error) {
      setNotice(normalizeUserError(error, "转发失败"));
    } finally {
      setForwardSending(false);
    }
  }

  function logout() {
    localStorage.removeItem("local-chat-user");
    setCurrentUser(null);
    setSocket(null);
    setActiveConversationId(null);
    setMessages([]);
    setQuickReplies([]);
    setQuickPanelOpen(false);
    setQuickPanelCollapsed(false);
    setRetentionPopup(null);
    setRetentionNotice(null);
    if (conversationRefreshTimerRef.current) {
      window.clearTimeout(conversationRefreshTimerRef.current);
      conversationRefreshTimerRef.current = null;
    }
  }

  if (!currentUser) {
    return (
      <Login
        onLogin={(user, openConversationId, nextRetentionPopup, nextRetentionNotice) => {
          setCurrentUser(user);
          setPendingConversationId(openConversationId ?? null);
          setRetentionPopup(nextRetentionPopup ?? null);
          setRetentionNotice(nextRetentionNotice ?? nextRetentionPopup ?? null);
        }}
      />
    );
  }

  const keyword = query.trim().toLowerCase();
  const contactUsers = [currentUser, ...users];
  const filteredUsers = contactUsers.filter((user) => `${user.nickname}${user.phone}`.toLowerCase().includes(keyword));
  const contactItems = conversations
    .filter((conversation) => conversation.peer_id && conversation.peer_id !== currentUser.id)
    .map((conversation) => ({
      conversation,
      daysSinceLastSeen: conversation.peer_last_seen_at
        ? Math.floor((Date.now() - new Date(`${conversation.peer_last_seen_at}Z`).getTime()) / (1000 * 60 * 60 * 24))
        : Number.POSITIVE_INFINITY,
    }));
  const contactSelections = contactItems.filter(({ conversation }) => selectedContactIds.includes(conversation.peer_id ?? -1));
  const filteredConversations = conversations.filter((conversation) => {
    if (!keyword) return true;
    const preview = formatConversationPreview(conversation);
    return `${conversation.peer_nickname ?? ""}${conversation.peer_phone ?? ""}${preview}`.toLowerCase().includes(keyword);
  });
  const totalUnread = conversations.reduce((sum, conversation) => sum + conversation.unread_count, 0);
  const isStaffUser = currentUser.phone.startsWith("staff:");
  const isSelectingMessages = selectedMessageIds.length > 0;
  const isSelectingContacts = selectedContactIds.length > 0 || contactsSelectionMode;
  const canRemarkActiveConversation =
    isStaffUser && Boolean(activeConversation?.peer_id) && activeConversation?.peer_id !== currentUser.id;
  const canUseInstallPrompt = Boolean(installPromptEvent) && !isStaffUser;

  return (
    <main className={`app-shell ${activeConversation ? "chat-open" : ""} ${toolPanelOpen ? "tool-open" : ""} ${quickPanelOpen ? "quick-open" : ""}`}>
      <aside className="sidebar">
        <header className="profile-bar">
          <button className={`avatar avatar-button ${avatarRoleClass(currentUser.phone)}`} style={avatarStyle(currentUser.avatar_url)} onClick={() => void openDirect(currentUser.id)} aria-label="打开自己的聊天">
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
          <button className={mode === "chats" ? "active" : ""} onClick={openUnreadConversation}>
            <MessageCircle size={17} />
            聊天
            {totalUnread > 0 ? <em>{totalUnread}</em> : null}
          </button>
          <button className={mode === "contacts" ? "active" : ""} onClick={() => setMode("contacts")}>
            <UsersRound size={17} />
            联系人
          </button>
        </nav>

        {mode === "contacts" ? (
          <div className="contacts-toolbar">
            <button
              type="button"
              onClick={() => {
                setContactsCleanupScope("3d");
                setContactsConfirmDelete(true);
              }}
            >
              删 3 天未联系
            </button>
            <button
              type="button"
              onClick={() => {
                setContactsCleanupScope("7d");
                setContactsConfirmDelete(true);
              }}
            >
              删 7 天未联系
            </button>
            {isSelectingContacts ? (
              <>
                <button
                  type="button"
                  className="selection-primary"
                  onClick={() => {
                    if (selectedContactIds.length === 0) return;
                    setContactsCleanupScope(null);
                    setContactsConfirmDelete(true);
                  }}
                >
                  删除已选
                </button>
                <button type="button" className="selection-cancel" onClick={clearContactSelection}>
                  取消选择
                </button>
              </>
            ) : null}
          </div>
        ) : null}

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
                      openConversation(conversation.id);
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
                    <div className={`avatar small ${avatarRoleClass(conversation.peer_phone)}`} style={avatarStyle(conversation.peer_avatar_url)}>{avatarLabel(conversation.peer_nickname)}</div>
                    <div className="row-main">
                      <div className="row-title">
                        <strong>{conversation.peer_nickname ?? "会话"}</strong>
                        <span>{formatDateTime(conversation.last_message_at)}</span>
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
                <button
                  key={user.id}
                  className={`list-row contact-row ${selectedContactIds.includes(user.id) ? "selected" : ""}`}
                  onClick={() => {
                    if (contactsSelectionMode) {
                      toggleContactSelection(user.id);
                      return;
                    }
                    void openDirect(user.id);
                  }}
                  onPointerDown={(event) => startContactPress(user.id, event)}
                  onPointerUp={cancelContactPress}
                  onPointerCancel={cancelContactPress}
                  onPointerLeave={cancelContactPress}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    beginContactSelection(user.id);
                  }}
                >
                  <div className={`avatar small ${avatarRoleClass(user.phone)}`} style={avatarStyle(user.avatar_url)}>{avatarLabel(user.nickname)}</div>
                    <div className="row-main">
                      <div className="row-title">
                        <strong>{isSelf ? `${user.nickname}（自己）` : user.nickname}</strong>
                        <span className={isOnline(user.last_seen_at) ? "online" : ""}>
                          {isSelf ? "自己" : isOnline(user.last_seen_at) ? "在线" : "离线"}
                      </span>
                    </div>
                    <p>{user.phone}</p>
                    </div>
                    {contactsSelectionMode ? (
                      <span className={`contact-check ${selectedContactIds.includes(user.id) ? "selected" : ""}`}>{selectedContactIds.includes(user.id) ? <Check size={13} /> : null}</span>
                    ) : null}
                  </button>
              );
            })
          ) : (
            <EmptyState icon={<UserPlus />} title={keyword ? "没有找到联系人" : "暂无联系人"} text={keyword ? "换个昵称或手机号试试。" : "用另一个手机号登录即可生成测试联系人。"} />
          )}
        </section>
        {mode === "contacts" && isSelectingContacts ? (
          <div className="selection-toolbar contacts-selection-toolbar">
            <button
              type="button"
              onClick={() => {
                setContactsCleanupScope(null);
                setContactsConfirmDelete(true);
              }}
            >
              删除
            </button>
            <span>已选 {selectedContactIds.length} 位联系人</span>
            <button type="button" className="selection-cancel" onClick={clearContactSelection}>
              取消
            </button>
          </div>
        ) : null}
      </aside>

      <section
        className="chat-panel"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          void uploadDroppedFiles(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length === 0) return;
          event.preventDefault();
          void uploadDroppedFiles(files);
        }}
      >
        {activeConversation ? (
          <>
            <header className="chat-header">
              <button
                className="mobile-back"
                type="button"
                onClick={() => {
                  setEditingRemark(null);
                  setActiveConversationId(null);
                  setMessages([]);
                }}
                aria-label="返回聊天列表"
              >
                <X size={20} />
              </button>
              {editingRemark?.conversationId === activeConversation.id ? (
                <div className="chat-peer-editor">
                  <input
                    value={editingRemark.value}
                    autoFocus
                    maxLength={40}
                    placeholder="备注客户名字"
                    onChange={(event) => setEditingRemark({ conversationId: activeConversation.id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void remarkConversation(activeConversation, editingRemark.value);
                      }
                      if (event.key === "Escape") {
                        setEditingRemark(null);
                      }
                    }}
                  />
                  <button className="plain-icon" type="button" onClick={() => void remarkConversation(activeConversation, editingRemark.value)} aria-label="保存备注">
                    <Check size={17} />
                  </button>
                  <button className="plain-icon" type="button" onClick={() => setEditingRemark(null)} aria-label="取消备注">
                    <X size={17} />
                  </button>
                </div>
              ) : canRemarkActiveConversation ? (
                <button
                  className="chat-peer-button"
                  type="button"
                  onClick={() => beginRemarkEditing(activeConversation)}
                  title="修改客户备注"
                >
                  <span>
                    <strong>{activeConversation.peer_nickname ?? "会话"}</strong>
                    <small className={isOnline(activeConversation.peer_last_seen_at) ? "online" : ""}>
                      {isOnline(activeConversation.peer_last_seen_at) ? "在线" : "离线"}
                    </small>
                  </span>
                  <Pencil size={15} />
                </button>
              ) : (
                <div className="chat-peer-info">
                  <strong>{activeConversation.peer_nickname ?? "会话"}</strong>
                  <span className={isOnline(activeConversation.peer_last_seen_at) ? "online" : ""}>
                    {isOnline(activeConversation.peer_last_seen_at) ? "在线" : "离线"}
                  </span>
                </div>
              )}
              <div className="chat-header-actions">
                <button className="icon-button" onClick={() => void togglePin(activeConversation)} aria-label={activeConversation.is_pinned ? "取消置顶" : "置顶"}>
                  {activeConversation.is_pinned ? <PinOff size={18} /> : <Pin size={18} />}
                </button>
              </div>
            </header>
            {!isStaffUser ? (
              <CustomerRetentionBar
                retentionText={retentionNotice?.text ?? ""}
                canInstall={canUseInstallPrompt}
                onInstall={() => void goAddToHomeScreen()}
                onCopy={() => void copyCustomerChatLink()}
              />
            ) : retentionNotice ? (
              <div className="retention-chat-notice">
                <strong>温馨提示</strong>
                <p>{retentionNotice.text}</p>
              </div>
            ) : null}
            <div className={`message-list ${messagesLoading ? "is-switching" : ""}`} ref={messageListRef} onScroll={handleMessageListScroll}>
              {olderMessagesLoading ? (
                <div className="older-loading">
                  <span />
                  <strong>正在加载历史消息...</strong>
                </div>
              ) : null}
              {messagesLoading ? (
                <div className="chat-loading">
                  <span />
                  <strong>正在切换会话...</strong>
                </div>
              ) : null}
              {uploading ? (
                <div className="upload-loading">
                  <span />
                  <strong>正在上传文件...</strong>
                </div>
              ) : null}
              {messages.map((message) => {
                const mine = message.sender_id === currentUser.id;
                const selected = selectedMessageIds.includes(message.id);
                const senderPhone = mine
                  ? currentUser.phone
                  : users.find((user) => user.id === message.sender_id)?.phone ??
                    (activeConversation.peer_id === message.sender_id ? activeConversation.peer_phone : null);
                const senderAvatarUrl = mine
                  ? currentUser.avatar_url
                  : message.sender_avatar_url ??
                    users.find((user) => user.id === message.sender_id)?.avatar_url ??
                    (activeConversation.peer_id === message.sender_id ? activeConversation.peer_avatar_url : null);
                if (message.revoked_at) {
                  const canReEdit = mine && Boolean(editableRecalls[message.id]);
                  return (
                    <div
                      key={message.id}
                      className={`recalled-row ${highlightedMessageId === message.id ? "is-highlighted" : ""}`}
                      data-message-id={message.id}
                    >
                      <span>{mine ? "你撤回了一条消息" : `${message.sender_nickname}撤回了一条消息`}</span>
                      {canReEdit ? <button onClick={() => reEditMessage(message.id)}>重新编辑</button> : null}
                    </div>
                  );
                }
                return (
                  <div
                    key={message.id}
                    className={`message-row ${mine ? "mine" : ""} ${selectedMessageIds.length > 0 ? "selecting" : ""} ${highlightedMessageId === message.id ? "is-highlighted" : ""}`}
                    data-message-id={message.id}
                  >
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
                      <button className={`avatar tiny avatar-button message-avatar ${avatarRoleClass(senderPhone)}`} style={avatarStyle(senderAvatarUrl)} onClick={() => void openDirect(message.sender_id)} aria-label={`打开和${message.sender_nickname}的聊天`}>
                        {avatarLabel(message.sender_nickname)}
                      </button>
                    ) : null}
                    <div className="bubble-wrap">
                      <span>{formatDateTime(message.created_at)}</span>
                      <button
                        className="bubble-button"
                        onClick={(event) => {
                          const clickTarget = event.target instanceof Element ? event.target : null;
                          const quoteJump = clickTarget?.closest<HTMLElement>("[data-quote-message-id]");
                          if (quoteJump?.dataset.quoteMessageId) {
                            const quoteBody = parseBody<QuoteBody>(message.body);
                            void jumpToMessage(Number(quoteJump.dataset.quoteMessageId), quoteBody?.quote);
                            return;
                          }
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
                            if (media) openMediaViewer(media);
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
                        <MessageBubble
                          message={message}
                          onMediaLoad={scrollToBottomIfNearBottom}
                          onQuoteJump={(quote) => void jumpToMessage(quote.messageId, quote)}
                        />
                      </button>
                    </div>
                    {mine ? (
                      <button className={`avatar tiny avatar-button message-avatar mine-avatar ${avatarRoleClass(currentUser.phone)}`} style={avatarStyle(currentUser.avatar_url)} onClick={() => void openDirect(currentUser.id)} aria-label="打开自己的聊天">
                        {avatarLabel(message.sender_nickname)}
                      </button>
                    ) : null}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
            {returnBottomVisible ? (
              <button className="return-bottom-button" type="button" onClick={() => scrollToBottom("smooth")}>
                <ChevronDown size={16} />
                <span>回到底部</span>
              </button>
            ) : null}
            {isSelectingMessages ? (
              <div className="selection-toolbar">
                <button type="button" onClick={() => startForwardFromSelection("separate")}>
                  逐条转发
                </button>
                <button type="button" className="selection-primary" onClick={() => startForwardFromSelection("bundle")}>
                  合并转发
                </button>
                <span>已选 {selectedMessageIds.length} 条</span>
                <button type="button" className="selection-cancel" onClick={cancelMessageSelection}>
                  取消
                </button>
              </div>
            ) : (
            <div className={`composer ${isStaffUser ? "has-quick" : ""}`}>
              {quoteTarget ? (
                <div className="quote-composer-preview">
                  <div>
                    <strong>{quoteTarget.sender}</strong>
                    <span>{quoteTarget.preview}</span>
                  </div>
                  <button type="button" onClick={() => setQuoteTarget(null)} aria-label="取消引用">
                    <X size={16} />
                  </button>
                </div>
              ) : null}
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
                onBlur={blurComposer}
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
                aria-disabled={!draft.trim() || uploading}
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
              {isStaffUser ? (
                <button type="button" className={`quick-button ${quickPanelOpen ? "active" : ""}`} onClick={toggleQuickPanel} aria-label="打开快捷语">
                  <MessageSquareText size={21} />
                  <span>快捷语</span>
                </button>
              ) : null}
              <button type="button" className="plus-button" onClick={toggleToolPanel} disabled={uploading} aria-label="打开更多功能">
                <Plus size={24} />
              </button>
            </div>
            )}
            {toolPanelOpen && !isSelectingMessages ? (
              <div className="tool-panel">
                <ToolButton icon={<ImageIcon />} label="照片" onClick={() => !uploading && fileInputRef.current?.click()} />
                <ToolButton icon={<Camera />} label="拍摄" onClick={() => !uploading && void openCamera("photo")} />
                <ToolButton icon={<FileIcon />} label="文件" onClick={() => !uploading && fileInputRef.current?.click()} />
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
      {activeConversation && quickPanelOpen && isStaffUser ? (
        <aside className={`quick-panel ${quickPanelCollapsed ? "collapsed" : ""}`}>
          <button
            type="button"
            className="quick-collapse"
            onClick={() => setQuickPanelCollapsed((collapsed) => !collapsed)}
            aria-label={quickPanelCollapsed ? "展开快捷语" : "收起快捷语"}
          >
            {quickPanelCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
            <span>{quickPanelCollapsed ? "展开" : "收起"}</span>
          </button>
          {!quickPanelCollapsed ? (
            <>
              <header className="quick-panel-head">
                <strong>快捷语</strong>
                <span>{quickReplies.length} 条</span>
              </header>
              <section className="quick-list">
                {quickReplies.length ? (
                  quickReplies.map((reply) => (
                    <article
                      key={reply.id}
                      className={`quick-item ${draggingQuickId === reply.id ? "dragging" : ""}`}
                      draggable
                      onDragStart={(event) => {
                        setDraggingQuickId(reply.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", String(reply.id));
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const dragId = Number(event.dataTransfer.getData("text/plain") || draggingQuickId);
                        setDraggingQuickId(null);
                        if (dragId) moveQuickReply(dragId, reply.id);
                      }}
                      onDragEnd={() => setDraggingQuickId(null)}
                    >
                      <span className="quick-drag-handle" aria-label="拖拽排序">
                        <GripVertical size={16} />
                      </span>
                      <button className="quick-content" type="button" onClick={() => insertQuickReply(reply)}>
                        <span>{reply.content}</span>
                      </button>
                      <div className="quick-actions">
                        <button type="button" className="quick-send" onClick={() => void sendQuickReply(reply)}>发送</button>
                        <button type="button" onClick={() => setQuickForm({ id: reply.id, content: reply.content })}>编辑</button>
                        <button type="button" onClick={() => void removeQuickReply(reply)}>删除</button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="quick-empty">暂无快捷语</div>
                )}
              </section>
              <section className="quick-editor">
                <textarea
                  value={quickForm.content}
                  onChange={(event) => setQuickForm((form) => ({ ...form, content: event.target.value }))}
                  placeholder="回复内容"
                  maxLength={1000}
                  rows={2}
                />
                <div>
                  {quickForm.id ? (
                    <button type="button" className="quick-secondary" onClick={() => setQuickForm({ id: 0, content: "" })}>取消</button>
                  ) : null}
                  <button type="button" className="quick-save" onClick={() => void saveQuickReply()}>
                    {quickForm.id ? "保存" : "新增"}
                  </button>
                </div>
              </section>
            </>
          ) : null}
        </aside>
      ) : null}
      {forwardMode ? (
        <div className="modal-mask">
          <section className="forward-modal">
            <header>
              <strong>{forwardMode === "bundle" ? "合并转发到" : "逐条转发到"}</strong>
              <button className="plain-icon" onClick={closeForwardModal} aria-label="关闭" disabled={forwardSending}>
                <X size={17} />
              </button>
            </header>
            <div className="forward-list">
              {conversations.map((conversation) => {
                const selected = forwardTargetIds.includes(conversation.id);
                return (
                  <button
                    key={conversation.id}
                    className={selected ? "selected" : ""}
                    onClick={() => toggleForwardTarget(conversation.id)}
                    disabled={forwardSending}
                  >
                    <span className={`forward-check ${selected ? "selected" : ""}`}>{selected ? <Check size={13} /> : null}</span>
                    <div className={`avatar small ${avatarRoleClass(conversation.peer_phone)}`} style={avatarStyle(conversation.peer_avatar_url)}>{avatarLabel(conversation.peer_nickname)}</div>
                    <span>{conversation.peer_nickname ?? "会话"}</span>
                  </button>
                );
              })}
            </div>
            <footer className="forward-actions">
              <span>已选 {forwardTargetIds.length} 个</span>
              <button type="button" onClick={closeForwardModal} disabled={forwardSending}>取消</button>
              <button
                type="button"
                className="forward-send"
                onClick={() => void forwardToSelectedTargets()}
                disabled={forwardTargetIds.length === 0 || forwardSending}
              >
                {forwardSending ? "发送中..." : "发送"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {contactsConfirmDelete ? (
        <div className="modal-mask">
          <section className="confirm-modal">
            <strong>确定删除吗</strong>
            <p>
              {contactsCleanupScope
                ? contactsCleanupScope === "3d"
                  ? "将删除所有 3 天未联系的联系人。"
                  : "将删除所有 7 天未联系的联系人。"
                : `将删除已选的 ${selectedContactIds.length} 位联系人。`}
            </p>
            <footer>
              <button type="button" onClick={() => setContactsConfirmDelete(false)}>
                取消
              </button>
              <button type="button" className="danger-action" onClick={() => void confirmContactDelete()}>
                确定删除
              </button>
            </footer>
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
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                  <RecordContent
                    item={item}
                    onOpenMedia={(media) => {
                      openMediaViewer(media);
                    }}
                    onJumpToMessage={(messageId) => {
                      setViewingBundle(null);
                      window.setTimeout(() => void jumpToMessage(messageId), 0);
                    }}
                  />
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {retentionPopup ? (
        <div className="modal-mask retention-mask">
          <section className="retention-modal">
            <strong>温馨提示</strong>
            <p>{retentionPopup.text}</p>
            <button type="button" onClick={() => setRetentionPopup(null)}>
              知道了
            </button>
          </section>
        </div>
      ) : null}
      {viewingMedia ? (
        <div
          className="media-viewer"
          onClick={closeMediaViewer}
        >
          <button
            className="media-viewer-close"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onTouchEnd={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeMediaViewer();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeMediaViewer();
            }}
            aria-label="关闭图片视频预览"
          >
            <X size={30} />
          </button>
          <button
            className="media-viewer-save"
            onClick={(event) => {
              event.stopPropagation();
              void saveMedia(viewingMedia);
            }}
            aria-label="保存图片视频"
          >
            <Download size={18} />
            <span>保存</span>
          </button>
          {viewingMedia.mimeType.startsWith("video/") ? (
            <>
              {!mediaViewerClosing ? <div className="media-viewer-video-frame" onClick={(event) => event.stopPropagation()}>
                <video
                  ref={bindMediaViewerVideo}
                  key={mediaViewerUrl || viewingMedia.url}
                  src={`${API_URL}${mediaViewerUrl || viewingMedia.url}`}
                  controls
                  playsInline
                  disablePictureInPicture
                  controlsList="nodownload noplaybackrate"
                  preload="metadata"
                  poster={viewingMedia.posterUrl ? `${API_URL}${viewingMedia.posterUrl}` : undefined}
                  onPointerDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                  onTouchEnd={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onAbort={() => setMediaViewerLoading(false)}
                  onLoadedMetadata={(event) => {
                    setMediaViewerLoading(false);
                    setMediaViewerError("");
                    tryPlayViewerVideo(event.currentTarget);
                  }}
                  onPlay={() => {
                    setMediaViewerLoading(false);
                    setMediaViewerError("");
                  }}
                  onLoadedData={() => {
                    setMediaViewerLoading(false);
                    setMediaViewerError("");
                  }}
                  onCanPlay={(event) => {
                    setMediaViewerLoading(false);
                    setMediaViewerError("");
                    if (event.currentTarget.paused) tryPlayViewerVideo(event.currentTarget);
                  }}
                  onPlaying={() => {
                    setMediaViewerLoading(false);
                    setMediaViewerError("");
                  }}
                  onPause={() => setMediaViewerLoading(false)}
                  onEnded={() => setMediaViewerLoading(false)}
                  onWaiting={() => setMediaViewerLoading(true)}
                  onStalled={() => setMediaViewerLoading(true)}
                  onSuspend={() => setMediaViewerLoading(false)}
                  onEmptied={() => setMediaViewerLoading(false)}
                  onError={() => {
                    if (viewingMedia.originalUrl && viewingMedia.originalUrl !== (mediaViewerUrl || viewingMedia.url)) {
                      setMediaViewerUrl(viewingMedia.originalUrl);
                      setMediaViewerLoading(true);
                      setMediaViewerError("");
                      setNotice("正在尝试原视频播放...");
                      return;
                    }
                    setMediaViewerLoading(false);
                    setMediaViewerError("视频加载失败，可先保存到手机相册查看");
                  }}
                />
              </div> : null}
              {mediaViewerLoading && !mediaViewerError ? (
                <div className="media-viewer-loading" onClick={(event) => event.stopPropagation()}>
                  <span />
                  <strong>正在加载视频...</strong>
                </div>
              ) : null}
              {mediaViewerError ? (
                <div className="media-viewer-error" onClick={(event) => event.stopPropagation()}>
                  <strong>{mediaViewerError}</strong>
                  <button type="button" onClick={() => void saveMedia(viewingMedia)}>
                    保存视频
                  </button>
                </div>
              ) : null}
            </>
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
            <button onClick={() => void copyMessageFromMenu()}>复制</button>
            <button onClick={quoteMessageFromMenu}>引用</button>
            <button
              onClick={() => {
                toggleMessageSelection(actionMenu.messageId);
                setActionMenu(null);
              }}
            >
              {selectedMessageIds.includes(actionMenu.messageId) ? "取消选择" : "多选"}
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
                  {currentUser.phone.startsWith("staff:") && conversation.peer_id !== currentUser.id ? (
                    <button
                      onClick={() => {
                        beginRemarkEditing(conversation);
                      }}
                    >
                      备注
                    </button>
                  ) : null}
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

function CustomerRetentionBar({
  retentionText,
  canInstall,
  onInstall,
  onCopy,
}: {
  retentionText: string;
  canInstall: boolean;
  onInstall: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="customer-retention-bar">
      <div className="customer-retention-copy">
        <strong>请不要关闭页面，客服会在这里回复</strong>
        <span>建议复制并收藏这个专属聊天链接，方便下次继续沟通。</span>
        {retentionText ? <p>{retentionText}</p> : null}
      </div>
      <div className="customer-retention-actions">
        <button type="button" onClick={onCopy}>
          <Copy size={15} />
          复制链接
        </button>
        {canInstall ? (
          <button type="button" onClick={onInstall}>
            添加桌面
          </button>
        ) : null}
      </div>
    </div>
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

function MessageBubble({
  message,
  onMediaLoad,
  onQuoteJump,
}: {
  message: ChatMessage;
  onMediaLoad?: () => void;
  onQuoteJump?: (quote: QuoteTarget) => void;
}) {
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
            {item.sender}: {item.type === "text" ? displayTextBody(item.body) : item.type === "image" ? "[图片]" : item.type === "video" ? "[视频]" : "[聊天记录]"}
          </p>
        ))}
      </div>
    );
  }

  const quoteBody = parseBody<QuoteBody>(message.body);
  if (quoteBody?.quote) {
    return (
      <div className="bubble quote-text-bubble">
        <div
          className="quoted-message quote-jump"
          data-quote-message-id={quoteBody.quote.messageId}
          role="button"
          tabIndex={0}
          title="点击定位到引用消息"
          onClick={(event) => {
            event.stopPropagation();
            onQuoteJump?.(quoteBody.quote);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onQuoteJump?.(quoteBody.quote);
          }}
        >
          <strong>{quoteBody.quote.sender}</strong>
          <span>{quoteBody.quote.preview}</span>
        </div>
        <p>{quoteBody.text}</p>
      </div>
    );
  }

  return <p className="bubble">{displayTextBody(message.body)}</p>;
}

function VideoBubble({ media, onMediaLoad }: { media: MediaBody; onMediaLoad?: () => void }) {
  const serverPoster = media.posterUrl ? `${API_URL}${media.posterUrl}` : "";
  const [poster, setPoster] = useState(serverPoster);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");

  useEffect(() => {
    setPoster(serverPoster);
  }, [media.url, serverPoster]);

  function updatePosterSize(event: React.SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    setOrientation(image.naturalHeight > image.naturalWidth ? "portrait" : "landscape");
    onMediaLoad?.();
  }

  return (
    <div className={`bubble media-bubble video-bubble ${orientation} ${poster ? "has-poster" : ""}`}>
      {poster ? <img src={poster} alt={media.name} onLoad={updatePosterSize} onError={() => setPoster("")} /> : null}
      {!poster ? <strong>视频</strong> : null}
      <span className="video-play">
        <Play size={26} fill="currentColor" />
      </span>
    </div>
  );
}

function RecordContent({
  item,
  onOpenMedia,
  onJumpToMessage,
}: {
  item: BundleBody["items"][number];
  onOpenMedia?: (media: MediaBody) => void;
  onJumpToMessage?: (messageId: number) => void;
}) {
  if (item.type === "image") {
    const media = parseBody<MediaBody>(item.body);
    if (!media) return <p>[图片]</p>;
    return (
      <button className="record-media-button" type="button" onClick={() => onOpenMedia?.(media)} aria-label="打开图片">
        <img className="record-media" src={`${API_URL}${media.url}`} alt={media.name} />
      </button>
    );
  }

  if (item.type === "video") {
    const media = parseBody<MediaBody>(item.body);
    if (!media) return <p>[视频]</p>;
    return (
      <button className="record-media-button" type="button" onClick={() => onOpenMedia?.(media)} aria-label="打开视频">
        {media.posterUrl ? <img className="record-media" src={`${API_URL}${media.posterUrl}`} alt={media.name} /> : <span className="record-video-placeholder">视频</span>}
        <span className="record-video-play">
          <Play size={22} fill="currentColor" />
        </span>
      </button>
    );
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

  const quoteBody = parseBody<QuoteBody>(item.body);
  if (quoteBody?.quote) {
    return (
      <div className="record-quote">
        <button
          className="quoted-message quote-jump record-quote-jump"
          type="button"
          onClick={() => onJumpToMessage?.(quoteBody.quote.messageId)}
        >
          <strong>{quoteBody.quote.sender}</strong>
          <span>{quoteBody.quote.preview}</span>
        </button>
        <p>{quoteBody.text}</p>
      </div>
    );
  }

  return <p>{displayTextBody(item.body)}</p>;
}

function formatConversationPreview(conversation: Conversation) {
  if (!conversation.last_message_body) return "暂无消息";
  return displayTextBody(conversation.last_message_body);
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
