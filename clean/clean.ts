// file name: clean.ts
// TeleBox Next (mtcute) 版清理插件，功能对齐 Classic(teleproto) 版 clean v2.0.0：
// 已注销账号清理（私聊 / 群成员）、拉黑用户清理、被封禁实体解封。
import { Plugin } from "@utils/pluginBase";
import type { TelegramClient } from "@mtcute/node";
import type { MessageContext } from "@mtcute/dispatcher";
import type { tl } from "@mtcute/core";
import type {
  MtcuteInputChannel,
  MtcuteInputPeer,
  MtcuteLong,
} from "@utils/mtcuteTypes";
import Long from "long";
import { thtml as html } from "@mtcute/html-parser";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import { sleep } from "@utils/asyncHelpers";
import { logger } from "@utils/logger";
import { getErrorMessage } from "@utils/errorHelpers";
import { htmlEscape } from "@utils/htmlEscape";
import { safeGetMe } from "@utils/authGuards";
import { banUser, getBannedUsers, unbanUser } from "@utils/banUtils";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const PLUGIN_VERSION = "2.0.0";

/** channels.getParticipants 返回的原始 user 对象 */
type RawUser = tl.RawUser;

const HELP_TEXT = `🧹 <b>清理工具 Pro</b> <i>v${PLUGIN_VERSION}</i>

<b>📝 功能概述:</b>
• <b>删除账号清理</b>: 扫描并清理已注销/删除的账号
• <b>拉黑用户清理</b>: 解除双向拉黑状态
• <b>被封禁实体解封</b>: 解封群组中被封禁的用户/频道/群组

<b>🔧 命令列表:</b>

<u>删除账号清理:</u>
• <code>${mainPrefix}clean deleted pm</code> - 扫描私聊中的已注销账号
• <code>${mainPrefix}clean deleted pm rm</code> - 扫描并删除已注销账号的私聊
• <code>${mainPrefix}clean deleted member</code> - 扫描群组中的已注销账号
• <code>${mainPrefix}clean deleted member rm</code> - 扫描并清理群组已注销账号

<u>拉黑用户清理:</u>
• <code>${mainPrefix}clean blocked pm</code> - 清理拉黑用户（智能模式）
• <code>${mainPrefix}clean blocked pm all</code> - 清理所有拉黑用户（全量模式）

<u>被封禁实体解封:</u>
• <code>${mainPrefix}clean blocked member</code> - 解封自己封禁的实体
• <code>${mainPrefix}clean blocked member all</code> - 解封所有被封禁的实体

<u>群成员批量清理:</u>
• <code>${mainPrefix}clean_member</code> - 按未上线/未发言等模式清理群成员（详见其帮助）

<b>⚡ 智能清理模式:</b>
• 跳过机器人、诈骗账户、虚假账户
• 自动处理 API 限制
• 实时进度显示

<b>📊 数据统计:</b>
• 处理总数、成功数、失败数、跳过数
• 实体类型统计（用户/频道/群组）
• 清理成功率

<b>⚠️ 权限要求:</b>
• 群组操作需要管理员权限
• 封禁清理需要封禁用户权限
• 私聊清理仅操作自身对话`;

// ---------- 通用工具 ----------

async function editMessage(msg: MessageContext, text: string): Promise<void> {
  try {
    await msg.edit({ text: html(text) });
  } catch (error: unknown) {
    logger.error("[clean] 编辑消息失败:", error);
  }
}

async function sendError(msg: MessageContext, errorMsg: string): Promise<void> {
  await editMessage(msg, `❌ <b>错误:</b> ${htmlEscape(errorMsg)}`);
}

function parseFloodWait(errorText: string): number {
  return parseInt(errorText.match(/FLOOD_WAIT_(\d+)/)?.[1] || "60", 10) || 60;
}

async function handleFloodWait(msg: MessageContext, errorText: string): Promise<void> {
  const waitTime = parseFloodWait(errorText);
  await editMessage(msg, `⏳ 需要等待 ${waitTime} 秒后继续`);
  await sleep((waitTime + 1) * 1000);
}

async function handleError(msg: MessageContext, error: unknown): Promise<void> {
  logger.error("[clean] 错误:", error);
  const text = getErrorMessage(error);

  let errorMsg = `❌ <b>操作失败:</b> ${htmlEscape(text || "未知错误")}`;
  if (text.includes("FLOOD_WAIT")) {
    errorMsg = `⏳ <b>请求过于频繁</b>\n\n需要等待 ${parseFloodWait(text)} 秒后重试`;
  } else if (text.includes("CHAT_ADMIN_REQUIRED")) {
    errorMsg = "🔒 <b>权限不足</b>\n\n需要管理员权限";
  } else if (text.includes("USER_NOT_PARTICIPANT")) {
    errorMsg = "❌ <b>未加入群组</b>\n\n需要先加入群组";
  }

  await editMessage(msg, errorMsg);
}

async function safeDelete(msg: MessageContext): Promise<void> {
  try {
    await msg.delete({ revoke: true });
  } catch (error: unknown) {
    // 消息可能已被删除，忽略
    logger.info("[clean] 删除自身消息失败:", error);
  }
}

function getDynamicDelay(user: RawUser, includeAll: boolean, consecutiveErrors: number): number {
  let delay = 200;
  if (user.bot) delay = 1500;
  else if (user.scam || user.fake) delay = 800;
  if (includeAll) delay = Math.max(delay, 1000);
  if (consecutiveErrors > 0) delay = delay * (1 + consecutiveErrors * 0.5);
  return Math.min(delay, 5000);
}

function estimateRemainingTime(processed: number, total: number, elapsedMs: number): string {
  if (processed === 0 || total === 0) return "计算中...";
  const avgTimePerUser = elapsedMs / processed;
  const estimatedMs = avgTimePerUser * (total - processed);
  if (estimatedMs < 1000) return "即将完成";
  if (estimatedMs < 60000) return `约 ${Math.ceil(estimatedMs / 1000)} 秒`;
  return `约 ${Math.ceil(estimatedMs / 60000)} 分钟`;
}

// ---------- 已注销私聊清理 ----------

interface DeletedDialog {
  id: number;
  username?: string;
  peer: RawUser;
}

async function cleanDeletedPM(client: TelegramClient, msg: MessageContext, removeDialogs: boolean): Promise<void> {
  await editMessage(
    msg,
    removeDialogs
      ? "🔍 正在扫描并从对话列表中移除已注销账号..."
      : "🔍 正在扫描私聊已注销账号..."
  );

  const dialogByUserId = new Map<number, DeletedDialog>();

  // 归档对话也要扫，否则归档文件夹里的已注销会话会被漏掉
  const folders: Array<"exclude" | "only"> = ["exclude", "only"];
  for (const archived of folders) {
    try {
      for await (const dialog of client.iterDialogs({ archived })) {
        const peer = dialog.peer;
        if (peer.type !== "user" || !peer.isDeleted) continue;
        if (dialogByUserId.has(peer.id)) continue;
        dialogByUserId.set(peer.id, {
          id: peer.id,
          username: peer.username || "已注销账号",
          peer: peer.raw,
        });
      }
    } catch (error: unknown) {
      logger.error(`[clean] 获取对话失败 (archived=${archived}):`, error);
    }
  }

  const deletedUsers = Array.from(dialogByUserId.values());

  if (removeDialogs) {
    let removed = 0;
    let failed = 0;
    for (const target of deletedUsers) {
      try {
        // mode 'delete'：清空自身历史并将会话从列表移除。
        // 不用 revoke：已注销账号没有对端可撤销。
        await client.deleteHistory(target.peer, { mode: "delete" });
        removed++;
        await sleep(150);
      } catch (error: unknown) {
        failed++;
        const text = getErrorMessage(error);
        logger.error(`[clean] 无法移除对话 ${target.id}:`, text);
        if (text.includes("FLOOD_WAIT")) {
          await handleFloodWait(msg, text);
        }
      }
    }
    logger.info(`[clean] 已注销私聊移除完成: 成功 ${removed} / 失败 ${failed}`);
  }

  let result = "";
  if (deletedUsers.length === 0) {
    result = "✅ <b>扫描完成</b>\n\n对话列表中未发现已注销账号。";
  } else {
    result = removeDialogs
      ? `✅ <b>清理完成</b>\n\n已从列表移除 <code>${deletedUsers.length}</code> 个已注销对话:\n\n`
      : `✅ <b>扫描完成</b>\n\n共找到 <code>${deletedUsers.length}</code> 个已注销对话:\n\n`;

    deletedUsers.slice(0, 15).forEach((user) => {
      result += `• <a href="tg://user?id=${user.id}">已注销账号</a> (ID: <code>${user.id}</code>)\n`;
    });
    if (deletedUsers.length > 15) {
      result += `\n... 以及其他 ${deletedUsers.length - 15} 个会话\n`;
    }
    if (!removeDialogs) {
      result += `\n💡 使用 <code>${mainPrefix}clean deleted pm rm</code> 直接移除这些对话`;
    }
  }

  await editMessage(msg, result);
}

// ---------- 已注销群成员清理 ----------

async function checkBanPermission(client: TelegramClient, channel: MtcuteInputChannel): Promise<boolean> {
  const me = await safeGetMe(client);
  if (!me) return false;
  try {
    const result: any = await client.call({
      _: "channels.getParticipant",
      channel,
      participant: me.id as unknown as MtcuteInputPeer,
    });
    const participant = result?.participant;
    if (participant?._ === "channelParticipantCreator") return true;
    if (participant?._ === "channelParticipantAdmin") {
      return participant.adminRights?.banUsers ?? false;
    }
    return false;
  } catch (error: unknown) {
    const text = getErrorMessage(error);
    if (
      text.includes("CHAT_ADMIN_REQUIRED") ||
      text.includes("USER_NOT_PARTICIPANT") ||
      text.includes("PEER_ID_INVALID")
    ) {
      return false;
    }
    // 未知错误（如普通群不支持该构造器）交给实际调用去暴露
    logger.info("[clean] 封禁权限检查异常，跳过预检查:", error);
    return true;
  }
}

interface DeletedMemberEntry {
  id: number;
  username?: string;
  ok?: boolean;
  err?: string;
}

async function cleanDeletedMember(client: TelegramClient, msg: MessageContext, removeMembers: boolean): Promise<void> {
  if (!msg.chat || msg.chat.type === "user") {
    await sendError(msg, "此命令仅在群组中可用");
    return;
  }

  await editMessage(
    msg,
    removeMembers
      ? "🔍 正在扫描并清理群组已注销账号..."
      : "🔍 正在扫描群组已注销账号..."
  );

  const chatId = msg.chat.id;
  const chatEntity = (await client.resolvePeer(chatId)) as unknown as MtcuteInputChannel;

  if (removeMembers && !(await checkBanPermission(client, chatEntity))) {
    await sendError(msg, "没有封禁用户权限，无法执行清理");
    return;
  }

  let foundCount = 0;
  let removedCount = 0;
  let failedCount = 0;
  const deletedUsers: DeletedMemberEntry[] = [];

  let offset = 0;
  const limit = 200;
  let hasMore = true;
  while (hasMore) {
    const result: any = await client.call({
      _: "channels.getParticipants",
      channel: chatEntity,
      filter: { _: "channelParticipantsRecent" },
      offset,
      limit,
      hash: Long.fromNumber(0) as unknown as MtcuteLong,
    });
    const users = (result?.users ?? []) as RawUser[];
    if (users.length === 0) break;

    for (const user of users) {
      // 已注销账号：TL 字段 deleted，部分场景为 isDeleted
      if (!(user.deleted || (user as { isDeleted?: boolean }).isDeleted)) continue;

      foundCount++;
      const entry: DeletedMemberEntry = {
        id: Number(user.id),
        username: user.username || "已注销账号",
      };

      if (removeMembers) {
        try {
          // 必须传完整 user（含 accessHash）；只传裸 id 对已注销账号会失败
          const ok = await banUser(client, chatEntity, user);
          if (ok) {
            removedCount++;
            entry.ok = true;
            // 封禁后再解封，避免永久 ban 列表堆积（与 kickUser 一致）
            try {
              await unbanUser(client, chatEntity, user);
            } catch {
              /* 解封失败不影响已移出 */
            }
          } else {
            failedCount++;
            entry.ok = false;
            entry.err = "封禁接口返回失败";
          }
          await sleep(150);
        } catch (error: unknown) {
          const text = getErrorMessage(error);
          if (text.includes("FLOOD_WAIT")) {
            await handleFloodWait(msg, text);
          }
          failedCount++;
          entry.ok = false;
          entry.err = text;
        }
      }
      deletedUsers.push(entry);
    }

    if (users.length < limit) {
      hasMore = false;
    } else {
      offset += limit;
      await sleep(100);
    }
    if (offset > 50000) {
      logger.warn("[clean] 群成员扫描达到上限 50000 人");
      break;
    }
  }

  let result = "";
  if (foundCount === 0) {
    result = "✅ <b>扫描完成</b>\n\n此群组中没有发现已注销账号。";
  } else if (removeMembers) {
    result =
      `✅ <b>清理完成</b>\n\n` +
      `发现 <code>${foundCount}</code> 个已注销账号\n` +
      `成功移出 <code>${removedCount}</code> 个` +
      (failedCount ? ` · 失败 <code>${failedCount}</code> 个` : "") +
      `:\n\n`;
    deletedUsers.slice(0, 15).forEach((user) => {
      const mark = user.ok === false ? "❌" : "✅";
      result += `• ${mark} <a href="tg://user?id=${user.id}">${user.id}</a>${user.err ? ` · ${htmlEscape(user.err)}` : ""}\n`;
    });
    if (foundCount > 15) {
      result += `\n... 还有 ${foundCount - 15} 个未显示\n`;
    }
    if (failedCount) {
      result += `\n💡 失败常见原因：无 ban 权限、目标是管理员、或实体缺少 access_hash`;
    }
  } else {
    result = `✅ <b>扫描完成</b>\n\n此群组的已注销账号数: <code>${foundCount}</code>:\n\n`;
    deletedUsers.slice(0, 15).forEach((user) => {
      result += `• <a href="tg://user?id=${user.id}">${user.id}</a>\n`;
    });
    if (foundCount > 15) {
      result += `\n... 还有 ${foundCount - 15} 个未显示\n`;
    }
    result += `\n💡 使用 <code>${mainPrefix}clean deleted member rm</code> 清理这些已注销账号`;
  }

  await editMessage(msg, result);
}

// ---------- 拉黑用户清理 ----------

async function getBlockedPage(client: TelegramClient, offset: number, limit: number): Promise<any> {
  // 当前 TL 层 contacts.getBlocked 只有 offset/limit，没有 hash 字段
  return await client.call({
    _: "contacts.getBlocked",
    offset,
    limit,
  });
}

async function updateBlockedProgress(
  msg: MessageContext,
  processed: number,
  total: number,
  success: number,
  failed: number,
  skipped: number,
  includeAll: boolean,
  startTime: number
): Promise<void> {
  const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
  const filled = Math.round((percentage / 100) * 20);
  const progressBar = "█".repeat(filled) + "░".repeat(20 - filled);

  await editMessage(
    msg,
    `🧹 <b>清理拉黑用户进行中</b>

📊 <b>进度:</b> ${percentage}% (${processed}/${total})
${progressBar}

📈 <b>统计:</b>
• ✅ 成功: ${success}
• ❌ 失败: ${failed}
• ⏭️ 跳过: ${skipped}

⚙️ <b>模式:</b> ${includeAll ? "全量清理" : "智能清理"}

⏱️ <b>剩余时间:</b> ${estimateRemainingTime(processed, total, Date.now() - startTime)}`
  );
}

function buildBlockedResult(success: number, failed: number, skipped: number, total: number, includeAll: boolean): string {
  const efficiency = total > 0 ? Math.round((success / total) * 100) : 0;
  const totalProcessed = success + failed + skipped;

  let statusEmoji = "✅";
  let statusText = "成功完成";
  if (failed > 0 && failed > success) {
    statusEmoji = "⚠️";
    statusText = "部分完成";
  } else if (success === 0) {
    statusEmoji = "ℹ️";
    statusText = "无需清理";
  }

  return `${statusEmoji} <b>清理拉黑用户${statusText}</b>

📊 <b>统计结果:</b>
• 总计用户: ${total}
• 成功清理: ${success}
• 清理失败: ${failed}
• 跳过处理: ${skipped}
• 成功率: ${efficiency}%

⚙️ <b>清理模式:</b> ${includeAll ? "全量清理" : "智能清理"}

📈 <b>处理详情:</b>
• 已处理: ${totalProcessed}/${total}
${skipped > 0 ? `• 跳过原因: ${includeAll ? "系统限制" : "机器人/诈骗/虚假账户"}` : ""}

💡 <b>提示:</b> ${failed > 0 ? "部分失败可能是由于API限制或网络问题" : "所有操作已成功完成"}`;
}

async function cleanBlockedPM(client: TelegramClient, msg: MessageContext, includeAll: boolean): Promise<void> {
  const startTime = Date.now();
  await editMessage(
    msg,
    `🧹 开始清理拉黑用户\n\n模式: ${includeAll ? "全量清理" : "智能清理"}`
  );

  let total = 0;
  try {
    const initial = await getBlockedPage(client, 0, 100);
    // blockedSlice 带总数；contacts.blocked 只含当前页，按页大小估算
    total = initial?._ === "contacts.blockedSlice"
      ? Number(initial.count || 0)
      : (initial?.blocked?.length ?? 0);
  } catch (error: unknown) {
    logger.error("[clean] 获取拉黑总数失败:", error);
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;
  let consecutiveErrors = 0;
  // 解封后该条目会从列表消失，所以 offset 只按「本轮跳过数」前进，避免漏处理
  let offset = 0;
  let guard = 0;

  while (guard++ < 500) {
    let peers: tl.TypePeerBlocked[] = [];
    const userById = new Map<number, RawUser>();
    try {
      const page = await getBlockedPage(client, offset, 100);
      peers = (page?.blocked ?? []) as tl.TypePeerBlocked[];
      if (peers.length === 0) break;
      for (const user of (page?.users ?? []) as RawUser[]) {
        userById.set(Number(user.id), user);
      }
    } catch (error: unknown) {
      const text = getErrorMessage(error);
      logger.error("[clean] 获取拉黑列表失败:", text);
      if (text.includes("FLOOD_WAIT")) {
        await handleFloodWait(msg, text);
        continue;
      }
      break;
    }

    let skippedInBatch = 0;
    for (const peer of peers) {
      // 只处理用户；频道/群组封禁由 blocked member 负责
      if (peer.peerId?._ !== "peerUser") continue;
      const user = userById.get(Number(peer.peerId.userId));
      if (!user) continue;

      processed++;

      // 智能模式跳过机器人/诈骗/虚假账户
      if (!includeAll && (user.bot || user.scam || user.fake)) {
        skipped++;
        skippedInBatch++;
        continue;
      }

      try {
        await client.unblockUser(user);
        success++;
        consecutiveErrors = 0;
        await sleep(getDynamicDelay(user, includeAll, consecutiveErrors));
      } catch (error: unknown) {
        const text = getErrorMessage(error);
        if (text.includes("FLOOD_WAIT")) {
          await handleFloodWait(msg, text);
          continue;
        }
        failed++;
        consecutiveErrors++;
        await sleep(getDynamicDelay(user, includeAll, consecutiveErrors));
      }

      if (processed % 10 === 0) {
        if (processed > total) total = processed;
        await updateBlockedProgress(msg, processed, total, success, failed, skipped, includeAll, startTime);
      }
    }

    offset += skippedInBatch;
    if (peers.length < 100) break;

    const batchDelay = consecutiveErrors > 0 ? 3000 + consecutiveErrors * 1000 : 2000;
    await sleep(Math.min(batchDelay, 10000));
  }

  await editMessage(msg, buildBlockedResult(success, failed, skipped, total, includeAll));
}

// ---------- 被封禁实体解封 ----------

async function unblockMember(client: TelegramClient, msg: MessageContext, includeAll: boolean): Promise<void> {
  if (!msg.chat || msg.chat.type === "user") {
    await sendError(msg, "此命令只能在群组中使用");
    return;
  }

  await editMessage(msg, "🔓 正在获取被封禁实体列表...");

  const me = await safeGetMe(client);
  if (!me) {
    await sendError(msg, "无法获取当前账号信息");
    return;
  }
  const myId = Number(me.id);
  const chatEntity = await client.resolvePeer(msg.chat.id);

  let bannedEntities = await getBannedUsers(client, chatEntity);
  if (!includeAll) {
    bannedEntities = bannedEntities.filter((u) => u.kickedBy === myId);
  }

  if (bannedEntities.length === 0) {
    await editMessage(msg, "ℹ️ 没有找到需要解封的实体");
    await sleep(3000);
    await safeDelete(msg);
    return;
  }

  await editMessage(msg, `⚡ 正在解封 ${bannedEntities.length} 个实体...`);

  const entityStats = { users: 0, channels: 0, chats: 0 };
  bannedEntities.forEach((entity) => {
    if (entity.type === "user") entityStats.users++;
    else if (entity.type === "channel") entityStats.channels++;
    else if (entity.type === "chat") entityStats.chats++;
  });

  let successCount = 0;
  let failedCount = 0;
  const failedEntities: string[] = [];

  for (const entity of bannedEntities) {
    const ok = await unbanUser(client, chatEntity, entity.id);
    if (ok) {
      successCount++;
    } else {
      failedCount++;
      const displayName =
        entity.type === "user"
          ? `${entity.firstName}(${entity.id})`
          : `${entity.title || entity.firstName}[${entity.type}](${entity.id})`;
      failedEntities.push(displayName);
    }
    await sleep(500);
  }

  let statsText = "";
  if (entityStats.users > 0) statsText += `👤 用户: ${entityStats.users} `;
  if (entityStats.channels > 0) statsText += `📢 频道: ${entityStats.channels} `;
  if (entityStats.chats > 0) statsText += `💬 群组: ${entityStats.chats}`;

  let resultText = failedCount > 0
    ? `✅ <b>解封完成</b>\n\n${statsText}\n成功: <code>${successCount}</code> 个\n失败: <code>${failedCount}</code> 个`
    : `✅ <b>解封完成</b>\n\n${statsText}\n已成功解封 <code>${successCount}</code> 个实体`;

  if (failedEntities.length > 0) {
    resultText += `\n\n失败列表:\n${failedEntities.slice(0, 10).map((n) => `• ${htmlEscape(n)}`).join("\n")}`;
  }

  await editMessage(msg, resultText);
  await sleep(5000);
  await safeDelete(msg);
}

// ---------- 命令路由 ----------

const clean = async (msg: MessageContext): Promise<void> => {
  const client = await getGlobalClient();
  if (!client) {
    await editMessage(msg, "❌ 客户端未就绪");
    return;
  }

  try {
    const text = msg.text || "";
    const parts = text.trim().split(/\s+/);
    const subCommand = parts[1]?.toLowerCase();

    if (!subCommand || subCommand === "help" || subCommand === "h") {
      await editMessage(msg, HELP_TEXT);
      return;
    }

    await editMessage(msg, "🔄 正在处理请求...");

    const action = parts[2]?.toLowerCase();
    const option = parts[3]?.toLowerCase();

    if (subCommand === "deleted") {
      if (action === "pm") {
        await cleanDeletedPM(client, msg, option === "rm");
      } else if (action === "member") {
        await cleanDeletedMember(client, msg, option === "rm");
      } else {
        await sendError(msg, "请指定清理类型: pm (私聊) 或 member (群组)");
      }
      return;
    }

    if (subCommand === "blocked") {
      if (action === "pm") {
        await cleanBlockedPM(client, msg, option === "all");
      } else if (action === "member") {
        await unblockMember(client, msg, option === "all");
      } else {
        await sendError(msg, "请指定清理类型: pm (私聊拉黑) 或 member (群组封禁)");
      }
      return;
    }

    await sendError(msg, `未知子命令: ${htmlEscape(subCommand)}`);
  } catch (error: unknown) {
    await handleError(msg, error);
  }
};

class CleanPlugin extends Plugin {
  description: string = HELP_TEXT;

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    clean,
  };
}

export default new CleanPlugin();
