import cors from "cors";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, existsSync, promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { Server } from "socket.io";
import { z } from "zod";
import {
  assignCustomerToInvite,
  authenticateStaff,
  assertStaffAccess,
  batchDeleteUsers,
  batchSetUserStatus,
  changeStaffPassword,
  createMessage,
  createInviteLink,
  createInviteNickname,
  createStaffAccount,
  createQuickReply,
  deleteFriend,
  deleteInviteLink,
  deleteQuickReply,
  deleteStaffAccount,
  getAdminSettings,
  getAllUsers,
  getAssignedServiceChatUserId,
  getConversationMemberIds,
  getConversations,
  getInviteLinkByCode,
  getMessagesByIds,
  getMessages,
  markConversationRead,
  getOrCreateDirectConversation,
  getOrCreateUser,
  getOrCreateUserWithNickname,
  getQuickReplies,
  getStaffById,
  getStaffPublicById,
  getUserByPhone,
  getVisibleInviteLinks,
  getVisibleStaff,
  getUsers,
  getDirectConversationPeerId,
  updateCustomerRemark,
  updateInviteLink,
  updateQuickReply,
  updateStaffAvatar,
  recallMessage,
  reorderQuickReplies,
  setConversationPinned,
  setInviteLinkStatus,
  setStaffStatus,
  setUserStatus,
  touchUser,
  updateAdminSettings,
} from "./db.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

const port = Number(process.env.PORT ?? 4000);
const phoneSchema = z.string().trim().regex(/^\d{11}$/);
const credentialSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/);
const uploadDir = join(process.cwd(), "uploads");
mkdirSync(uploadDir, { recursive: true });
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_request, file, callback) => {
      const safeExt = extname(file.originalname).toLowerCase();
      callback(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (_request, file, callback) => {
    const extension = extname(file.originalname).toLowerCase();
    const allowedExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm"]);
    if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/") || allowedExtensions.has(extension)) {
      callback(null, true);
      return;
    }
    callback(new Error("仅支持图片或视频"));
  },
});

app.use(cors({ origin: true }));
app.use(express.json());
app.use(
  "/uploads",
  express.static(uploadDir, {
    acceptRanges: true,
    maxAge: "7d",
    setHeaders: (response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
    },
  }),
);

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

function emitNewMessage(message: ReturnType<typeof createMessage>) {
  for (const userId of getConversationMemberIds(message.conversation_id)) {
    io.to(`user:${userId}`).emit("message:new", message);
  }
  io.emit("conversation:changed", { conversationId: message.conversation_id });
}

function runFfmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
      if (errorOutput.length > 4000) errorOutput = errorOutput.slice(-4000);
    });
    child.on("error", (error) => {
      reject(new Error(error.message.includes("ENOENT") ? "服务器未安装 ffmpeg，暂时不能处理视频" : error.message));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(errorOutput.trim() || "视频转码失败"));
    });
  });
}

async function transcodeVideoForChat(file: Express.Multer.File) {
  const sourcePath = file.path;
  const baseName = basename(file.filename, extname(file.filename));
  const mp4Name = `${baseName}-chat.mp4`;
  const posterName = `${baseName}-poster.jpg`;
  const mp4Path = join(uploadDir, mp4Name);
  const posterPath = join(uploadDir, posterName);

  await runFfmpeg([
    "-y",
    "-i",
    sourcePath,
    "-vf",
    "scale='min(720,iw)':-2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "baseline",
    "-level",
    "3.1",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-max_muxing_queue_size",
    "1024",
    mp4Path,
  ]);

  await runFfmpeg([
    "-y",
    "-ss",
    "00:00:00.2",
    "-i",
    mp4Path,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(720,iw)':-2",
    "-q:v",
    "4",
    posterPath,
  ]).catch(() => undefined);

  const output = await fs.stat(mp4Path);
  if (sourcePath !== mp4Path) {
    await fs.unlink(sourcePath).catch(() => undefined);
  }

  return {
    url: `/uploads/${mp4Name}`,
    posterUrl: existsSync(posterPath) ? `/uploads/${posterName}` : null,
    size: output.size,
  };
}

app.post("/api/login", (request, response) => {
  const parsed = z.object({ phone: phoneSchema, inviteCode: z.string().trim().max(40).optional() }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "手机号格式不正确" });
    return;
  }

  const normalizedPhone = parsed.data.phone;
  const existingUser = getUserByPhone(normalizedPhone);
  if (existingUser && existingUser.status !== "active") {
    response.status(403).json({ error: "账号已被后台禁用" });
    return;
  }
  const invite = parsed.data.inviteCode ? getInviteLinkByCode(parsed.data.inviteCode) : null;
  if (!parsed.data.inviteCode) {
    if (!existingUser || !getAssignedServiceChatUserId(existingUser.id)) {
      response.status(403).json({ error: "未匹配专属客服" });
      return;
    }
  } else if (!invite || invite.status !== "active") {
    response.status(403).json({ error: "未匹配专属客服" });
    return;
  }

  const wasExisting = Boolean(existingUser);
  const inviteNickname = wasExisting ? null : createInviteNickname(parsed.data.inviteCode ?? null);
  const user = inviteNickname ? getOrCreateUserWithNickname(normalizedPhone, inviteNickname) : getOrCreateUser(normalizedPhone);
  const inviteAssignment = assignCustomerToInvite(user.id, parsed.data.inviteCode ?? null);
  const serviceChatUserId = inviteAssignment?.owner.chat_user_id ?? null;
  const openConversationId = serviceChatUserId ? getOrCreateDirectConversation(user.id, serviceChatUserId) : null;
  const settings = inviteAssignment
    ? {
        autoReplyEnabled: Boolean(inviteAssignment.invite.auto_reply_enabled),
        autoReplyText: inviteAssignment.invite.auto_reply_text,
      }
    : getAdminSettings();
  const senderUser = serviceChatUserId ? getAllUsers().find((item) => item.id === serviceChatUserId) : getAllUsers()[0];
  if (!wasExisting && settings.autoReplyEnabled && senderUser && senderUser.id !== user.id) {
    try {
      const conversationId = openConversationId ?? getOrCreateDirectConversation(senderUser.id, user.id);
      const body = settings.autoReplyText.replace(/\{nickname\}/g, user.nickname);
      const message = createMessage({
        conversationId,
        senderId: senderUser.id,
        body,
        clientId: `${senderUser.id}-auto-${Date.now()}-${crypto.randomUUID()}`,
      });
      emitNewMessage(message);
    } catch {
      // Auto reply should never block login.
    }
  }
  response.json({ user, openConversationId });
});

function makeStaffToken(staffId: number) {
  return `staff-${staffId}`;
}

function readStaffId(request: express.Request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const match = token?.match(/^staff-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function requireStaff(request: express.Request, response: express.Response, roles?: Array<"super_admin" | "admin" | "service">) {
  const staffId = readStaffId(request);
  if (!staffId) {
    response.status(401).json({ error: "请先登录后台" });
    return null;
  }
  try {
    return assertStaffAccess(staffId, roles);
  } catch (error) {
    response.status(403).json({ error: error instanceof Error ? error.message : "没有权限" });
    return null;
  }
}

app.post("/api/admin/login", (request, response) => {
  const parsed = z.object({ username: credentialSchema, password: z.string().min(1).max(64) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(401).json({ error: "账号或密码不正确" });
    return;
  }
  try {
    const staff = authenticateStaff(parsed.data.username, parsed.data.password);
    response.json({ token: makeStaffToken(staff.id), staff });
  } catch (error) {
    response.status(401).json({ error: error instanceof Error ? error.message : "登录失败" });
  }
});

app.post("/api/staff-chat/login", (request, response) => {
  const parsed = z.object({ username: credentialSchema, password: z.string().min(1).max(64) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(401).json({ error: "账号或密码不正确" });
    return;
  }
  try {
    const staff = authenticateStaff(parsed.data.username, parsed.data.password);
    if (staff.role !== "service" || !staff.chat_user_id) {
      response.status(403).json({ error: "只有客服账号可以登录聊天端" });
      return;
    }
    const user = getAllUsers().find((item) => item.id === staff.chat_user_id);
    if (!user || user.status !== "active") {
      response.status(403).json({ error: "客服聊天身份不可用" });
      return;
    }
    response.json({ user });
  } catch (error) {
    response.status(401).json({ error: error instanceof Error ? error.message : "登录失败" });
  }
});

app.get("/api/admin/overview", (request, response) => {
  const staff = requireStaff(request, response);
  if (!staff) return;
  const users = getAllUsers().filter((user) => !user.phone.startsWith("staff:"));
  const staffAccounts = getVisibleStaff(staff.id);
  const inviteLinks = getVisibleInviteLinks(staff.id);
  response.json({
    staff,
    users,
    staffAccounts,
    inviteLinks,
    settings: getAdminSettings(),
    stats: {
      totalUsers: users.length,
      activeUsers: users.filter((user) => user.status === "active").length,
      disabledUsers: users.filter((user) => user.status !== "active").length,
      staffAccounts: staffAccounts.length,
      inviteLinks: inviteLinks.length,
    },
  });
});

app.post("/api/admin/staff", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin"]);
  if (!actor) return;
  const parsed = z
    .object({
      username: credentialSchema,
      password: z.string().min(6).max(64),
      displayName: z.string().trim().min(1).max(30),
      role: z.literal("service"),
      parentId: z.number().optional().nullable(),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ staff: createStaffAccount({ actorId: actor.id, ...parsed.data }) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "创建失败" });
  }
});

app.patch("/api/admin/staff/:id/status", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin"]);
  if (!actor) return;
  const staffId = Number(request.params.id);
  const parsed = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(request.body);
  if (!staffId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ staff: setStaffStatus(actor.id, staffId, parsed.data.status) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "更新失败" });
  }
});

app.delete("/api/admin/staff/:id", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin"]);
  if (!actor) return;
  const staffId = Number(request.params.id);
  if (!staffId) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    deleteStaffAccount(actor.id, staffId);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});

app.post("/api/admin/staff/:id/avatar", upload.single("file"), (request, response) => {
  const actor = requireStaff(request, response, ["super_admin"]);
  if (!actor) return;
  const staffId = Number(request.params.id);
  const file = request.file;
  if (!staffId || !file) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    const avatarUrl = `/uploads/${file.filename}`;
    response.json({ staff: updateStaffAvatar(actor.id, staffId, avatarUrl) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "上传失败" });
  }
});

app.patch("/api/admin/password", (request, response) => {
  const staff = requireStaff(request, response);
  if (!staff) return;
  const parsed = z.object({ currentPassword: z.string().min(1), nextPassword: z.string().min(6).max(64) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    changeStaffPassword(staff.id, parsed.data.currentPassword, parsed.data.nextPassword);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "修改失败" });
  }
});

app.post("/api/admin/invite-links", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin", "service"]);
  if (!actor) return;
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(50),
      ownerStaffId: z.number(),
      autoReplyEnabled: z.boolean(),
      autoReplyText: z.string().trim().min(1).max(1000),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ inviteLink: createInviteLink({ actorId: actor.id, ...parsed.data }) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "创建失败" });
  }
});

app.patch("/api/admin/invite-links/:id", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin", "service"]);
  if (!actor) return;
  const linkId = Number(request.params.id);
  const parsed = z
    .object({
      title: z.string().trim().min(1).max(50),
      ownerStaffId: z.number(),
      autoReplyEnabled: z.boolean(),
      autoReplyText: z.string().trim().min(1).max(1000),
    })
    .safeParse(request.body);
  if (!linkId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ inviteLink: updateInviteLink({ actorId: actor.id, linkId, ...parsed.data }) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "修改失败" });
  }
});

app.patch("/api/admin/invite-links/:id/status", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin", "service"]);
  if (!actor) return;
  const linkId = Number(request.params.id);
  const parsed = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(request.body);
  if (!linkId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    setInviteLinkStatus(actor.id, linkId, parsed.data.status);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "更新失败" });
  }
});

app.delete("/api/admin/invite-links/:id", (request, response) => {
  const actor = requireStaff(request, response, ["super_admin", "service"]);
  if (!actor) return;
  const linkId = Number(request.params.id);
  if (!linkId) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    deleteInviteLink(actor.id, linkId);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "删除失败" });
  }
});

app.get("/api/invite-links/:code", (request, response) => {
  const link = getInviteLinkByCode(request.params.code);
  if (!link || link.status !== "active") {
    response.status(404).json({ error: "链接不存在或已停用" });
    return;
  }
  response.json({ inviteLink: { code: link.code, title: link.title, ownerName: link.owner_name } });
});

app.patch("/api/admin/users/batch/status", (request, response) => {
  const staff = requireStaff(request, response, ["super_admin"]);
  if (!staff) return;
  const parsed = z.object({ userIds: z.array(z.number()).min(1), status: z.enum(["active", "disabled"]) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    response.json({ count: batchSetUserStatus(parsed.data.userIds, parsed.data.status) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "批量更新失败" });
  }
});

app.delete("/api/admin/users/batch", (request, response) => {
  const staff = requireStaff(request, response, ["super_admin"]);
  if (!staff) return;
  const parsed = z.object({ userIds: z.array(z.number()).min(1) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    response.json({ count: batchDeleteUsers(parsed.data.userIds) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "批量删除失败" });
  }
});

app.patch("/api/admin/users/:id/status", (request, response) => {
  const staff = requireStaff(request, response, ["super_admin"]);
  if (!staff) return;
  const userId = Number(request.params.id);
  const parsed = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(request.body);
  if (!userId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    response.json({ user: setUserStatus(userId, parsed.data.status) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "更新失败" });
  }
});

app.patch("/api/admin/settings", (request, response) => {
  const staff = requireStaff(request, response, ["super_admin"]);
  if (!staff) return;
  const parsed = z
    .object({
      autoReplyEnabled: z.boolean(),
      autoReplyText: z.string().trim().min(1).max(1000),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  response.json({ settings: updateAdminSettings(parsed.data) });
});

app.get("/api/users", (request, response) => {
  const userId = Number(request.query.userId);
  if (!userId) {
    response.status(400).json({ error: "缺少 userId" });
    return;
  }

  try {
    response.json({ users: getUsers(userId) });
  } catch (error) {
    response.status(403).json({ error: error instanceof Error ? error.message : "账号不可用" });
  }
});

app.get("/api/conversations", (request, response) => {
  const userId = Number(request.query.userId);
  if (!userId) {
    response.status(400).json({ error: "缺少 userId" });
    return;
  }

  try {
    response.json({ conversations: getConversations(userId) });
  } catch (error) {
    response.status(403).json({ error: error instanceof Error ? error.message : "账号不可用" });
  }
});

app.post("/api/conversations/direct", (request, response) => {
  const parsed = z.object({ userId: z.number(), peerId: z.number() }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    const conversationId = getOrCreateDirectConversation(parsed.data.userId, parsed.data.peerId);
    response.json({ conversationId });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "创建会话失败" });
  }
});

app.delete("/api/friends/:peerId", (request, response) => {
  const peerId = Number(request.params.peerId);
  const userId = Number(request.query.userId);
  if (!userId || !peerId) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    const conversationId = deleteFriend(userId, peerId);
    io.emit("conversation:changed", { conversationId });
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "删除好友失败" });
  }
});

app.post("/api/conversations/:id/remark", (request, response) => {
  const conversationId = Number(request.params.id);
  const parsed = z.object({ userId: z.number(), remarkName: z.string().trim().max(40) }).safeParse(request.body);
  if (!conversationId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    const peerId = getDirectConversationPeerId(conversationId, parsed.data.userId);
    if (!peerId) {
      response.status(400).json({ error: "会话不存在" });
      return;
    }
    updateCustomerRemark(parsed.data.userId, peerId, parsed.data.remarkName);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "备注失败" });
  }
});

app.patch("/api/conversations/:id/pin", (request, response) => {
  const conversationId = Number(request.params.id);
  const parsed = z.object({ userId: z.number(), pinned: z.boolean() }).safeParse(request.body);
  if (!conversationId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    setConversationPinned(conversationId, parsed.data.userId, parsed.data.pinned);
    io.emit("conversation:changed", { conversationId });
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "置顶失败" });
  }
});

app.get("/api/conversations/:id/messages", (request, response) => {
  const conversationId = Number(request.params.id);
  const userId = Number(request.query.userId);
  const limit = request.query.limit ? Number(request.query.limit) : undefined;
  const beforeMessageId = request.query.beforeMessageId ? Number(request.query.beforeMessageId) : undefined;
  if (!conversationId || !userId) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  if ((limit !== undefined && (!Number.isInteger(limit) || limit < 1)) || (beforeMessageId !== undefined && (!Number.isInteger(beforeMessageId) || beforeMessageId < 1))) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    response.json(getMessages(conversationId, userId, { limit, beforeMessageId }));
  } catch (error) {
    response.status(403).json({ error: error instanceof Error ? error.message : "账号不可用" });
  }
});

app.patch("/api/conversations/:id/read", (request, response) => {
  const conversationId = Number(request.params.id);
  const parsed = z.object({ userId: z.number() }).safeParse(request.body);
  if (!conversationId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    markConversationRead(conversationId, parsed.data.userId);
    response.json({ ok: true });
  } catch (error) {
    response.status(403).json({ error: error instanceof Error ? error.message : "账号不可用" });
  }
});

app.post("/api/conversations/:id/messages", (request, response) => {
  const conversationId = Number(request.params.id);
  const parsed = z
    .object({
      userId: z.number(),
      body: z.string().trim().min(1).max(2000),
      clientId: z.string().min(8).max(80),
    })
    .safeParse(request.body);

  if (!conversationId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    const message = createMessage({
      conversationId,
      senderId: parsed.data.userId,
      body: parsed.data.body,
      clientId: parsed.data.clientId,
    });
    emitNewMessage(message);
    response.json({ message });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "发送失败" });
  }
});

app.get("/api/quick-replies", (request, response) => {
  const userId = Number(request.query.userId);
  if (!userId) {
    response.status(400).json({ error: "缺少 userId" });
    return;
  }
  try {
    response.json({ quickReplies: getQuickReplies(userId) });
  } catch (error) {
    response.status(403).json({ error: error instanceof Error ? error.message : "快捷语不可用" });
  }
});

app.post("/api/quick-replies", (request, response) => {
  const parsed = z
    .object({
      userId: z.number(),
      title: z.string().trim().min(1).max(40),
      content: z.string().trim().min(1).max(1000),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ quickReply: createQuickReply(parsed.data.userId, parsed.data) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "创建快捷语失败" });
  }
});

app.patch("/api/quick-replies/:id", (request, response) => {
  const replyId = Number(request.params.id);
  const parsed = z
    .object({
      userId: z.number(),
      title: z.string().trim().min(1).max(40),
      content: z.string().trim().min(1).max(1000),
    })
    .safeParse(request.body);
  if (!replyId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ quickReply: updateQuickReply(parsed.data.userId, replyId, parsed.data) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "更新快捷语失败" });
  }
});

app.delete("/api/quick-replies/:id", (request, response) => {
  const replyId = Number(request.params.id);
  const userId = Number(request.query.userId);
  if (!replyId || !userId) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    deleteQuickReply(userId, replyId);
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "删除快捷语失败" });
  }
});

app.patch("/api/quick-replies/reorder/list", (request, response) => {
  const parsed = z
    .object({
      userId: z.number(),
      replyIds: z.array(z.number()).min(1),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }
  try {
    response.json({ quickReplies: reorderQuickReplies(parsed.data.userId, parsed.data.replyIds) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "排序失败" });
  }
});

app.post("/api/conversations/:id/uploads", upload.single("file"), async (request, response) => {
  const conversationId = Number(request.params.id);
  const userId = Number(request.body.userId);
  const file = request.file;

  if (!conversationId || !userId || !file) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  const type = file.mimetype.startsWith("video/") ? "video" : "image";

  try {
    const media =
      type === "video"
        ? await transcodeVideoForChat(file)
        : {
            url: `/uploads/${file.filename}`,
            posterUrl: null,
            size: file.size,
          };
    const body = JSON.stringify({
      url: media.url,
      posterUrl: media.posterUrl,
      name: type === "video" ? `${basename(file.originalname, extname(file.originalname))}.mp4` : file.originalname,
      size: media.size,
      originalSize: file.size,
      mimeType: type === "video" ? "video/mp4" : file.mimetype,
      transcoded: type === "video",
    });
    const message = createMessage({
      conversationId,
      senderId: userId,
      type,
      body,
      clientId: `${userId}-${Date.now()}-${crypto.randomUUID()}`,
    });
    emitNewMessage(message);
    response.json({ message });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "上传失败" });
  }
});

app.post("/api/messages/:id/recall", (request, response) => {
  const messageId = Number(request.params.id);
  const parsed = z.object({ userId: z.number() }).safeParse(request.body);
  if (!messageId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    const message = recallMessage(messageId, parsed.data.userId);
    io.to(`conversation:${message.conversation_id}`).emit("message:changed", message);
    io.emit("conversation:changed", { conversationId: message.conversation_id });
    response.json({ message });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "撤回失败" });
  }
});

app.post("/api/conversations/:id/forward", (request, response) => {
  const targetConversationId = Number(request.params.id);
  const parsed = z
    .object({
      userId: z.number(),
      messageIds: z.array(z.number()).min(1),
      mode: z.enum(["separate", "bundle"]),
    })
    .safeParse(request.body);

  if (!targetConversationId || !parsed.success) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    const sourceMessages = getMessagesByIds(parsed.data.messageIds, parsed.data.userId);
    if (sourceMessages.length === 0) {
      response.status(400).json({ error: "没有可转发的消息" });
      return;
    }

    const created = sourceMessages.map((sourceMessage, index) => {
      if (parsed.data.mode === "bundle") {
        return null;
      }
      return createMessage({
        conversationId: targetConversationId,
        senderId: parsed.data.userId,
        type: sourceMessage.type as "text" | "image" | "video" | "forward_bundle",
        body: sourceMessage.body,
        clientId: `${parsed.data.userId}-forward-${Date.now()}-${index}-${crypto.randomUUID()}`,
      });
    }).filter(Boolean);

    if (parsed.data.mode === "bundle") {
      const bundleBody = JSON.stringify({
        title: "聊天记录",
        count: sourceMessages.length,
        items: sourceMessages.map((message) => ({
          sender: message.sender_nickname,
          type: message.type,
          body: message.body,
          createdAt: message.created_at,
        })),
      });
      created.push(createMessage({
        conversationId: targetConversationId,
        senderId: parsed.data.userId,
        type: "forward_bundle",
        body: bundleBody,
        clientId: `${parsed.data.userId}-bundle-${Date.now()}-${crypto.randomUUID()}`,
      }));
    }

    const latestMessage = created.at(-1);
    if (latestMessage) emitNewMessage(latestMessage);
    response.json({ messages: created });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "转发失败" });
  }
});

io.on("connection", (socket) => {
  socket.on("user:online", (userId: number) => {
    if (!Number.isFinite(userId)) return;
    try {
      touchUser(userId);
    } catch {
      socket.disconnect(true);
      return;
    }
    socket.join(`user:${userId}`);
    io.emit("presence:changed", { userId, online: true });
  });

  socket.on("conversation:join", (conversationId: number) => {
    if (!Number.isFinite(conversationId)) return;
    socket.join(`conversation:${conversationId}`);
  });

  socket.on("conversation:leave", (conversationId: number) => {
    if (!Number.isFinite(conversationId)) return;
    socket.leave(`conversation:${conversationId}`);
  });
});

httpServer.listen(port, () => {
  console.log(`Local chat server running at http://localhost:${port}`);
});
