import cors from "cors";
import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { Server } from "socket.io";
import { z } from "zod";
import {
  assignCustomerToInvite,
  authenticateStaff,
  assertStaffAccess,
  changeStaffPassword,
  createMessage,
  createInviteLink,
  createInviteNickname,
  createStaffAccount,
  deleteFriend,
  deleteInviteLink,
  deleteStaffAccount,
  getAdminSettings,
  getAllUsers,
  getAssignedServiceChatUserId,
  getConversations,
  getInviteLinkByCode,
  getMessagesByIds,
  getMessages,
  getOrCreateDirectConversation,
  getOrCreateUser,
  getOrCreateUserWithNickname,
  getStaffById,
  getStaffPublicById,
  getUserByPhone,
  getVisibleInviteLinks,
  getVisibleStaff,
  getUsers,
  recallMessage,
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
const phoneSchema = z.string().trim().min(5).max(20).regex(/^[0-9+\-\s]+$/);
const credentialSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/);
const uploadDir = join(process.cwd(), "uploads");
mkdirSync(uploadDir, { recursive: true });

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
app.use("/uploads", express.static(uploadDir));

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/login", (request, response) => {
  const parsed = z.object({ phone: phoneSchema, inviteCode: z.string().trim().max(40).optional() }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "手机号格式不正确" });
    return;
  }

  const normalizedPhone = parsed.data.phone.replace(/\s+/g, "");
  const existingUser = getUserByPhone(normalizedPhone);
  if (existingUser && existingUser.status !== "active") {
    response.status(403).json({ error: "账号已被后台禁用" });
    return;
  }
  const invite = parsed.data.inviteCode ? getInviteLinkByCode(parsed.data.inviteCode) : null;
  if (existingUser && !getAssignedServiceChatUserId(existingUser.id)) {
    response.status(403).json({ error: "未匹配专属客服" });
    return;
  }
  if (!existingUser && (!invite || invite.status !== "active")) {
    response.status(403).json({ error: "未匹配专属客服" });
    return;
  }

  const wasExisting = Boolean(existingUser);
  const inviteNickname = wasExisting ? null : createInviteNickname(parsed.data.inviteCode ?? null);
  const user = inviteNickname ? getOrCreateUserWithNickname(normalizedPhone, inviteNickname) : getOrCreateUser(normalizedPhone);
  const inviteAssignment = assignCustomerToInvite(user.id, parsed.data.inviteCode ?? null);
  const serviceChatUserId = inviteAssignment?.owner.chat_user_id ?? null;
  const settings = inviteAssignment
    ? {
        autoReplyEnabled: Boolean(inviteAssignment.invite.auto_reply_enabled),
        autoReplyText: inviteAssignment.invite.auto_reply_text,
      }
    : getAdminSettings();
  const senderUser = serviceChatUserId ? getAllUsers().find((item) => item.id === serviceChatUserId) : getAllUsers()[0];
  if (!wasExisting && settings.autoReplyEnabled && senderUser && senderUser.id !== user.id) {
    try {
      const conversationId = getOrCreateDirectConversation(senderUser.id, user.id);
      const body = settings.autoReplyText.replace(/\{nickname\}/g, user.nickname);
      const message = createMessage({
        conversationId,
        senderId: senderUser.id,
        body,
        clientId: `${senderUser.id}-auto-${Date.now()}-${crypto.randomUUID()}`,
      });
      io.to(`conversation:${conversationId}`).emit("message:new", message);
      io.emit("conversation:changed", { conversationId });
    } catch {
      // Auto reply should never block login.
    }
  }
  response.json({ user });
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
      customerPrefix: z.string().trim().max(12).optional().nullable(),
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
  if (!conversationId || !userId) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  try {
    response.json({ messages: getMessages(conversationId, userId) });
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
    io.to(`conversation:${conversationId}`).emit("message:new", message);
    io.emit("conversation:changed", { conversationId });
    response.json({ message });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "发送失败" });
  }
});

app.post("/api/conversations/:id/uploads", upload.single("file"), (request, response) => {
  const conversationId = Number(request.params.id);
  const userId = Number(request.body.userId);
  const file = request.file;

  if (!conversationId || !userId || !file) {
    response.status(400).json({ error: "参数不正确" });
    return;
  }

  const type = file.mimetype.startsWith("video/") ? "video" : "image";
  const body = JSON.stringify({
    url: `/uploads/${file.filename}`,
    name: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
  });

  try {
    const message = createMessage({
      conversationId,
      senderId: userId,
      type,
      body,
      clientId: `${userId}-${Date.now()}-${crypto.randomUUID()}`,
    });
    io.to(`conversation:${conversationId}`).emit("message:new", message);
    io.emit("conversation:changed", { conversationId });
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

    io.to(`conversation:${targetConversationId}`).emit("message:new", created.at(-1));
    io.emit("conversation:changed", { conversationId: targetConversationId });
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
