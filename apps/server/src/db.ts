import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..", "..");
const dataDir = join(rootDir, "data");

mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL,
    avatar_url TEXT,
    sequence_number INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'direct',
    title TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    unread_count INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_muted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    body TEXT NOT NULL,
    client_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_for_sender INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    edited_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS staff_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    parent_id INTEGER,
    chat_user_id INTEGER,
    avatar_url TEXT,
    retention_popup_enabled INTEGER NOT NULL DEFAULT 0,
    retention_popup_text TEXT NOT NULL DEFAULT '跟着客服操作完，至少可得1.5元。',
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES staff_accounts(id),
    FOREIGN KEY (chat_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invite_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    owner_staff_id INTEGER NOT NULL,
    auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
    auto_reply_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    visits INTEGER NOT NULL DEFAULT 0,
    customers INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_staff_id) REFERENCES staff_accounts(id),
    FOREIGN KEY (created_by) REFERENCES staff_accounts(id)
  );

  CREATE TABLE IF NOT EXISTS invite_link_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_link_id INTEGER NOT NULL,
    user_id INTEGER,
    visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (invite_link_id) REFERENCES invite_links(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS customer_assignments (
    user_id INTEGER PRIMARY KEY,
    staff_id INTEGER NOT NULL,
    invite_link_id INTEGER,
    remark_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (staff_id) REFERENCES staff_accounts(id),
    FOREIGN KEY (invite_link_id) REFERENCES invite_links(id)
  );

  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (staff_id) REFERENCES staff_accounts(id)
  );
`);

const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
const messageColumnNames = new Set(messageColumns.map((column) => column.name));
if (!messageColumnNames.has("revoked_at")) {
  db.prepare("ALTER TABLE messages ADD COLUMN revoked_at TEXT").run();
}
if (!messageColumnNames.has("edited_at")) {
  db.prepare("ALTER TABLE messages ADD COLUMN edited_at TEXT").run();
}

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
const userColumnNames = new Set(userColumns.map((column) => column.name));
if (!userColumnNames.has("avatar_url")) {
  db.prepare("ALTER TABLE users ADD COLUMN avatar_url TEXT").run();
}
if (!userColumnNames.has("deleted_at")) {
  db.prepare("ALTER TABLE users ADD COLUMN deleted_at TEXT").run();
}

const staffColumns = db.prepare("PRAGMA table_info(staff_accounts)").all() as Array<{ name: string }>;
const staffColumnNames = new Set(staffColumns.map((column) => column.name));
if (!staffColumnNames.has("deleted_at")) {
  db.prepare("ALTER TABLE staff_accounts ADD COLUMN deleted_at TEXT").run();
}
if (!staffColumnNames.has("avatar_url")) {
  db.prepare("ALTER TABLE staff_accounts ADD COLUMN avatar_url TEXT").run();
}
if (!staffColumnNames.has("retention_popup_enabled")) {
  db.prepare("ALTER TABLE staff_accounts ADD COLUMN retention_popup_enabled INTEGER NOT NULL DEFAULT 0").run();
}
if (!staffColumnNames.has("retention_popup_text")) {
  db.prepare("ALTER TABLE staff_accounts ADD COLUMN retention_popup_text TEXT NOT NULL DEFAULT '跟着客服操作完，至少可得1.5元。'").run();
}

const inviteColumns = db.prepare("PRAGMA table_info(invite_links)").all() as Array<{ name: string }>;
const inviteColumnNames = new Set(inviteColumns.map((column) => column.name));
if (!inviteColumnNames.has("deleted_at")) {
  db.prepare("ALTER TABLE invite_links ADD COLUMN deleted_at TEXT").run();
}
db.prepare("CREATE INDEX IF NOT EXISTS idx_invite_link_visits_link_time ON invite_link_visits(invite_link_id, visited_at)").run();

const assignmentColumns = db.prepare("PRAGMA table_info(customer_assignments)").all() as Array<{ name: string }>;
const assignmentColumnNames = new Set(assignmentColumns.map((column) => column.name));
if (!assignmentColumnNames.has("remark_name")) {
  db.prepare("ALTER TABLE customer_assignments ADD COLUMN remark_name TEXT").run();
}

export type UserRow = {
  id: number;
  phone: string;
  nickname: string;
  avatar_url: string | null;
  sequence_number: number;
  status: string;
  deleted_at: string | null;
  created_at: string;
  last_seen_at: string | null;
};

export type ConversationRow = {
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

export type MessageRow = {
  id: number;
  conversation_id: number;
  sender_id: number;
  type: string;
  body: string;
  client_id: string;
  created_at: string;
  deleted_for_sender: number;
  revoked_at: string | null;
  edited_at: string | null;
  sender_nickname: string;
  sender_avatar_url: string | null;
};

export type NewMessageInput = {
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string;
  type?: "text" | "image" | "video" | "forward_bundle";
};

export type AppSettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

export type StaffRole = "super_admin" | "admin" | "service";

export type StaffRow = {
  id: number;
  username: string;
  password: string;
  display_name: string;
  role: StaffRole;
  status: string;
  parent_id: number | null;
  chat_user_id: number | null;
  avatar_url: string | null;
  retention_popup_enabled: number;
  retention_popup_text: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StaffPublicRow = Omit<StaffRow, "password"> & {
  parent_name: string | null;
  chat_nickname: string | null;
};

export type InviteLinkRow = {
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
  deleted_at: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
  owner_name: string;
  owner_role: StaffRole;
};

export type QuickReplyRow = {
  id: number;
  staff_id: number;
  title: string;
  content: string;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const defaultAutoReply =
  "{nickname} 你好抖音评论 0.3元一条有效评论，没有数量限制。24小时都可以发 当天晚上10点前统一结算。";

function createRandomCustomerNickname() {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const length = 3 + Math.floor(Math.random() * 3);
    let nickname = "";
    for (let index = 0; index < length; index += 1) {
      nickname += letters[Math.floor(Math.random() * letters.length)];
    }
    const existing = db.prepare("SELECT 1 FROM users WHERE nickname = ? AND deleted_at IS NULL").get(nickname);
    if (!existing) return nickname;
  }
  return `u${Date.now().toString(36).slice(-4)}`.slice(0, 5);
}

db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('auto_reply_enabled', '1')").run();
db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('auto_reply_text', ?)").run(defaultAutoReply);

function ensureSuperAdmin() {
  let chatUser = db.prepare("SELECT * FROM users WHERE sequence_number = 1").get() as UserRow | undefined;
  if (!chatUser) {
    const result = db
      .prepare("INSERT INTO users (phone, nickname, sequence_number, last_seen_at) VALUES ('admin', 'A1', 1, CURRENT_TIMESTAMP)")
      .run();
    chatUser = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid) as UserRow;
  }

  db.prepare(`
    INSERT INTO staff_accounts (username, password, display_name, role, chat_user_id)
    VALUES ('admin', '000000', '超级管理员', 'super_admin', ?)
    ON CONFLICT(username) DO UPDATE SET
      role = 'super_admin',
      display_name = '超级管理员',
      chat_user_id = COALESCE(staff_accounts.chat_user_id, excluded.chat_user_id),
      updated_at = CURRENT_TIMESTAMP
  `).run(chatUser.id);
}

ensureSuperAdmin();

function syncServiceChatNicknames() {
  db.prepare(`
    UPDATE users
    SET nickname = (
      SELECT staff_accounts.display_name
      FROM staff_accounts
      WHERE staff_accounts.chat_user_id = users.id
        AND staff_accounts.role = 'service'
    )
    WHERE id IN (
      SELECT chat_user_id
      FROM staff_accounts
      WHERE role = 'service'
        AND chat_user_id IS NOT NULL
    )
  `).run();
}

syncServiceChatNicknames();

export function getOrCreateUser(phone: string): UserRow {
  const existing = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as UserRow | undefined;
  if (existing) {
    db.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id) as UserRow;
  }

  const nextSequence = ((db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS value FROM users").get() as { value: number }).value);
  const nickname = createRandomCustomerNickname();
  const result = db
    .prepare("INSERT INTO users (phone, nickname, sequence_number, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
    .run(phone, nickname, nextSequence);

  return db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid) as UserRow;
}

export function getOrCreateUserWithNickname(phone: string, nickname?: string): UserRow {
  const existing = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as UserRow | undefined;
  if (existing) {
    db.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id) as UserRow;
  }

  const create = db.transaction(() => {
    const nextSequence = (db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS value FROM users").get() as { value: number }).value;
    const nextNickname = nickname ?? createRandomCustomerNickname();
    const result = db
      .prepare("INSERT INTO users (phone, nickname, sequence_number, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
      .run(phone, nextNickname, nextSequence);
    return Number(result.lastInsertRowid);
  });

  return db.prepare("SELECT * FROM users WHERE id = ?").get(create()) as UserRow;
}

export function getUserByPhone(phone: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE phone = ? AND deleted_at IS NULL").get(phone) as UserRow | undefined) ?? null;
}

export function getUserById(userId: number): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(userId) as UserRow | undefined) ?? null;
}

export function assertActiveUser(userId: number) {
  const user = getUserById(userId);
  if (!user) throw new Error("用户不存在");
  if (user.status !== "active") throw new Error("账号已被后台禁用");
  return user;
}

export function getUsers(currentUserId: number): UserRow[] {
  const currentUser = assertActiveUser(currentUserId);
  const serviceAccount = db
    .prepare("SELECT * FROM staff_accounts WHERE chat_user_id = ? AND role = 'service' AND deleted_at IS NULL AND status = 'active'")
    .get(currentUserId) as StaffRow | undefined;

  const baseHiddenPeerSql = `
    SELECT CASE WHEN cm1.user_id = @currentUserId THEN cm2.user_id ELSE cm1.user_id END
    FROM conversation_members cm1
    JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id AND cm2.user_id != cm1.user_id
    JOIN conversations c ON c.id = cm1.conversation_id AND c.type = 'direct'
    WHERE cm1.user_id = @currentUserId
      AND cm1.deleted_at IS NOT NULL
  `;

  if (serviceAccount) {
    return db
      .prepare(`
        SELECT
          users.id,
          users.phone,
          COALESCE(NULLIF(ca.remark_name, ''), users.nickname) AS nickname,
          COALESCE(staff_avatar.avatar_url, users.avatar_url) AS avatar_url,
          users.sequence_number,
          users.status,
          users.created_at,
          users.last_seen_at
        FROM users
        JOIN customer_assignments ca ON ca.user_id = users.id
        LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
        WHERE ca.staff_id = @staffId
          AND users.status = 'active'
          AND users.id NOT IN (${baseHiddenPeerSql})
        ORDER BY users.sequence_number ASC
      `)
      .all({ currentUserId, staffId: serviceAccount.id }) as UserRow[];
  }

  const assignedService = db
    .prepare(`
      SELECT staff.chat_user_id AS chat_user_id
      FROM customer_assignments ca
      JOIN staff_accounts staff ON staff.id = ca.staff_id
      WHERE ca.user_id = ?
        AND staff.deleted_at IS NULL
        AND staff.status = 'active'
        AND staff.chat_user_id IS NOT NULL
      LIMIT 1
    `)
    .get(currentUserId) as { chat_user_id: number } | undefined;
  if (!assignedService?.chat_user_id) {
    throw new Error("未匹配专属客服");
  }

  return db
    .prepare(`
      SELECT
        users.id,
        users.phone,
        users.nickname,
        COALESCE(staff_avatar.avatar_url, users.avatar_url) AS avatar_url,
        users.sequence_number,
        users.status,
        users.deleted_at,
        users.created_at,
        users.last_seen_at
      FROM users
      LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
      WHERE users.id = @peerId
        AND users.id != @currentUserId
        AND users.status = 'active'
        AND users.id NOT IN (
          ${baseHiddenPeerSql}
        )
      ORDER BY sequence_number ASC
    `)
    .all({ currentUserId: currentUser.id, peerId: assignedService.chat_user_id }) as UserRow[];
}

export function getAllUsers(): UserRow[] {
  return db.prepare("SELECT * FROM users WHERE deleted_at IS NULL ORDER BY sequence_number ASC").all() as UserRow[];
}

export function setUserStatus(userId: number, status: "active" | "disabled"): UserRow {
  const user = getUserById(userId);
  if (!user) throw new Error("用户不存在");
  if (user.sequence_number === 1 && status === "disabled") throw new Error("A1 是自动回复账号，不能禁用");
  if (user.phone.startsWith("staff:")) throw new Error("客服账号不能在客户列表操作");
  const result = db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  if (result.changes === 0) throw new Error("用户不存在");
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
}

function assertEditableCustomerIds(userIds: number[]) {
  const uniqueIds = Array.from(new Set(userIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) throw new Error("请选择客户");
  const placeholders = uniqueIds.map(() => "?").join(",");
  const users = db.prepare(`SELECT * FROM users WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...uniqueIds) as UserRow[];
  if (users.length !== uniqueIds.length) throw new Error("部分客户不存在");
  const invalid = users.find((user) => user.sequence_number === 1 || user.phone.startsWith("staff:"));
  if (invalid) throw new Error("包含不能操作的账号");
  return uniqueIds;
}

export function batchSetUserStatus(userIds: number[], status: "active" | "disabled") {
  const editableIds = assertEditableCustomerIds(userIds);
  const placeholders = editableIds.map(() => "?").join(",");
  db.prepare(`UPDATE users SET status = ? WHERE id IN (${placeholders})`).run(status, ...editableIds);
  return editableIds.length;
}

export function batchDeleteUsers(userIds: number[]) {
  const editableIds = assertEditableCustomerIds(userIds);
  const placeholders = editableIds.map(() => "?").join(",");
  db.prepare(`UPDATE users SET status = 'disabled', deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...editableIds);
  return editableIds.length;
}

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT * FROM app_settings WHERE key = ?").get(key) as AppSettingRow | undefined;
  return row?.value ?? null;
}

export function getAdminSettings() {
  return {
    autoReplyEnabled: getSetting("auto_reply_enabled") !== "0",
    autoReplyText: getSetting("auto_reply_text") ?? defaultAutoReply,
  };
}

export function updateAdminSettings(input: { autoReplyEnabled: boolean; autoReplyText: string }) {
  const update = db.transaction(() => {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('auto_reply_enabled', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(input.autoReplyEnabled ? "1" : "0");

    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('auto_reply_text', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(input.autoReplyText);
  });
  update();
  return getAdminSettings();
}

function staffSelectSql() {
  return `
    SELECT
      staff_accounts.id,
      staff_accounts.username,
      staff_accounts.display_name,
      staff_accounts.role,
      staff_accounts.status,
      staff_accounts.parent_id,
      staff_accounts.chat_user_id,
      staff_accounts.avatar_url,
      staff_accounts.retention_popup_enabled,
      staff_accounts.retention_popup_text,
      staff_accounts.deleted_at,
      staff_accounts.created_at,
      staff_accounts.updated_at,
      parent.display_name AS parent_name,
      users.nickname AS chat_nickname
    FROM staff_accounts
    LEFT JOIN staff_accounts parent ON parent.id = staff_accounts.parent_id
    LEFT JOIN users ON users.id = staff_accounts.chat_user_id
  `;
}

export function getStaffByUsername(username: string): StaffRow | null {
  return (db.prepare("SELECT * FROM staff_accounts WHERE username = ? AND deleted_at IS NULL").get(username) as StaffRow | undefined) ?? null;
}

export function getStaffById(staffId: number): StaffRow | null {
  return (db.prepare("SELECT * FROM staff_accounts WHERE id = ? AND deleted_at IS NULL").get(staffId) as StaffRow | undefined) ?? null;
}

export function authenticateStaff(username: string, password: string): StaffPublicRow {
  const staff = getStaffByUsername(username);
  if (!staff || staff.password !== password) throw new Error("账号或密码不正确");
  if (staff.status !== "active") throw new Error("后台账号已禁用");
  return getStaffPublicById(staff.id);
}

export function getStaffPublicById(staffId: number): StaffPublicRow {
  const staff = db.prepare(`${staffSelectSql()} WHERE staff_accounts.id = ?`).get(staffId) as StaffPublicRow | undefined;
  if (!staff) throw new Error("后台账号不存在");
  return staff;
}

export function assertStaffAccess(staffId: number, allowedRoles?: StaffRole[]) {
  const staff = getStaffById(staffId);
  if (!staff) throw new Error("后台账号不存在");
  if (staff.status !== "active") throw new Error("后台账号已禁用");
  if (allowedRoles && !allowedRoles.includes(staff.role)) throw new Error("没有权限");
  return staff;
}

export function getVisibleStaff(staffId: number): StaffPublicRow[] {
  const staff = assertStaffAccess(staffId);
  if (staff.role === "super_admin") {
    return db
      .prepare(`${staffSelectSql()} WHERE staff_accounts.role IN ('super_admin', 'service') AND staff_accounts.deleted_at IS NULL ORDER BY staff_accounts.id ASC`)
      .all() as StaffPublicRow[];
  }
  return [getStaffPublicById(staff.id)];
}

export function createStaffAccount(input: {
  actorId: number;
  username: string;
  password: string;
  displayName: string;
  role: "service";
  parentId?: number | null;
}) {
  const actor = assertStaffAccess(input.actorId, ["super_admin"]);

  const create = db.transaction(() => {
    let chatUserId: number | null = null;
    const nextSequence = (db.prepare("SELECT COALESCE(MAX(sequence_number), 0) + 1 AS value FROM users").get() as { value: number }).value;
    const nickname = input.displayName;
    const phone = `staff:${input.username}`;
    const chatUser = db
      .prepare("INSERT INTO users (phone, nickname, sequence_number, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
      .run(phone, nickname, nextSequence);
    chatUserId = Number(chatUser.lastInsertRowid);

    const staff = db
      .prepare(`
        INSERT INTO staff_accounts (username, password, display_name, role, parent_id, chat_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(input.username, input.password, input.displayName, "service", actor.id, chatUserId);

    return Number(staff.lastInsertRowid);
  });

  return getStaffPublicById(create());
}

export function updateStaffAvatar(actorId: number, staffId: number, avatarUrl: string) {
  assertStaffAccess(actorId, ["super_admin"]);
  const target = getStaffById(staffId);
  if (!target) throw new Error("客服不存在");
  if (target.role !== "service") throw new Error("只能设置客服头像");
  const update = db.transaction(() => {
    db.prepare("UPDATE staff_accounts SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(avatarUrl, staffId);
    if (target.chat_user_id) {
      db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, target.chat_user_id);
    }
  });
  update();
  return getStaffPublicById(staffId);
}

export function updateStaffRetentionPopup(
  actorId: number,
  staffId: number,
  input: { enabled: boolean; text: string },
) {
  assertStaffAccess(actorId, ["super_admin"]);
  const target = getStaffById(staffId);
  if (!target) throw new Error("客服不存在");
  if (target.role !== "service") throw new Error("只能设置客服弹框");
  const text = input.text.trim();
  if (input.enabled && !text) throw new Error("请输入弹框内容");
  db.prepare(`
    UPDATE staff_accounts
    SET retention_popup_enabled = ?, retention_popup_text = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(input.enabled ? 1 : 0, text || "跟着客服操作完，至少可得1.5元。", staffId);
  return getStaffPublicById(staffId);
}

export function updateCustomerRemark(actorUserId: number, customerUserId: number, remarkName: string) {
  assertActiveUser(actorUserId);
  const service = getActiveServiceByChatUserId(actorUserId);
  if (!service) throw new Error("只有客服可以备注客户");
  const normalizedRemark = remarkName.trim();
  const result = db
    .prepare("UPDATE customer_assignments SET remark_name = ? WHERE user_id = ? AND staff_id = ?")
    .run(normalizedRemark || null, customerUserId, service.id);
  if (result.changes === 0) throw new Error("客户不属于当前客服");
}

export function getQuickReplies(actorUserId: number): QuickReplyRow[] {
  assertActiveUser(actorUserId);
  const service = getActiveServiceByChatUserId(actorUserId);
  if (!service) throw new Error("只有客服可以使用快捷语");
  return db
    .prepare(`
      SELECT *
      FROM quick_replies
      WHERE staff_id = ?
        AND deleted_at IS NULL
      ORDER BY sort_order ASC, id DESC
    `)
    .all(service.id) as QuickReplyRow[];
}

export function createQuickReply(actorUserId: number, input: { title: string; content: string }): QuickReplyRow {
  assertActiveUser(actorUserId);
  const service = getActiveServiceByChatUserId(actorUserId);
  if (!service) throw new Error("只有客服可以配置快捷语");
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM quick_replies WHERE staff_id = ? AND deleted_at IS NULL")
    .get(service.id) as { value: number };
  const result = db
    .prepare("INSERT INTO quick_replies (staff_id, title, content, sort_order) VALUES (?, ?, ?, ?)")
    .run(service.id, input.title.trim(), input.content.trim(), maxOrder.value);
  return db.prepare("SELECT * FROM quick_replies WHERE id = ?").get(Number(result.lastInsertRowid)) as QuickReplyRow;
}

export function updateQuickReply(actorUserId: number, replyId: number, input: { title: string; content: string }): QuickReplyRow {
  assertActiveUser(actorUserId);
  const service = getActiveServiceByChatUserId(actorUserId);
  if (!service) throw new Error("只有客服可以配置快捷语");
  const result = db
    .prepare(`
      UPDATE quick_replies
      SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND staff_id = ?
        AND deleted_at IS NULL
    `)
    .run(input.title.trim(), input.content.trim(), replyId, service.id);
  if (result.changes === 0) throw new Error("快捷语不存在");
  return db.prepare("SELECT * FROM quick_replies WHERE id = ?").get(replyId) as QuickReplyRow;
}

export function deleteQuickReply(actorUserId: number, replyId: number) {
  assertActiveUser(actorUserId);
  const service = getActiveServiceByChatUserId(actorUserId);
  if (!service) throw new Error("只有客服可以配置快捷语");
  const result = db
    .prepare("UPDATE quick_replies SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND staff_id = ? AND deleted_at IS NULL")
    .run(replyId, service.id);
  if (result.changes === 0) throw new Error("快捷语不存在");
}

export function reorderQuickReplies(actorUserId: number, replyIds: number[]): QuickReplyRow[] {
  assertActiveUser(actorUserId);
  const service = getActiveServiceByChatUserId(actorUserId);
  if (!service) throw new Error("只有客服可以配置快捷语");
  const existing = db
    .prepare("SELECT id FROM quick_replies WHERE staff_id = ? AND deleted_at IS NULL")
    .all(service.id) as Array<{ id: number }>;
  const existingIds = new Set(existing.map((item) => item.id));
  const uniqueIds = Array.from(new Set(replyIds));
  if (uniqueIds.length !== existingIds.size || uniqueIds.some((id) => !existingIds.has(id))) {
    throw new Error("快捷语顺序不完整");
  }
  const update = db.transaction(() => {
    uniqueIds.forEach((id, index) => {
      db.prepare("UPDATE quick_replies SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND staff_id = ?").run(index + 1, id, service.id);
    });
  });
  update();
  return getQuickReplies(actorUserId);
}

export function setStaffStatus(actorId: number, staffId: number, status: "active" | "disabled") {
  const actor = assertStaffAccess(actorId, ["super_admin"]);
  const target = getStaffById(staffId);
  if (!target) throw new Error("后台账号不存在");
  if (target.role === "super_admin") throw new Error("超级管理员不能禁用");
  db.prepare("UPDATE staff_accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, staffId);
  return getStaffPublicById(staffId);
}

export function deleteStaffAccount(actorId: number, staffId: number) {
  assertStaffAccess(actorId, ["super_admin"]);
  const target = getStaffById(staffId);
  if (!target) throw new Error("客服不存在");
  if (target.role === "super_admin") throw new Error("超级管理员不能删除");
  db.prepare("UPDATE staff_accounts SET status = 'disabled', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(staffId);
  db.prepare("UPDATE invite_links SET status = 'disabled', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE owner_staff_id = ? AND deleted_at IS NULL").run(staffId);
  if (target.chat_user_id) {
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(target.chat_user_id);
  }
}

export function changeStaffPassword(staffId: number, currentPassword: string, nextPassword: string) {
  const staff = assertStaffAccess(staffId);
  if (staff.password !== currentPassword) throw new Error("原密码不正确");
  db.prepare("UPDATE staff_accounts SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextPassword, staffId);
}

export function getVisibleInviteLinks(staffId: number): InviteLinkRow[] {
  const staff = assertStaffAccess(staffId);
  let sql = `
    SELECT
      invite_links.*,
      COALESCE(today_visits.value, 0) AS today_visits,
      owner.display_name AS owner_name,
      owner.role AS owner_role
    FROM invite_links
    LEFT JOIN staff_accounts owner ON owner.id = invite_links.owner_staff_id
    LEFT JOIN (
      SELECT invite_link_id, COUNT(*) AS value
      FROM invite_link_visits
      WHERE DATE(visited_at, 'localtime') = DATE('now', 'localtime')
      GROUP BY invite_link_id
    ) today_visits ON today_visits.invite_link_id = invite_links.id
  `;
  const params: number[] = [];
  sql += " WHERE invite_links.deleted_at IS NULL";
  if (staff.role === "service") {
    sql += " AND owner.id = ?";
    params.push(staff.id);
  }
  sql += " ORDER BY invite_links.id DESC";
  return db.prepare(sql).all(...params) as InviteLinkRow[];
}

export function getInviteLinkByCode(code: string): InviteLinkRow | null {
  return (
    (db
      .prepare(`
        SELECT
          invite_links.*,
          COALESCE(today_visits.value, 0) AS today_visits,
          owner.display_name AS owner_name,
          owner.role AS owner_role
        FROM invite_links
        JOIN staff_accounts owner ON owner.id = invite_links.owner_staff_id
        LEFT JOIN (
          SELECT invite_link_id, COUNT(*) AS value
          FROM invite_link_visits
          WHERE DATE(visited_at, 'localtime') = DATE('now', 'localtime')
          GROUP BY invite_link_id
        ) today_visits ON today_visits.invite_link_id = invite_links.id
        WHERE invite_links.code = ?
          AND invite_links.deleted_at IS NULL
    `)
      .get(code) as InviteLinkRow | undefined) ?? null
  );
}

export function createInviteLink(input: {
  actorId: number;
  title: string;
  ownerStaffId: number;
  autoReplyEnabled: boolean;
  autoReplyText: string;
}) {
  const actor = assertStaffAccess(input.actorId, ["super_admin", "service"]);
  const owner = getStaffById(input.ownerStaffId);
  if (!owner || owner.role !== "service" || owner.status !== "active") throw new Error("链接必须绑定启用中的客服");
  if (actor.role === "service" && owner.id !== actor.id) throw new Error("客服只能给自己创建链接");

  const code = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const result = db
    .prepare(`
      INSERT INTO invite_links (code, title, owner_staff_id, auto_reply_enabled, auto_reply_text, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(code, input.title, owner.id, input.autoReplyEnabled ? 1 : 0, input.autoReplyText, actor.id);
  return getVisibleInviteLinks(actor.id).find((link) => link.id === Number(result.lastInsertRowid))!;
}

export function setInviteLinkStatus(actorId: number, linkId: number, status: "active" | "disabled") {
  const actor = assertStaffAccess(actorId, ["super_admin", "service"]);
  const link = db.prepare("SELECT * FROM invite_links WHERE id = ? AND deleted_at IS NULL").get(linkId) as InviteLinkRow | undefined;
  if (!link) throw new Error("链接不存在");
  const owner = getStaffById(link.owner_staff_id);
  if (!owner) throw new Error("链接归属不存在");
  if (actor.role === "service" && owner.id !== actor.id) throw new Error("没有权限");
  db.prepare("UPDATE invite_links SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, linkId);
}

export function updateInviteLink(input: {
  actorId: number;
  linkId: number;
  title: string;
  ownerStaffId: number;
  autoReplyEnabled: boolean;
  autoReplyText: string;
}) {
  const actor = assertStaffAccess(input.actorId, ["super_admin", "service"]);
  const link = db.prepare("SELECT * FROM invite_links WHERE id = ? AND deleted_at IS NULL").get(input.linkId) as InviteLinkRow | undefined;
  if (!link) throw new Error("链接不存在");
  const currentOwner = getStaffById(link.owner_staff_id);
  if (actor.role === "service" && (!currentOwner || currentOwner.id !== actor.id)) throw new Error("没有权限");
  const nextOwner = getStaffById(input.ownerStaffId);
  if (!nextOwner || nextOwner.role !== "service" || nextOwner.status !== "active") throw new Error("链接必须绑定启用中的客服");
  if (actor.role === "service" && nextOwner.id !== actor.id) throw new Error("客服只能绑定自己的链接");
  db
    .prepare(`
      UPDATE invite_links
      SET title = ?, owner_staff_id = ?, auto_reply_enabled = ?, auto_reply_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(input.title, nextOwner.id, input.autoReplyEnabled ? 1 : 0, input.autoReplyText, input.linkId);
  return getVisibleInviteLinks(actor.id).find((item) => item.id === input.linkId)!;
}

export function deleteInviteLink(actorId: number, linkId: number) {
  const actor = assertStaffAccess(actorId, ["super_admin", "service"]);
  const link = db.prepare("SELECT * FROM invite_links WHERE id = ? AND deleted_at IS NULL").get(linkId) as InviteLinkRow | undefined;
  if (!link) throw new Error("链接不存在");
  const owner = getStaffById(link.owner_staff_id);
  if (actor.role === "service") {
    if (!owner || owner.id !== actor.id) throw new Error("没有权限");
  }
  db.prepare("UPDATE invite_links SET status = 'disabled', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(linkId);
}

export function assignCustomerToInvite(userId: number, inviteCode: string | null) {
  if (!inviteCode) return null;
  const invite = getInviteLinkByCode(inviteCode);
  if (!invite || invite.status !== "active") return null;
  const owner = getStaffById(invite.owner_staff_id);
  if (!owner || owner.status !== "active" || !owner.chat_user_id) return null;

  db.prepare("UPDATE invite_links SET visits = visits + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(invite.id);
  db.prepare("INSERT INTO invite_link_visits (invite_link_id, user_id) VALUES (?, ?)").run(invite.id, userId);
  const existing = db
    .prepare(`
      SELECT
        ca.user_id,
        ca.staff_id,
        ca.invite_link_id,
        staff.status AS staff_status,
        staff.deleted_at AS staff_deleted_at
      FROM customer_assignments ca
      LEFT JOIN staff_accounts staff ON staff.id = ca.staff_id
      WHERE ca.user_id = ?
    `)
    .get(userId) as
    | {
        user_id: number;
        staff_id: number;
        invite_link_id: number | null;
        staff_status: string | null;
        staff_deleted_at: string | null;
      }
    | undefined;
  const shouldReplace =
    !existing ||
    !existing.staff_id ||
    existing.staff_status !== "active" ||
    Boolean(existing.staff_deleted_at);

  if (shouldReplace) {
    if (existing) {
      db.prepare("UPDATE customer_assignments SET staff_id = ?, invite_link_id = ? WHERE user_id = ?").run(owner.id, invite.id, userId);
    } else {
      db.prepare("INSERT INTO customer_assignments (user_id, staff_id, invite_link_id) VALUES (?, ?, ?)").run(userId, owner.id, invite.id);
    }
    db.prepare("UPDATE invite_links SET customers = customers + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(invite.id);
  } else if (existing.invite_link_id !== invite.id) {
    db.prepare("UPDATE customer_assignments SET invite_link_id = ? WHERE user_id = ?").run(invite.id, userId);
  }
  return { invite, owner };
}

export function createInviteNickname(inviteCode: string | null) {
  if (!inviteCode) return null;
  const invite = getInviteLinkByCode(inviteCode);
  if (!invite || invite.status !== "active") return null;
  const service = getStaffById(invite.owner_staff_id);
  if (!service || service.role !== "service") return null;
  return createRandomCustomerNickname();
}

function getActiveServiceByChatUserId(userId: number) {
  return db
    .prepare("SELECT * FROM staff_accounts WHERE chat_user_id = ? AND role = 'service' AND deleted_at IS NULL AND status = 'active'")
    .get(userId) as StaffRow | undefined;
}

export function getAssignedServiceChatUserId(customerUserId: number) {
  return (
    db
      .prepare(`
        SELECT staff.chat_user_id AS chat_user_id
        FROM customer_assignments ca
        JOIN staff_accounts staff ON staff.id = ca.staff_id
        WHERE ca.user_id = ?
          AND staff.deleted_at IS NULL
          AND staff.status = 'active'
          AND staff.chat_user_id IS NOT NULL
        LIMIT 1
      `)
      .get(customerUserId) as { chat_user_id: number } | undefined
  )?.chat_user_id ?? null;
}

export function getCustomerRetentionNotice(customerUserId: number) {
  const row = db
    .prepare(`
      SELECT staff.retention_popup_text AS text
      FROM customer_assignments ca
      JOIN staff_accounts staff ON staff.id = ca.staff_id
      WHERE ca.user_id = ?
        AND staff.deleted_at IS NULL
        AND staff.status = 'active'
        AND staff.role = 'service'
        AND staff.retention_popup_enabled = 1
      LIMIT 1
    `)
    .get(customerUserId) as { text: string } | undefined;
  return row?.text ? { text: row.text } : null;
}

function assertDirectChatAllowed(userA: number, userB: number) {
  if (userA === userB) return;

  const serviceA = getActiveServiceByChatUserId(userA);
  const serviceB = getActiveServiceByChatUserId(userB);
  if (serviceA) {
    const assigned = db.prepare("SELECT 1 FROM customer_assignments WHERE user_id = ? AND staff_id = ?").get(userB, serviceA.id);
    if (assigned) return;
    throw new Error("只能联系分配给自己的客户");
  }
  if (serviceB) {
    const assigned = db.prepare("SELECT 1 FROM customer_assignments WHERE user_id = ? AND staff_id = ?").get(userA, serviceB.id);
    if (assigned) return;
    throw new Error("只能联系自己的专属客服");
  }

  const serviceForA = getAssignedServiceChatUserId(userA);
  const serviceForB = getAssignedServiceChatUserId(userB);
  if (!serviceForA || !serviceForB) throw new Error("未匹配专属客服");
  if (serviceForA === userB || serviceForB === userA) return;
  throw new Error("未匹配专属客服");
}

export function getOrCreateDirectConversation(userA: number, userB: number): number {
  assertActiveUser(userA);
  assertActiveUser(userB);

  if (userA === userB) {
    const existing = db
      .prepare(`
        SELECT cm.conversation_id AS id
        FROM conversation_members cm
        JOIN conversations c ON c.id = cm.conversation_id
        WHERE c.type = 'self'
          AND cm.user_id = ?
        LIMIT 1
      `)
      .get(userA) as { id: number } | undefined;

    if (existing) return existing.id;

    const createSelf = db.transaction(() => {
      const conversation = db.prepare("INSERT INTO conversations (type, title) VALUES ('self', '自己')").run();
      const conversationId = Number(conversation.lastInsertRowid);
      db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)").run(conversationId, userA);
      return conversationId;
    });

    return createSelf();
  }

  assertDirectChatAllowed(userA, userB);

  const existing = db
    .prepare(`
      SELECT cm1.conversation_id AS id
      FROM conversation_members cm1
      JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
      JOIN conversations c ON c.id = cm1.conversation_id
      WHERE c.type = 'direct'
        AND cm1.user_id = ?
        AND cm2.user_id = ?
      LIMIT 1
    `)
    .get(userA, userB) as { id: number } | undefined;

  if (existing) return existing.id;

  const create = db.transaction(() => {
    const conversation = db.prepare("INSERT INTO conversations (type) VALUES ('direct')").run();
    const conversationId = Number(conversation.lastInsertRowid);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)").run(conversationId, userA);
    db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)").run(conversationId, userB);
    return conversationId;
  });

  return create();
}

export function setConversationPinned(conversationId: number, userId: number, pinned: boolean) {
  assertActiveUser(userId);
  const result = db
    .prepare("UPDATE conversation_members SET is_pinned = ? WHERE conversation_id = ? AND user_id = ?")
    .run(pinned ? 1 : 0, conversationId, userId);
  if (result.changes === 0) throw new Error("会话不存在");
}

export function deleteFriend(userId: number, peerId: number) {
  assertActiveUser(userId);
  if (userId === peerId) throw new Error("不能删除自己");
  const conversation = db
    .prepare(`
      SELECT cm1.conversation_id AS id
      FROM conversation_members cm1
      JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
      JOIN conversations c ON c.id = cm1.conversation_id
      WHERE c.type = 'direct'
        AND cm1.user_id = ?
        AND cm2.user_id = ?
      LIMIT 1
    `)
    .get(userId, peerId) as { id: number } | undefined;
  if (!conversation) throw new Error("好友不存在");
  db.prepare("UPDATE conversation_members SET deleted_at = CURRENT_TIMESTAMP, unread_count = 0, is_pinned = 0 WHERE conversation_id = ? AND user_id = ?").run(
    conversation.id,
    userId,
  );
  return conversation.id;
}

export function getDirectConversationPeerId(conversationId: number, userId: number) {
  assertActiveUser(userId);
  const row = db
    .prepare(`
      SELECT CASE WHEN cm1.user_id = ? THEN cm2.user_id ELSE cm1.user_id END AS peer_id
      FROM conversation_members cm1
      JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id AND cm2.user_id != cm1.user_id
      JOIN conversations c ON c.id = cm1.conversation_id AND c.type = 'direct'
      WHERE cm1.conversation_id = ?
        AND cm1.user_id = ?
        AND cm1.deleted_at IS NULL
      LIMIT 1
    `)
    .get(userId, conversationId, userId) as { peer_id: number } | undefined;
  return row?.peer_id ?? null;
}

export function getConversations(userId: number): ConversationRow[] {
  const currentUser = assertActiveUser(userId);
  const serviceAccount = db
    .prepare("SELECT * FROM staff_accounts WHERE chat_user_id = ? AND role = 'service' AND deleted_at IS NULL AND status = 'active'")
    .get(currentUser.id) as StaffRow | undefined;
  const assignedService = serviceAccount
    ? null
    : (db
        .prepare(`
          SELECT staff.chat_user_id AS chat_user_id
          FROM customer_assignments ca
          JOIN staff_accounts staff ON staff.id = ca.staff_id
          WHERE ca.user_id = ?
            AND staff.deleted_at IS NULL
            AND staff.status = 'active'
            AND staff.chat_user_id IS NOT NULL
          LIMIT 1
        `)
        .get(currentUser.id) as { chat_user_id: number } | undefined);
  const assignedChatUserId = assignedService?.chat_user_id;
  if (!serviceAccount && !assignedChatUserId) {
    throw new Error("未匹配专属客服");
  }
  const params = serviceAccount
    ? { userId: currentUser.id, staffId: serviceAccount.id, peerId: null }
    : { userId: currentUser.id, staffId: null, peerId: assignedChatUserId };

  return db
    .prepare(`
      SELECT
        c.id,
        c.type,
        c.title,
        cm.unread_count,
        cm.is_pinned,
        cm.is_muted,
        CASE WHEN m.revoked_at IS NOT NULL THEN '[撤回了一条消息]' ELSE m.body END AS last_message_body,
        m.created_at AS last_message_at,
        CASE WHEN c.type = 'self' THEN self_user.id ELSE peer.id END AS peer_id,
        CASE WHEN c.type = 'self' THEN self_user.phone ELSE peer.phone END AS peer_phone,
        CASE
          WHEN c.type = 'self' THEN self_user.nickname
          WHEN @staffId IS NOT NULL THEN COALESCE(NULLIF(display_assignment.remark_name, ''), peer.nickname)
          ELSE peer.nickname
        END AS peer_nickname,
        CASE
          WHEN c.type = 'self' THEN COALESCE(self_staff.avatar_url, self_user.avatar_url)
          ELSE COALESCE(peer_staff.avatar_url, peer.avatar_url)
        END AS peer_avatar_url,
        CASE WHEN c.type = 'self' THEN self_user.last_seen_at ELSE peer.last_seen_at END AS peer_last_seen_at
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = @userId
      JOIN users self_user ON self_user.id = cm.user_id
      LEFT JOIN staff_accounts self_staff ON self_staff.chat_user_id = self_user.id AND self_staff.deleted_at IS NULL
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages
        WHERE conversation_id = c.id
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 1
      )
      LEFT JOIN conversation_members peer_cm ON peer_cm.conversation_id = c.id AND peer_cm.user_id != @userId
      LEFT JOIN users peer ON peer.id = peer_cm.user_id
      LEFT JOIN staff_accounts peer_staff ON peer_staff.chat_user_id = peer.id AND peer_staff.deleted_at IS NULL
      LEFT JOIN customer_assignments display_assignment ON display_assignment.user_id = peer.id AND display_assignment.staff_id = @staffId
      WHERE cm.deleted_at IS NULL
        AND (
          c.type = 'self'
          OR (
            @staffId IS NOT NULL
            AND peer.id IN (
              SELECT ca.user_id
              FROM customer_assignments ca
              JOIN users assigned_user ON assigned_user.id = ca.user_id
              WHERE ca.staff_id = @staffId
                AND assigned_user.status = 'active'
            )
          )
          OR (
            @staffId IS NULL
            AND peer.id = @peerId
          )
        )
      ORDER BY cm.is_pinned DESC, datetime(COALESCE(m.created_at, c.created_at)) DESC
    `)
    .all(params) as ConversationRow[];
}

export function getMessages(
  conversationId: number,
  userId: number,
  options: { limit?: number; beforeMessageId?: number } = {},
): { messages: MessageRow[]; hasMore: boolean } {
  assertActiveUser(userId);
  const membership = db
    .prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
    .get(conversationId, userId);
  if (!membership) return { messages: [], hasMore: false };

  db.prepare("UPDATE conversation_members SET unread_count = 0 WHERE conversation_id = ? AND user_id = ?").run(conversationId, userId);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = db
    .prepare(`
      SELECT *
      FROM (
        SELECT messages.*, users.nickname AS sender_nickname, COALESCE(staff_avatar.avatar_url, users.avatar_url) AS sender_avatar_url
        FROM messages
        JOIN users ON users.id = messages.sender_id
        LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
        WHERE messages.conversation_id = @conversationId
          AND (@beforeMessageId IS NULL OR messages.id < @beforeMessageId)
        ORDER BY datetime(messages.created_at) DESC, messages.id DESC
        LIMIT @pageSize
      )
      ORDER BY datetime(created_at) ASC, id ASC
    `)
    .all({
      conversationId,
      beforeMessageId: options.beforeMessageId ?? null,
      pageSize: limit + 1,
    }) as MessageRow[];
  const hasMore = rows.length > limit;
  return { messages: hasMore ? rows.slice(1) : rows, hasMore };
}

export function getConversationMemberIds(conversationId: number): number[] {
  const rows = db
    .prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?")
    .all(conversationId) as Array<{ user_id: number }>;
  return rows.map((row) => row.user_id);
}

export function markConversationRead(conversationId: number, userId: number) {
  assertActiveUser(userId);
  const result = db
    .prepare("UPDATE conversation_members SET unread_count = 0 WHERE conversation_id = ? AND user_id = ?")
    .run(conversationId, userId);
  if (result.changes === 0) throw new Error("NOT_CONVERSATION_MEMBER");
}

export function createMessage(input: NewMessageInput): MessageRow {
  assertActiveUser(input.senderId);
  const create = db.transaction(() => {
    const membership = db
      .prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
      .get(input.conversationId, input.senderId);
    if (!membership) throw new Error("NOT_CONVERSATION_MEMBER");

    const result = db
      .prepare("INSERT INTO messages (conversation_id, sender_id, type, body, client_id) VALUES (?, ?, ?, ?, ?)")
      .run(input.conversationId, input.senderId, input.type ?? "text", input.body, input.clientId);

    db.prepare(`
      UPDATE conversation_members
      SET unread_count = unread_count + 1, deleted_at = NULL
      WHERE conversation_id = ? AND user_id != ?
    `).run(input.conversationId, input.senderId);

    db.prepare("UPDATE conversation_members SET deleted_at = NULL WHERE conversation_id = ? AND user_id = ?").run(
      input.conversationId,
      input.senderId,
    );

    return Number(result.lastInsertRowid);
  });

  const messageId = create();
  return db
    .prepare(`
      SELECT messages.*, users.nickname AS sender_nickname, COALESCE(staff_avatar.avatar_url, users.avatar_url) AS sender_avatar_url
      FROM messages
      JOIN users ON users.id = messages.sender_id
      LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
      WHERE messages.id = ?
    `)
    .get(messageId) as MessageRow;
}

export function getMessagesByIds(messageIds: number[], userId: number): MessageRow[] {
  assertActiveUser(userId);
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(",");
  return db
    .prepare(`
      SELECT messages.*, users.nickname AS sender_nickname, COALESCE(staff_avatar.avatar_url, users.avatar_url) AS sender_avatar_url
      FROM messages
      JOIN users ON users.id = messages.sender_id
      LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
      JOIN conversation_members cm ON cm.conversation_id = messages.conversation_id AND cm.user_id = ?
      WHERE messages.id IN (${placeholders})
        AND messages.revoked_at IS NULL
      ORDER BY datetime(messages.created_at) ASC, messages.id ASC
    `)
    .all(userId, ...messageIds) as MessageRow[];
}

export function recallMessage(messageId: number, userId: number): MessageRow {
  assertActiveUser(userId);
  const existing = db
    .prepare(`
      SELECT messages.*, users.nickname AS sender_nickname, COALESCE(staff_avatar.avatar_url, users.avatar_url) AS sender_avatar_url
      FROM messages
      JOIN users ON users.id = messages.sender_id
      LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
      JOIN conversation_members cm ON cm.conversation_id = messages.conversation_id AND cm.user_id = ?
      WHERE messages.id = ?
    `)
    .get(userId, messageId) as MessageRow | undefined;

  if (!existing) throw new Error("消息不存在");
  if (existing.sender_id !== userId) throw new Error("只能撤回自己发送的消息");
  if (existing.revoked_at) return existing;

  db.prepare("UPDATE messages SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(messageId);
  return db
    .prepare(`
      SELECT messages.*, users.nickname AS sender_nickname, COALESCE(staff_avatar.avatar_url, users.avatar_url) AS sender_avatar_url
      FROM messages
      JOIN users ON users.id = messages.sender_id
      LEFT JOIN staff_accounts staff_avatar ON staff_avatar.chat_user_id = users.id AND staff_avatar.deleted_at IS NULL
      WHERE messages.id = ?
    `)
    .get(messageId) as MessageRow;
}

export function touchUser(userId: number) {
  assertActiveUser(userId);
  db.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(userId);
}
