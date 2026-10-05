import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage.js";
import { getPeerId } from "telegram/Utils.js";
import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { LeadStatus } from "@prisma/client";
import {
  env,
  getDeleteSourceMessageIfAdmin,
  getDriverChatIdBySourceChatId,
  getSourceRegionByPassengerChatId,
  getSourceRegionByPassengerChatUsername,
  isDriverChatId,
  normalizeTelegramChatUsername,
  registerResolvedPassengerChat,
  SOURCE_REGIONS,
  type SourceRegion
} from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { classifyMessage, getProviderStatusSnapshot } from "../services/leadClassifier.service.js";
import {
  addKeywordEntry,
  getKeywordCacheStats,
  getKeywordCountByCategory,
  listKeywordsByCategory,
  mapInputCategory,
  reloadKeywordDictionaryCache
} from "../services/keywordDictionary.service.js";
import {
  buildInboundMessageLogFields,
  getLastLeads,
  type ProcessMessageResult,
  getStatsSnapshot,
  getStatusSnapshot,
  processIncomingLead,
  type UnifiedIncomingMessage,
  type UnifiedMessageActions
} from "../services/lead.service.js";
import { sendDriverLeadViaBotBridge } from "../services/driverDelivery.service.js";
import { isAdminIdentity, isSuperAdminIdentity } from "../services/admin.service.js";
import { writeError, writeInfo, writeWarn } from "../services/logger.service.js";
import {
  addPassengerSourceChat,
  parseSourceRegionInput,
  setRegionalRuntimeBooleanSetting,
  type RuntimeBooleanSetting
} from "../services/runtimeConfig.service.js";
import { sendTelegramBotMessage } from "../services/telegramBotApi.service.js";
import { shouldBlockPassengerGroupWrite } from "../utils/passengerGroupWrite.js";

interface ListenerState {
  paused: boolean;
}

interface StoredMessageScanResult {
  scanned: boolean;
  leadResult: ProcessMessageResult | null;
}

interface SourceScanStats {
  scanned: number;
  processed: number;
  sent: number;
  skipped: number;
  skippedReasonCounter: Map<string, number>;
}

interface CachedTelegramIdentity {
  title: string;
  username: string | null;
}

const KAMSAMOL_SOURCE_USERNAME = "KamsamoltaksiN1";
const ADMIN_COMMAND_HELP_TEXT =
  "Mavjud buyruqlar: .help, .status, .stats, .sources, .set_del_source <region|all> <on|off|default>, .set_del_ignored <region|all> <on|off|default>, .set_auto_replies <region|all> <on|off|default>, .set_private_ack <region|all> <on|off|default>, .pause, .resume, .test <matn>, .last <son>, .keywords <tur>, .keyword_count, .add_keyword <tur> <gap> <kuch>, .reload_keywords";
const KAMSAMOL_SOURCE_USERNAMES = [KAMSAMOL_SOURCE_USERNAME, "kamsamolikmiz"];
const KAMSAMOL_SOURCE_ALIASES = ["kamsamol", "komsamol", "komsomol", "komosol", "камсамол", "комсомол"];

function formatKeywordCategoryLabel(category: string): string {
  if (category === "PASSENGER") {
    return "yo'lovchi";
  }

  if (category === "DRIVER") {
    return "haydovchi";
  }

  if (category === "CARGO") {
    return "pochta/yuk";
  }

  if (category === "SPAM") {
    return "reklama/spam";
  }

  return "noaniq";
}

function createSourceScanStats(): SourceScanStats {
  return {
    scanned: 0,
    processed: 0,
    sent: 0,
    skipped: 0,
    skippedReasonCounter: new Map()
  };
}

function recordSourceScanResult(stats: SourceScanStats, result: StoredMessageScanResult): void {
  if (!result.scanned) {
    return;
  }

  stats.scanned += 1;

  if (!result.leadResult) {
    return;
  }

  stats.processed += 1;

  if (result.leadResult.processed) {
    stats.sent += 1;
    return;
  }

  stats.skipped += 1;
  const reason = result.leadResult.reason ?? "Unknown";
  stats.skippedReasonCounter.set(reason, (stats.skippedReasonCounter.get(reason) ?? 0) + 1);
}

function getTopSkippedReasons(stats: SourceScanStats, limit = 5): Array<{ reason: string; count: number }> {
  return [...stats.skippedReasonCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNumericId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function toPositiveUserId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function toNumberId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }

  return null;
}

function formatEntityName(entity: any): string {
  if (!entity) {
    return "";
  }

  if (typeof entity.title === "string" && entity.title.trim().length > 0) {
    return entity.title.trim();
  }

  const firstName = toText(entity.firstName || entity.first_name);
  const lastName = toText(entity.lastName || entity.last_name);
  const fullName = `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();

  if (fullName.length > 0) {
    return fullName;
  }

  return "";
}

function getEntityUsername(entity: any): string | null {
  return normalizeTelegramChatUsername(toText(entity?.username || entity?.usernames?.[0]?.username));
}

function buildCachedTelegramIdentity(entity: any, fallbackTitle: string): CachedTelegramIdentity {
  return {
    title: formatEntityName(entity) || fallbackTitle,
    username: getEntityUsername(entity)
  };
}

function getMessageDate(rawDate: unknown): Date {
  if (rawDate instanceof Date) {
    return rawDate;
  }

  const asNumber = Number(rawDate);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber * 1000);
  }

  return new Date();
}

function buildSourceMessageLink(sourceChatId: string, sourceMessageId: number, sourceChatUsername?: string | null): string | null {
  const usernameRaw = typeof sourceChatUsername === "string" ? sourceChatUsername.trim().replace(/^@/, "") : "";
  if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(usernameRaw)) {
    return `https://t.me/${usernameRaw}/${sourceMessageId}`;
  }

  const chatId = Number(sourceChatId);
  if (!Number.isInteger(chatId) || chatId >= 0) {
    return null;
  }

  const absChatId = String(Math.abs(chatId));
  if (!absChatId.startsWith("100")) {
    return null;
  }

  const internalId = absChatId.slice(3);
  if (!internalId) {
    return null;
  }

  return `https://t.me/c/${internalId}/${sourceMessageId}`;
}

function normalizeSourceIdentity(value: string | null | undefined): string {
  return toText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isKamsamolSource(payload: UnifiedIncomingMessage): boolean {
  const username = normalizeSourceIdentity(payload.sourceChatUsername);
  if (KAMSAMOL_SOURCE_USERNAMES.some((sourceUsername) => username === sourceUsername.toLowerCase())) {
    return true;
  }

  const title = normalizeSourceIdentity(payload.sourceChatTitle);
  return payload.sourceRegion === "KOMSOMOL" && KAMSAMOL_SOURCE_ALIASES.some((alias) => title.includes(alias));
}

function getSourceUsernameForLink(payload: UnifiedIncomingMessage): string | null {
  if (payload.sourceChatUsername) {
    return payload.sourceChatUsername;
  }

  if (isKamsamolSource(payload)) {
    return KAMSAMOL_SOURCE_USERNAME;
  }

  return null;
}

function applyKnownSourceUsernameFallback(payload: UnifiedIncomingMessage): void {
  if (!payload.sourceChatUsername && isKamsamolSource(payload)) {
    payload.sourceChatUsername = KAMSAMOL_SOURCE_USERNAME;
  }
}

function truncateAdminNotifyText(text: string, maxLength = 700): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildAdminSourceNotifyMessage(payload: UnifiedIncomingMessage, eventAgeMs: number | null): string {
  const sender = payload.senderUsername ? `@${payload.senderUsername}` : payload.senderFullName || payload.senderId;
  const source = payload.sourceChatUsername ? `@${payload.sourceChatUsername}` : payload.sourceChatTitle || payload.sourceChatId;
  const ageLine = eventAgeMs === null ? "eventAgeMs=-" : `eventAgeMs=${eventAgeMs}`;

  return [
    "SOURCE MESSAGE RECEIVED",
    `source=${source}`,
    `chatId=${payload.sourceChatId}`,
    `messageId=${payload.sourceMessageId}`,
    `sender=${sender}`,
    ageLine,
    "",
    truncateAdminNotifyText(payload.text)
  ].join("\n");
}

function notifyAdminAboutWatchedSource(payload: UnifiedIncomingMessage, eventAgeMs: number | null): void {
  const sourceChatIdNumber = toNumericId(payload.sourceChatId);
  if (
    sourceChatIdNumber === null ||
    !env.ADMIN_TELEGRAM_ID ||
    !env.ADMIN_NOTIFY_SOURCE_CHAT_IDS.includes(sourceChatIdNumber)
  ) {
    return;
  }

  void sendTelegramBotMessage(env.ADMIN_TELEGRAM_ID, buildAdminSourceNotifyMessage(payload, eventAgeMs)).catch((error) => {
    void writeWarn("Admin watched source notification failed", {
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId,
      adminChatId: env.ADMIN_TELEGRAM_ID,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function getEffectiveDriverChatIdForPayload(payload: UnifiedIncomingMessage, defaultDriverChatId: number): number {
  if (isKamsamolSource(payload) && env.DRIVER_CHAT_ID_KOMSOMOL !== null) {
    return env.DRIVER_CHAT_ID_KOMSOMOL;
  }

  return defaultDriverChatId;
}

function canDeleteMessagesInChat(entity: any): boolean {
  if (!entity) {
    return false;
  }

  if (entity.creator === true) {
    return true;
  }

  const rights = entity.adminRights ?? entity.admin_rights;
  if (!rights) {
    return false;
  }

  return Boolean(rights.deleteMessages ?? rights.delete_messages);
}

function canPostMessagesFromAdminRights(rights: unknown): boolean {
  if (!rights || typeof rights !== "object") {
    return false;
  }

  const record = rights as Record<string, unknown>;
  return Boolean(record.postMessages ?? record.post_messages);
}

function canPostMessagesInChat(entity: any): boolean {
  if (!entity) {
    return false;
  }

  if (entity.creator === true) {
    return true;
  }

  const rights = entity.adminRights ?? entity.admin_rights;
  return canPostMessagesFromAdminRights(rights);
}

function canPostMessagesFromParticipant(participant: unknown): boolean {
  if (participant instanceof Api.ChannelParticipantCreator) {
    return true;
  }

  if (participant instanceof Api.ChannelParticipantAdmin) {
    return canPostMessagesFromAdminRights(participant.adminRights);
  }

  if (participant instanceof Api.ChatParticipantCreator || participant instanceof Api.ChatParticipantAdmin) {
    return true;
  }

  return false;
}

type UserbotChannelWriteGuard = (
  chatIdNumber: number,
  operation: string,
  meta?: Record<string, unknown>
) => Promise<boolean>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseFloodWaitSeconds(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toUpperCase();

  const strictMatch = normalized.match(/FLOOD_WAIT_(\d+)/);
  if (strictMatch) {
    const seconds = Number(strictMatch[1]);
    return Number.isFinite(seconds) ? seconds : null;
  }

  const genericMatch = normalized.match(/A WAIT OF (\d+) SECONDS IS REQUIRED/);
  if (genericMatch) {
    const seconds = Number(genericMatch[1]);
    return Number.isFinite(seconds) ? seconds : null;
  }

  return null;
}

type SessionAuthErrorType = "AUTH_KEY_DUPLICATED" | "AUTH_KEY_INVALID" | "SESSION_REVOKED";

function classifySessionAuthError(error: unknown): SessionAuthErrorType | null {
  const message = (error instanceof Error ? error.message : String(error)).toUpperCase();

  if (message.includes("AUTH_KEY_DUPLICATED")) {
    return "AUTH_KEY_DUPLICATED";
  }

  if (message.includes("AUTH_KEY_INVALID") || message.includes("AUTH_KEY_UNREGISTERED")) {
    return "AUTH_KEY_INVALID";
  }

  if (message.includes("SESSION_REVOKED") || message.includes("SESSION_EXPIRED")) {
    return "SESSION_REVOKED";
  }

  return null;
}

function buildSessionRecoveryHint(errorType: SessionAuthErrorType): string {
  if (errorType === "AUTH_KEY_DUPLICATED") {
    return "TELEGRAM_STRING_SESSION bir nechta joyda ishlatilgan. Yangi session oling va faqat bitta instance qoldiring.";
  }

  if (errorType === "AUTH_KEY_INVALID") {
    return "TELEGRAM_STRING_SESSION endi yaroqsiz. Yangi session oling va .env ni yangilang.";
  }

  return "Telegram session bekor qilingan. Yangi session oling va .env ni yangilang.";
}

function isInputEntityResolveError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toUpperCase();
  return (
    message.includes("COULD NOT FIND THE INPUT ENTITY") ||
    message.includes("PEER_ID_INVALID") ||
    message.includes("CHANNEL_INVALID")
  );
}

function isChannelAccessError(error: unknown): boolean {
  return isInputEntityResolveError(error);
}

function isPassengerSourceChatId(chatId: number): boolean {
  return getSourceRegionByPassengerChatId(chatId) !== null;
}

async function resolveBotApiChatId(event: NewMessageEvent): Promise<number | null> {
  const peerId = event.message.peerId;
  if (peerId) {
    const peerNumber = toNumberId(getPeerId(peerId, true));
    if (peerNumber !== null) {
      return peerNumber;
    }
  }

  const chat = await event.getChat().catch(() => null);
  if (!chat) {
    return null;
  }

  try {
    return toNumberId(getPeerId(chat, true));
  } catch {
    return null;
  }
}

async function replyToEvent(
  client: TelegramClient,
  event: NewMessageEvent,
  text: string,
  guardUserbotChannelWrite?: UserbotChannelWriteGuard
): Promise<void> {
  if (env.ADMIN_COMMAND_REPLY_MODE === "off") {
    return;
  }

  const chatId = await resolveBotApiChatId(event);
  if (chatId !== null && shouldBlockPassengerGroupWrite(chatId)) {
    return;
  }

  if (env.ADMIN_COMMAND_REPLY_MODE === "bot") {
    if (chatId === null) {
      await writeWarn("Admin command reply skipped: could not resolve Bot API chat id");
      return;
    }

    try {
      const sent = await sendTelegramBotMessage(chatId, text, { replyToMessageId: event.message.id });
      if (!sent) {
        await writeWarn("Admin command reply skipped: TELEGRAM_BOT_TOKEN is not configured", { chatId });
      }
    } catch (error) {
      await writeWarn("Admin command reply via Bot API failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return;
  }

  const inputChat = await event.getInputChat();
  if (!inputChat) {
    return;
  }

  let resolvedChatId = chatId;
  if (resolvedChatId === null) {
    try {
      resolvedChatId = toNumberId(getPeerId(inputChat, true));
    } catch {
      resolvedChatId = null;
    }
  }

  if (resolvedChatId !== null && shouldBlockPassengerGroupWrite(resolvedChatId)) {
    return;
  }

  if (guardUserbotChannelWrite && resolvedChatId !== null && resolvedChatId < 0) {
    const allowed = await guardUserbotChannelWrite(resolvedChatId, "admin_command_reply");
    if (!allowed) {
      return;
    }
  }

  if (env.USERBOT_READ_ONLY) {
    await writeInfo("Admin command reply skipped: userbot read-only mode is enabled", {
      chatId: resolvedChatId,
      replyMode: env.ADMIN_COMMAND_REPLY_MODE
    });
    return;
  }

  await client.sendMessage(inputChat, {
    message: text
  });
}

async function probeSourceChats(client: TelegramClient): Promise<string> {
  const lines: string[] = [];
  lines.push(`Configured source chats: ${env.PASSENGER_CHAT_IDS.join(", ")}`);
  lines.push(`TASHKENT passengers: ${env.PASSENGER_CHAT_IDS_TASHKENT.join(", ") || "-"}`);
  lines.push(`GULISTON passengers: ${env.PASSENGER_CHAT_IDS_GULISTON.join(", ") || "-"}`);
  lines.push(`KOMSOMOL passengers: ${env.PASSENGER_CHAT_IDS_KOMSOMOL.join(", ") || "-"}`);
  lines.push(`TASHKENT usernames: ${env.PASSENGER_CHAT_USERNAMES_TASHKENT.join(", ") || "-"}`);
  lines.push(`GULISTON usernames: ${env.PASSENGER_CHAT_USERNAMES_GULISTON.join(", ") || "-"}`);
  lines.push(`KOMSOMOL usernames: ${env.PASSENGER_CHAT_USERNAMES_KOMSOMOL.join(", ") || "-"}`);
  lines.push(`TASHKENT driver: ${env.DRIVER_CHAT_ID_TASHKENT ?? "-"}`);
  lines.push(`GULISTON driver: ${env.DRIVER_CHAT_ID_GULISTON ?? "-"}`);
  lines.push(`KOMSOMOL driver: ${env.DRIVER_CHAT_ID_KOMSOMOL ?? "-"}`);

  for (const chatId of env.PASSENGER_CHAT_IDS) {
    try {
      const entity = await client.getEntity(chatId);
      const title = formatEntityName(entity) || String(chatId);
      const sourceRegion = getSourceRegionByPassengerChatId(chatId) ?? "UNKNOWN";
      const lastMessages = await client.getMessages(chatId, { limit: 1 });
      const lastMessage = Array.isArray(lastMessages) ? (lastMessages[0] ?? null) : null;
      const lastMessageId = lastMessage?.id ?? "-";
      const lastMessageDate = lastMessage?.date ? getMessageDate(lastMessage.date).toISOString() : "-";
      lines.push(`OK | ${chatId} | ${sourceRegion} | ${title} | lastMessageId=${lastMessageId} | lastMessageDate=${lastMessageDate}`);
    } catch (error) {
      lines.push(`FAIL | ${chatId} | ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const usernameEntries = Object.entries(env.PASSENGER_CHAT_USERNAMES_BY_REGION) as Array<[SourceRegion, string[]]>;
  for (const [region, usernames] of usernameEntries) {
    for (const username of usernames) {
      try {
        const entity = await client.getEntity(username);
        const chatNumber = toNumberId(getPeerId(entity, true));
        const title = formatEntityName(entity) || username;
        lines.push(`OK | @${username} | ${region} | ${title} | resolvedChatId=${chatNumber ?? "-"}`);
      } catch (error) {
        lines.push(`FAIL | @${username} | ${region} | ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return lines.join("\n");
}

async function resolveSourceChat(
  client: TelegramClient,
  event: NewMessageEvent
): Promise<{ sourceChatId: string; sourceChatIdNumber: number; sourceRegion: SourceRegion; driverChatId: number; chat: any | null }> {
  const candidateIds: number[] = [];

  const peerId = event.message.peerId;
  if (peerId) {
    const peerRaw = getPeerId(peerId, true);
    const peerNumber = toNumberId(peerRaw);
    if (peerNumber !== null) {
      candidateIds.push(peerNumber);
    }
  }

  let chat: any | null = null;
  try {
    chat = await event.getChat();
  } catch {
    chat = null;
  }

  if (chat) {
    try {
      const chatRaw = getPeerId(chat, true);
      const chatNumber = toNumberId(chatRaw);
      if (chatNumber !== null) {
        candidateIds.push(chatNumber);
      }
    } catch {
      // ignore
    }
  }

  const uniqueCandidateIds = [...new Set(candidateIds)];
  let chatUsername = getEntityUsername(chat);
  const primaryCandidateId = uniqueCandidateIds[0];
  if (!chatUsername && primaryCandidateId !== undefined) {
    try {
      const entity = await client.getEntity(primaryCandidateId);
      chatUsername = getEntityUsername(entity);
      if (!chat) {
        chat = entity;
      }
    } catch {
      // ignore
    }
  }

  const matchedCandidate = uniqueCandidateIds
    .map((id) => ({ id, region: getSourceRegionByPassengerChatId(id) }))
    .find((candidate) => candidate.region !== null);
  const usernameRegion = getSourceRegionByPassengerChatUsername(chatUsername);
  const matchedRegion = matchedCandidate?.region ?? usernameRegion;
  const sourceChatIdNumber = matchedCandidate?.id ?? uniqueCandidateIds[0];

  if (sourceChatIdNumber === undefined || !matchedRegion) {
    throw new Error(`Source chat not matched. candidates=[${uniqueCandidateIds.join(", ")}], username=${chatUsername ?? "-"}`);
  }

  if (getSourceRegionByPassengerChatId(sourceChatIdNumber) === null) {
    await addPassengerSourceChat(matchedRegion, sourceChatIdNumber);
  } else {
    registerResolvedPassengerChat(sourceChatIdNumber, matchedRegion);
  }

  const sourceRegion = getSourceRegionByPassengerChatId(sourceChatIdNumber);
  const driverChatId = getDriverChatIdBySourceChatId(sourceChatIdNumber);
  if (!sourceRegion || driverChatId === null) {
    throw new Error(`Source chat ${sourceChatIdNumber} has no region/driver mapping`);
  }

  return {
    sourceChatId: String(sourceChatIdNumber),
    sourceChatIdNumber,
    sourceRegion,
    driverChatId,
    chat
  };
}

async function handleAdminCommand(
  client: TelegramClient,
  event: NewMessageEvent,
  commandText: string,
  state: ListenerState,
  guardUserbotChannelWrite?: UserbotChannelWriteGuard
): Promise<boolean> {
  const trimmedCommandText = commandText.trim();
  if (!trimmedCommandText.startsWith(".")) {
    return false;
  }

  const senderId = event.message.senderId?.toString();
  const senderUserId = senderId ? toPositiveUserId(senderId) : null;
  if (senderUserId === null) {
    return false;
  }

  const sender = await event.message.getSender().catch(() => null);
  const senderUsername = normalizeTelegramChatUsername(toText((sender as any)?.username || (sender as any)?.usernames?.[0]?.username));
  const identity: { telegramId: bigint; username?: string } = { telegramId: BigInt(senderUserId) };
  if (senderUsername) {
    identity.username = senderUsername;
  }

  if (!(await isSuperAdminIdentity(identity))) {
    return false;
  }

  if (trimmedCommandText === ".") {
    return true;
  }

  const [rawCommand = "", ...rest] = trimmedCommandText.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ").trim();
  const reply = (text: string) => replyToEvent(client, event, text, guardUserbotChannelWrite);

  if (command === ".help") {
    await reply(ADMIN_COMMAND_HELP_TEXT);
    return true;
  }

  if (command === ".pause") {
    state.paused = true;
    await reply( "Userbot pauza holatiga o'tdi.");
    return true;
  }

  if (command === ".resume") {
    state.paused = false;
    await reply( "Userbot qayta ishga tushdi.");
    return true;
  }

  if (command === ".sources") {
    await reply(
      [
        `Source chatlar: ${env.PASSENGER_CHAT_IDS.join(", ")}`,
        `TASHKENT passenger: ${env.PASSENGER_CHAT_IDS_TASHKENT.join(", ") || "-"}`,
        `GULISTON passenger: ${env.PASSENGER_CHAT_IDS_GULISTON.join(", ") || "-"}`,
        `KOMSOMOL passenger: ${env.PASSENGER_CHAT_IDS_KOMSOMOL.join(", ") || "-"}`,
        `TASHKENT usernames: ${env.PASSENGER_CHAT_USERNAMES_TASHKENT.join(", ") || "-"}`,
        `GULISTON usernames: ${env.PASSENGER_CHAT_USERNAMES_GULISTON.join(", ") || "-"}`,
        `KOMSOMOL usernames: ${env.PASSENGER_CHAT_USERNAMES_KOMSOMOL.join(", ") || "-"}`,
        `TASHKENT driver: ${env.DRIVER_CHAT_ID_TASHKENT ?? "-"}`,
        `GULISTON driver: ${env.DRIVER_CHAT_ID_GULISTON ?? "-"}`,
        `KOMSOMOL driver: ${env.DRIVER_CHAT_ID_KOMSOMOL ?? "-"}`,
        `Driver delivery: ${env.DRIVER_DELIVERY_MODE} (requested: ${env.DRIVER_DELIVERY_REQUESTED_MODE})`,
        `Pauza: ${state.paused ? "ha" : "yo'q"}`
      ].join("\n")
    );
    return true;
  }

  if (command === ".source_probe") {
    const report = await probeSourceChats(client);
    await reply( report);
    return true;
  }

  if (command === ".status") {
    const status = await getStatusSnapshot();
    const providerStatus = getProviderStatusSnapshot()
      .map((item) => `${item.name}: ${item.status}${item.keyConfigured ? "" : " (key yo'q)"}`)
      .join(" | ");

    await reply(
      [
        "Userbot status:",
        `Pauza: ${state.paused ? "ha" : "yo'q"}`,
        `Jami: ${status.total}`,
        `Sent: ${status.sent}`,
        `Deleted from source: ${status.deletedFromSource}`,
        `Not deleted (permission): ${status.notDeletedNoPermission}`,
        `Ignored: ${status.ignored}`,
        `Duplicate: ${status.duplicate}`,
        `Error: ${status.error}`,
        `Providerlar: ${providerStatus || "-"}`
      ].join("\n")
    );

    return true;
  }

  if (command === ".stats") {
    const stats = await getStatsSnapshot();

    await reply(
      [
        "Statistika:",
        "",
        `Bugun lead: ${stats.today.leads}`,
        `Bugun sent: ${stats.today.sent}`,
        `Bugun delete: ${stats.today.deleted}`,
        `Bugun duplicate: ${stats.today.duplicates}`,
        `Bugun error: ${stats.today.errors}`,
        "",
        `Hafta lead: ${stats.week.leads}`,
        `Hafta sent: ${stats.week.sent}`,
        `Hafta delete: ${stats.week.deleted}`,
        `Hafta duplicate: ${stats.week.duplicates}`,
        `Hafta error: ${stats.week.errors}`
      ].join("\n")
    );

    return true;
  }

  if (command === ".test") {
    if (!arg) {
      await reply( "Foydalanish: .test <text>");
      return true;
    }

    const result = await classifyMessage(arg);
    await reply(
      [
        `Category: ${result.category}`,
        `Passenger lead: ${result.is_passenger_request ? "ha" : "yo'q"}`,
        `Confidence: ${result.confidence}`,
        `Provider: ${result.provider}`,
        `Passenger score: ${result.passengerScore}`,
        `Driver score: ${result.driverScore}`,
        `Cargo score: ${result.cargoScore}`,
        `Spam score: ${result.spamScore}`,
        `Driver ad: ${result.isDriverAd ? "ha" : "yo'q"}`,
        `Spam: ${result.isSpam ? "ha" : "yo'q"}`,
        `From: ${result.fromLocation ?? "-"}`,
        `To: ${result.toLocation ?? "-"}`,
        `Phone: ${result.phone ?? "-"}`,
        `Passenger count: ${result.passengerCount ?? "-"}`,
        `Time hint: ${result.timeHint ?? "-"}`,
        `Matched: ${result.matchedKeywords.slice(0, 12).join(", ") || "-"}`,
        `Reason: ${result.reason}`
      ].join("\n")
    );

    return true;
  }

  if (command === ".keyword_count") {
    const counts = await getKeywordCountByCategory();
    const cacheStats = getKeywordCacheStats();
    await reply(
      [
        "Keyword counts:",
        `PASSENGER: ${counts.PASSENGER}`,
        `DRIVER: ${counts.DRIVER}`,
        `CARGO: ${counts.CARGO}`,
        `SPAM: ${counts.SPAM}`,
        `AMBIGUOUS: ${counts.AMBIGUOUS}`,
        `Cache total: ${cacheStats.total}`
      ].join("\n")
    );
    return true;
  }

  if (command === ".reload_keywords") {
    await reloadKeywordDictionaryCache();
    const cacheStats = getKeywordCacheStats();
    await reply(
      `Keyword cache reloaded. total=${cacheStats.total}, loadedAt=${new Date(cacheStats.loadedAt).toISOString()}`
    );
    return true;
  }

  if (command === ".keywords") {
    const category = mapInputCategory(arg);
    if (!category || category === "AMBIGUOUS") {
      await reply( "Foydalanish: .keywords passenger|driver|cargo|spam");
      return true;
    }

    const rows = await listKeywordsByCategory(category, 50);
    const lines = rows.map((row) => `${row.weight} | ${row.phrase}`);
    await reply( [`${category} keywords (${rows.length}):`, ...lines].join("\n"));
    return true;
  }

  if (command === ".add_keyword") {
    const raw = commandText.replace(/^\.add_keyword\s+/iu, "").trim();
    const quotedMatch = raw.match(/^(\S+)\s+"([^"]+)"(?:\s+(\d+))?$/iu);
    const parts = quotedMatch ? [] : raw.split(/\s+/u).filter(Boolean);
    const rawCategory = quotedMatch?.[1] ?? parts.shift() ?? "";
    const category = mapInputCategory(rawCategory);

    if (!category) {
      await reply("Foydalanish: .add_keyword yo'lovchi taxi kerak 8 yoki .add_keyword haydovchi \"bosh joy bor\" 10");
      return true;
    }

    let phrase = quotedMatch?.[2]?.trim() ?? parts.join(" ").trim();
    let rawWeight = quotedMatch?.[3] ?? "";

    if (!quotedMatch && parts.length > 1) {
      const lastPart = parts[parts.length - 1] ?? "";
      if (/^\d+$/u.test(lastPart)) {
        rawWeight = lastPart;
        phrase = parts.slice(0, -1).join(" ").trim();
      }
    }

    if (!phrase) {
      await reply("Gap/so'z bo'sh bo'lmasin. Masalan: .add_keyword yo'lovchi taxi kerak 8");
      return true;
    }

    const parsedWeight = Number(rawWeight || "8");
    const weight = Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : 8;
    const added = await addKeywordEntry({
      category,
      phrase,
      weight,
      source: "admin"
    });

    if (!added) {
      await reply( "Keyword qo'shilmadi (bo'sh yoki noto'g'ri).");
      return true;
    }

    await reply(`Saqlangan: ${formatKeywordCategoryLabel(added.category)} / ${added.phrase} (kuchi ${added.weight})`);
    return true;
  }

  if (command === ".last") {
    const parsedLimit = Number(arg || "10");
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;
    const rows = await getLastLeads(limit);

    if (rows.length === 0) {
      await reply( "Hali lead yozuvlari yo'q.");
      return true;
    }

    const lines = rows.map(
      (row) =>
        `#${row.id} [${row.status}] ${row.sender} | ${row.route} | ${row.source} | ${row.createdAt.toISOString().slice(0, 16).replace("T", " ")}`
    );

    await reply( lines.join("\n"));
    return true;
  }

  // .set_del_source <region|all> <on|off|default>
  if (command === ".set_del_source" || command === ".set_del_ignored" || command === ".set_auto_replies" || command === ".set_private_ack") {
    const settingMap: Record<string, RuntimeBooleanSetting> = {
      ".set_del_source": "DELETE_SOURCE_MESSAGE_IF_ADMIN",
      ".set_del_ignored": "DELETE_IGNORED_MESSAGE_IF_ADMIN",
      ".set_auto_replies": "PASSENGER_GROUP_AUTO_REPLIES",
      ".set_private_ack": "SEND_PRIVATE_ACK_TO_PASSENGER"
    };
    const setting = settingMap[command] as RuntimeBooleanSetting;
    const parts = arg.split(/\s+/);
    const rawRegion = parts[0] ?? "";
    const rawValue = parts[1] ?? "";

    if (!rawRegion || !rawValue) {
      await reply(`Foydalanish: ${command} <region|all> <on|off|default>\nRegionlar: TASHKENT, GULISTON, KOMSOMOL, ANDIJON, all`);
      return true;
    }

    const valueMap: Record<string, boolean | null> = { on: true, off: false, default: null };
    if (!(rawValue.toLowerCase() in valueMap)) {
      await reply("Qiymat: on | off | default");
      return true;
    }
    const value = valueMap[rawValue.toLowerCase()] as boolean | null;

    if (rawRegion.toLowerCase() === "all") {
      for (const reg of SOURCE_REGIONS) {
        await setRegionalRuntimeBooleanSetting(reg, setting, value);
      }
      await reply(`${setting} barcha regionlar uchun ${rawValue} ga o'rnatildi.`);
      return true;
    }

    const region = parseSourceRegionInput(rawRegion);
    if (!region) {
      await reply(`Noma'lum region: ${rawRegion}. To'g'rilari: TASHKENT, GULISTON, KOMSOMOL, ANDIJON, all`);
      return true;
    }

    await setRegionalRuntimeBooleanSetting(region, setting, value);
    await reply(`${setting} [${region}] uchun ${rawValue} ga o'rnatildi.`);
    return true;
  }

  return true;
}

async function buildUnifiedPayload(
  client: TelegramClient,
  event: NewMessageEvent,
  cache?: {
    sourceIdentityByChatId: Map<number, CachedTelegramIdentity>;
    senderIdentityByUserId: Map<string, CachedTelegramIdentity>;
  }
): Promise<UnifiedIncomingMessage | null> {
  const messageText = toText(event.message.message).trim();
  if (!messageText) {
    return null;
  }

  const peerId = event.message.peerId;
  const peerChatIdNumber = peerId ? toNumberId(getPeerId(peerId, true)) : null;
  let sourceChatIdNumber = peerChatIdNumber;
  let sourceRegion = sourceChatIdNumber === null ? null : getSourceRegionByPassengerChatId(sourceChatIdNumber);
  let driverChatId = sourceChatIdNumber === null ? null : getDriverChatIdBySourceChatId(sourceChatIdNumber);
  let chat: any | null = (event as any).chat ?? (event.message as any).chat ?? null;

  if (sourceChatIdNumber === null || !sourceRegion || driverChatId === null) {
    try {
      const resolvedSource = await resolveSourceChat(client, event);
      sourceChatIdNumber = resolvedSource.sourceChatIdNumber;
      sourceRegion = resolvedSource.sourceRegion;
      driverChatId = resolvedSource.driverChatId;
      chat = resolvedSource.chat;
    } catch {
      return null;
    }
  }

  if (sourceChatIdNumber === null || !sourceRegion || driverChatId === null) {
    return null;
  }

  const sourceChatId = String(sourceChatIdNumber);
  const cachedSourceIdentity = cache?.sourceIdentityByChatId.get(sourceChatIdNumber);
  if (!cachedSourceIdentity && chat) {
    cache?.sourceIdentityByChatId.set(sourceChatIdNumber, buildCachedTelegramIdentity(chat, sourceChatId));
  } else if (!cachedSourceIdentity && cache) {
    const sourceChatIdToCache = sourceChatIdNumber;
    void client
      .getEntity(sourceChatIdToCache)
      .then((entity) => {
        cache.sourceIdentityByChatId.set(sourceChatIdToCache, buildCachedTelegramIdentity(entity, sourceChatId));
      })
      .catch(() => undefined);
  }

  const senderIdRaw = event.message.senderId?.toString();

  const senderId = senderIdRaw ?? `chat:${sourceChatId}`;
  const cachedSenderIdentity = senderIdRaw ? cache?.senderIdentityByUserId.get(senderIdRaw) : undefined;
  const eventSender = (event.message as any).sender ?? (event as any).sender ?? null;
  const eventSenderIdentity = !cachedSenderIdentity && eventSender ? buildCachedTelegramIdentity(eventSender, senderId) : null;
  if (eventSenderIdentity && senderIdRaw && cache) {
    cache.senderIdentityByUserId.set(senderIdRaw, eventSenderIdentity);
  }

  const senderFullName = cachedSenderIdentity?.title || eventSenderIdentity?.title || senderId;
  const senderUsername = cachedSenderIdentity?.username ?? eventSenderIdentity?.username ?? null;
  if (!cachedSenderIdentity && !eventSenderIdentity && senderIdRaw && cache) {
    void event.message
      .getSender()
      .then((sender) => {
        if (sender) {
          cache.senderIdentityByUserId.set(senderIdRaw, buildCachedTelegramIdentity(sender, senderId));
        }
      })
      .catch(() => undefined);
  }

  const latestCachedSourceIdentity = cache?.sourceIdentityByChatId.get(sourceChatIdNumber);
  const sourceChatUsername = latestCachedSourceIdentity?.username ?? getEntityUsername(chat);
  const sourceChatTitle = latestCachedSourceIdentity?.title ?? (formatEntityName(chat) || sourceChatId);

  return {
    sourceChatId,
    sourceRegion,
    sourceChatTitle,
    sourceChatUsername,
    sourceMessageId: event.message.id,
    senderId,
    senderFullName,
    senderUsername,
    isSourceAdmin: false,
    isDriverChatMember: false,
    isStartupBackfill: false,
    text: messageText,
    messageDate: getMessageDate(event.message.date),
    isForwarded: Boolean((event.message as any).fwdFrom)
  };
}

async function buildUnifiedPayloadFromStoredMessage(
  client: TelegramClient,
  sourceChatIdNumber: number,
  message: any
): Promise<{ payload: UnifiedIncomingMessage; senderEntity: any | null } | null> {
  const messageText = toText(message?.message).trim();
  if (!messageText) {
    return null;
  }

  const sourceChatId = String(sourceChatIdNumber);
  const sourceRegion = getSourceRegionByPassengerChatId(sourceChatIdNumber);
  if (!sourceRegion) {
    return null;
  }
  const chat = await client.getEntity(sourceChatIdNumber).catch(() => null);
  const senderEntity = await message?.getSender?.().catch(() => null);
  const senderIdRaw = message?.senderId?.toString?.() ?? null;

  const senderId = senderIdRaw ?? `chat:${sourceChatId}`;
  const senderFullName = formatEntityName(senderEntity) || formatEntityName(chat) || senderId;
  const senderUsername = toText((senderEntity as any)?.username || (senderEntity as any)?.usernames?.[0]?.username) || null;
  const sourceChatUsername = getEntityUsername(chat);
  const sourceChatTitle = formatEntityName(chat) || sourceChatId;

  const payload: UnifiedIncomingMessage = {
    sourceChatId,
    sourceRegion,
    sourceChatTitle,
    sourceChatUsername,
    sourceMessageId: Number(message?.id),
    senderId,
    senderFullName,
    senderUsername,
    isSourceAdmin: false,
    isDriverChatMember: false,
    isStartupBackfill: true,
    text: messageText,
    messageDate: getMessageDate(message?.date),
    isForwarded: Boolean(message?.fwdFrom)
  };

  if (!Number.isInteger(payload.sourceMessageId) || payload.sourceMessageId <= 0) {
    return null;
  }

  return {
    payload,
    senderEntity
  };
}

async function resolveConfiguredPassengerUsernameSources(client: TelegramClient): Promise<void> {
  const entries = Object.entries(env.PASSENGER_CHAT_USERNAMES_BY_REGION) as Array<[SourceRegion, string[]]>;

  for (const [region, usernames] of entries) {
    for (const username of usernames) {
      try {
        const entity = await client.getEntity(username);
        const chatId = toNumberId(getPeerId(entity, true));
        if (chatId === null) {
          await writeWarn("Configured passenger username resolved without numeric chat id", { username, region });
          continue;
        }

        if (getSourceRegionByPassengerChatId(chatId) === null) {
          await addPassengerSourceChat(region, chatId);
        } else {
          registerResolvedPassengerChat(chatId, region);
        }
        await writeInfo("Configured passenger username resolved", {
          username,
          region,
          chatId
        });
      } catch (error) {
        await writeWarn("Failed to resolve configured passenger username", {
          username,
          region,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

export async function startUserbotListener(client: TelegramClient): Promise<void> {
  const state: ListenerState = { paused: false };
  const listenerStartedAtMs = Date.now();
  const maxStartupBackfillLimit = 20;
  const configuredStartupBackfillLimit = Math.max(0, env.LISTENER_STARTUP_BACKFILL_LIMIT);
  const startupBackfillLimit = Math.min(maxStartupBackfillLimit, configuredStartupBackfillLimit);
  const outboundMinDelayMs = env.OUTBOUND_MIN_DELAY_MS;
  const outboundJitterMs = env.OUTBOUND_JITTER_MS;
  const ignoredSourceLogCache = new Set<number>();
  const deleteCapabilityBySourceChat = new Map<number, boolean>();
  const writeCapabilityByChatId = new Map<number, boolean>();
  const sourceIdentityByChatId = new Map<number, CachedTelegramIdentity>();
  const senderIdentityByUserId = new Map<string, CachedTelegramIdentity>();
  const sourceAdminByChatAndUser = new Map<string, boolean>();
  const driverMembershipByChatAndUser = new Map<string, boolean>();
  const driverInputPeerByChatId = new Map<number, any>();
  const highestSeenSourceMessageId = new Map<number, number>();
  const unreachableSourceChatIds = new Set<number>();
  const unreachableSourceChatLogCache = new Set<number>();
  let startupBackfillCompleted = false;
  const periodicCatchUpEnabled = env.LISTENER_PERIODIC_CATCH_UP_ENABLED;
  const periodicCatchUpIntervalMs = env.LISTENER_PERIODIC_CATCH_UP_INTERVAL_MS;
  const periodicCatchUpLimit = env.LISTENER_PERIODIC_CATCH_UP_LIMIT;
  let outboundQueue: Promise<unknown> = Promise.resolve();
  let lastOutboundWriteAt = 0;
  let periodicCatchUpInFlight = false;
  let listenerBlockedBySessionAuthError = false;
  let sessionAuthShutdownScheduled = false;
  let heartbeatFailures = 0;
  const shouldResolveSenderProtectionFlags =
    env.SEND_DRIVER_AD_WARNINGS ||
    (!env.USERBOT_READ_ONLY && (env.DELETE_SOURCE_MESSAGE_IF_ADMIN || env.DELETE_IGNORED_MESSAGE_IF_ADMIN));

  const warmSourceIdentityCache = (sourceChatIdNumber: number): void => {
    if (sourceIdentityByChatId.has(sourceChatIdNumber)) {
      return;
    }

    void client
      .getEntity(sourceChatIdNumber)
      .then((entity) => {
        sourceIdentityByChatId.set(sourceChatIdNumber, buildCachedTelegramIdentity(entity, String(sourceChatIdNumber)));
      })
      .catch(() => undefined);
  };

  const scheduleSessionAuthShutdown = async (errorType: SessionAuthErrorType, recoveryHint: string): Promise<void> => {
    if (sessionAuthShutdownScheduled) {
      return;
    }

    sessionAuthShutdownScheduled = true;
    await writeWarn("Fatal Telegram session error detected; exiting process for supervisor restart", {
      errorType,
      recoveryHint,
      exitAfterMs: 5000
    });

    setTimeout(() => {
      process.exit(1);
    }, 5000).unref();
  };

  const handleSessionAuthFailure = async (
    stage: "startup_backfill" | "periodic_catch_up" | "event_handler" | "heartbeat",
    error: unknown,
    meta?: Record<string, unknown>
  ): Promise<boolean> => {
    const errorType = classifySessionAuthError(error);
    if (!errorType) {
      return false;
    }

    const recoveryHint = buildSessionRecoveryHint(errorType);
    listenerBlockedBySessionAuthError = true;
    state.paused = true;

    await writeError("Userbot listener stopped: unrecoverable Telegram session error", error, {
      stage,
      errorType,
      recoveryHint,
      ...meta
    });
    await scheduleSessionAuthShutdown(errorType, recoveryHint);

    return true;
  };

  const runHeartbeat = async (): Promise<void> => {
    if (listenerBlockedBySessionAuthError || env.USERBOT_HEARTBEAT_INTERVAL_MS <= 0) {
      return;
    }

    try {
      await client.getMe();
      if (heartbeatFailures > 0) {
        await writeInfo("Userbot heartbeat recovered", {
          previousFailures: heartbeatFailures
        });
      }
      heartbeatFailures = 0;
    } catch (error) {
      const isSessionAuthFailure = await handleSessionAuthFailure("heartbeat", error);
      if (isSessionAuthFailure) {
        return;
      }

      heartbeatFailures += 1;
      await writeWarn("Userbot heartbeat failed", {
        failures: heartbeatFailures,
        maxFailures: env.USERBOT_HEARTBEAT_MAX_FAILURES,
        error: error instanceof Error ? error.message : String(error)
      });

      if (heartbeatFailures >= env.USERBOT_HEARTBEAT_MAX_FAILURES) {
        await writeError("Userbot heartbeat failure limit reached; exiting process for supervisor restart", error, {
          failures: heartbeatFailures,
          maxFailures: env.USERBOT_HEARTBEAT_MAX_FAILURES
        });

        process.exit(1);
      }
    }
  };

  const runThrottledTelegramWrite = async <T>(operationName: string, operation: () => Promise<T>): Promise<T> => {
    const task = outboundQueue.then(async () => {
      const now = Date.now();
      const baseWaitMs = Math.max(0, lastOutboundWriteAt + outboundMinDelayMs - now);
      const jitterWaitMs = Math.floor(Math.random() * (outboundJitterMs + 1));
      const totalWaitMs = baseWaitMs + jitterWaitMs;

      if (totalWaitMs > 0) {
        await sleep(totalWaitMs);
      }

      while (true) {
        try {
          const result = await operation();
          lastOutboundWriteAt = Date.now();
          return result;
        } catch (error) {
          const floodWaitSeconds = parseFloodWaitSeconds(error);
          if (floodWaitSeconds === null) {
            lastOutboundWriteAt = Date.now();
            throw error;
          }

          const retryAfterMs = floodWaitSeconds * 1000 + 500 + Math.floor(Math.random() * 300);
          await writeWarn("Telegram flood wait detected, retrying throttled write", {
            operation: operationName,
            retryAfterMs,
            floodWaitSeconds
          });
          await sleep(retryAfterMs);
        }
      }
    });

    outboundQueue = task.then(
      () => undefined,
      () => undefined
    );

    return task;
  };

  const resolveDriverInputPeer = async (driverChatId: number, forceRefresh = false): Promise<any> => {
    if (!forceRefresh) {
      const cached = driverInputPeerByChatId.get(driverChatId);
      if (cached) {
        return cached;
      }
    }

    if (forceRefresh) {
      driverInputPeerByChatId.delete(driverChatId);
      // Refresh local dialog/entity cache after membership or permission changes.
      await client.getDialogs({ limit: 500 });
    }

    const inputPeer = await client.getInputEntity(driverChatId);
    driverInputPeerByChatId.set(driverChatId, inputPeer);
    return inputPeer;
  };

  const withDriverPeerRetry = async <T>(
    operationName: string,
    driverChatId: number,
    operation: (driverInputPeer: any) => Promise<T>
  ): Promise<T> => {
    try {
      const driverInputPeer = await resolveDriverInputPeer(driverChatId);
      return await operation(driverInputPeer);
    } catch (error) {
      if (!isInputEntityResolveError(error)) {
        throw error;
      }

      await writeWarn("Driver chat peer unresolved, refreshing dialogs and retrying", {
        operation: operationName,
        driverChatId,
        error: error instanceof Error ? error.message : String(error)
      });

      const driverInputPeer = await resolveDriverInputPeer(driverChatId, true);
      return await operation(driverInputPeer);
    }
  };

  const markSourceChatUnreachable = async (
    sourceChatIdNumber: number,
    stage: string,
    error: unknown
  ): Promise<void> => {
    if (!isChannelAccessError(error)) {
      return;
    }

    unreachableSourceChatIds.add(sourceChatIdNumber);
    if (unreachableSourceChatLogCache.has(sourceChatIdNumber)) {
      return;
    }

    unreachableSourceChatLogCache.add(sourceChatIdNumber);
    await writeWarn("Source chat unreachable, skipping future scans for this chat", {
      sourceChatId: String(sourceChatIdNumber),
      stage,
      error: error instanceof Error ? error.message : String(error),
      hint: "Userbot is not a member or chat id is invalid. Remove from .env or join the group."
    });
  };

  const markSeenSourceMessageId = (sourceChatIdNumber: number, sourceMessageId: number): void => {
    if (!Number.isInteger(sourceMessageId) || sourceMessageId <= 0) {
      return;
    }

    const previous = highestSeenSourceMessageId.get(sourceChatIdNumber) ?? 0;
    if (sourceMessageId > previous) {
      highestSeenSourceMessageId.set(sourceChatIdNumber, sourceMessageId);
    }
  };

  const resolveDeleteCapability = async (sourceChatIdNumber: number): Promise<boolean> => {
    const cached = deleteCapabilityBySourceChat.get(sourceChatIdNumber);
    if (cached !== undefined) {
      return cached;
    }

    let canDelete = false;
    try {
      const entity = await client.getEntity(sourceChatIdNumber);
      canDelete = canDeleteMessagesInChat(entity);
    } catch (error) {
      await writeWarn("Failed to resolve source delete permission", {
        sourceChatId: String(sourceChatIdNumber),
        error: error instanceof Error ? error.message : String(error)
      });
    }

    deleteCapabilityBySourceChat.set(sourceChatIdNumber, canDelete);
    await writeInfo("Source delete permission cached", {
      sourceChatId: String(sourceChatIdNumber),
      canDelete
    });

    return canDelete;
  };

  const resolveUserbotWriteCapability = async (chatIdNumber: number): Promise<boolean> => {
    const cached = writeCapabilityByChatId.get(chatIdNumber);
    if (cached !== undefined) {
      return cached;
    }

    let canWrite = false;
    try {
      const me = await client.getMe();
      const participantResult = await client.invoke(
        new Api.channels.GetParticipant({
          channel: chatIdNumber,
          participant: Number(me.id)
        })
      );
      canWrite = canPostMessagesFromParticipant(participantResult.participant);
    } catch (participantError) {
      try {
        const entity = await client.getEntity(chatIdNumber);
        canWrite = canPostMessagesInChat(entity);
      } catch (entityError) {
        const accessError = participantError ?? entityError;
        if (isChannelAccessError(accessError)) {
          await markSourceChatUnreachable(chatIdNumber, "write_permission", accessError);
        }

        await writeWarn("Failed to resolve userbot write permission", {
          chatId: String(chatIdNumber),
          error: accessError instanceof Error ? accessError.message : String(accessError)
        });
      }
    }

    writeCapabilityByChatId.set(chatIdNumber, canWrite);
    await writeInfo("Userbot write permission cached", {
      chatId: String(chatIdNumber),
      canWrite
    });

    return canWrite;
  };

  const guardUserbotChannelWrite = async (
    chatIdNumber: number,
    operation: string,
    meta?: Record<string, unknown>
  ): Promise<boolean> => {
    if (env.USERBOT_READ_ONLY) {
      await writeInfo("Userbot channel write skipped: read-only mode is enabled", {
        chatId: String(chatIdNumber),
        operation,
        isPassengerSource: isPassengerSourceChatId(chatIdNumber),
        isDriverChat: isDriverChatId(chatIdNumber),
        ...meta
      });
      return false;
    }

    const allowed = await resolveUserbotWriteCapability(chatIdNumber);
    if (!allowed) {
      await writeWarn("Userbot channel write skipped: userbot is not admin", {
        chatId: String(chatIdNumber),
        operation,
        isPassengerSource: isPassengerSourceChatId(chatIdNumber),
        isDriverChat: isDriverChatId(chatIdNumber),
        ...meta
      });
    }

    return allowed;
  };

  const sendUserbotChannelMessage = async (
    chatIdNumber: number,
    operation: string,
    messageOptions: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<boolean> => {
    if (shouldBlockPassengerGroupWrite(chatIdNumber)) {
      return false;
    }

    if (!(await guardUserbotChannelWrite(chatIdNumber, operation, meta))) {
      return false;
    }

    await runThrottledTelegramWrite(operation, async () => client.sendMessage(chatIdNumber, messageOptions));
    return true;
  };

  const resolveSenderProtectionFlags = async (
    sourceChatIdNumber: number,
    driverChatId: number,
    senderId: string
  ): Promise<{ isSourceAdmin: boolean; isDriverChatMember: boolean }> => {
    const senderUserId = toPositiveUserId(senderId);
    if (senderUserId === null) {
      return { isSourceAdmin: false, isDriverChatMember: false };
    }

    const sourceAdminCacheKey = `${sourceChatIdNumber}:${senderUserId}`;
    let isSourceAdmin = sourceAdminByChatAndUser.get(sourceAdminCacheKey);
    if (env.ADMIN_TELEGRAM_ID && senderUserId === env.ADMIN_TELEGRAM_ID) {
      isSourceAdmin = true;
      sourceAdminByChatAndUser.set(sourceAdminCacheKey, true);
    }

    if (isSourceAdmin === undefined) {
      try {
        const participantResult = await client.invoke(
          new Api.channels.GetParticipant({
            channel: sourceChatIdNumber,
            participant: senderUserId
          })
        );
        const participant = participantResult.participant;
        isSourceAdmin = participant instanceof Api.ChannelParticipantAdmin || participant instanceof Api.ChannelParticipantCreator;
      } catch {
        isSourceAdmin = false;
      }
      sourceAdminByChatAndUser.set(sourceAdminCacheKey, isSourceAdmin);
    }

    let isDriverChatMember = false;
    const driverChatIdsToCheck = [...new Set([driverChatId, ...env.DRIVER_CHAT_IDS])];
    for (const candidateDriverChatId of driverChatIdsToCheck) {
      const driverMembershipCacheKey = `${candidateDriverChatId}:${senderUserId}`;
      let isMemberInCandidate = driverMembershipByChatAndUser.get(driverMembershipCacheKey);
      if (isMemberInCandidate === undefined) {
        try {
          const participantResult = await client.invoke(
            new Api.channels.GetParticipant({
              channel: candidateDriverChatId,
              participant: senderUserId
            })
          );
          const participant = participantResult.participant;
          isMemberInCandidate = !(participant instanceof Api.ChannelParticipantLeft || participant instanceof Api.ChannelParticipantBanned);
        } catch {
          isMemberInCandidate = false;
        }
        driverMembershipByChatAndUser.set(driverMembershipCacheKey, isMemberInCandidate);
      }

      if (isMemberInCandidate) {
        isDriverChatMember = true;
        break;
      }
    }

    return { isSourceAdmin, isDriverChatMember };
  };

  const sendSourceLinkFallback = async (payload: UnifiedIncomingMessage, driverChatId: number, originalText: string): Promise<void> => {
    const fallbackDriverChatId = getEffectiveDriverChatIdForPayload(payload, driverChatId);
    if (!(await guardUserbotChannelWrite(fallbackDriverChatId, "send_source_link_fallback", {
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId
    }))) {
      return;
    }

    const sourceMessageLink = buildSourceMessageLink(payload.sourceChatId, payload.sourceMessageId, getSourceUsernameForLink(payload));
    if (sourceMessageLink) {
      try {
        await runThrottledTelegramWrite("send_source_link_fallback", async () =>
          withDriverPeerRetry("send_source_link_fallback", fallbackDriverChatId, async (driverInputPeer) =>
            client.sendMessage(driverInputPeer, {
              message: [
                "Forward qilib bo'lmadi, original xabar linki:",
                sourceMessageLink,
                "",
                "Xabar:",
                originalText.slice(0, 2500)
              ].join("\n")
            })
          )
        );
      } catch (linkSendError) {
        await writeWarn("Failed to send source link fallback to driver chat", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId,
          driverChatId: fallbackDriverChatId,
          error: linkSendError instanceof Error ? linkSendError.message : String(linkSendError)
        });
      }
    } else {
      await writeWarn("Forward failed and no source link available, keeping info-only delivery", {
        sourceChatId: payload.sourceChatId,
        sourceMessageId: payload.sourceMessageId
      });
    }
  };

  const buildActions = (
    payload: UnifiedIncomingMessage,
    sourceChatIdNumber: number,
    driverChatId: number,
    canDeleteFromSource: boolean,
    resolveForwardFromPeer: () => Promise<any>
  ): UnifiedMessageActions => {
    const actions: UnifiedMessageActions = {
      sendToDriver: async (formattedText, _originalText) => {
        if (env.USERBOT_READ_ONLY || env.DRIVER_DELIVERY_MODE === "bot") {
          return await sendDriverLeadViaBotBridge({
            payload,
            driverChatId,
            formattedText,
            originalText: _originalText
          });
        }

        const effectiveDriverChatId = getEffectiveDriverChatIdForPayload(payload, driverChatId);
        if (!(await guardUserbotChannelWrite(effectiveDriverChatId, "send_driver_summary", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId
        }))) {
          throw new Error("Userbot is not admin in driver channel");
        }

        const senderUserId = toPositiveUserId(payload.senderId);
        const contactUrl = senderUserId !== null ? `tg://user?id=${senderUserId}` : null;
        const sent = await runThrottledTelegramWrite("send_driver_summary", async () =>
          withDriverPeerRetry("send_driver_summary", driverChatId, async (driverInputPeer) => {
            const sendArgs: Record<string, unknown> = {
              message: formattedText
            };

            if (contactUrl) {
              sendArgs.buttons = [
                [
                  {
                    text: "🚕 MIJOZGA YOZISH",
                    url: contactUrl
                  }
                ]
              ];
            }

            return client.sendMessage(driverInputPeer, sendArgs);
          })
        );
        let forwardedOriginal = false;
        let forwardedContactVisible = false;

        try {
          const fromPeer = await resolveForwardFromPeer();
          const forwardedMessages = await runThrottledTelegramWrite("forward_original_message", async () =>
            withDriverPeerRetry("forward_original_message", driverChatId, async (driverInputPeer) =>
              client.forwardMessages(driverInputPeer, {
                messages: [payload.sourceMessageId],
                fromPeer
              })
            )
          );
          forwardedOriginal = true;

          const firstForwardedMessage = Array.isArray(forwardedMessages) ? forwardedMessages[0] : null;
          const forwardedFromId = (firstForwardedMessage as any)?.fwdFrom?.fromId;
          forwardedContactVisible = forwardedFromId instanceof Api.PeerUser;
        } catch (forwardError) {
          await writeWarn("Failed to forward original source message to driver chat", {
            sourceChatId: payload.sourceChatId,
            sourceMessageId: payload.sourceMessageId,
            error: forwardError instanceof Error ? forwardError.message : String(forwardError)
          });

          await sendSourceLinkFallback(payload, driverChatId, _originalText);
        }

        return {
          driverMessageId: sent.id,
          forwardedOriginal,
          forwardedContactVisible
        };
      },
      notifyPassenger: async (text: string) => {
        const senderUserId = toPositiveUserId(payload.senderId);
        if (senderUserId === null) {
          await writeWarn("Cannot notify passenger: senderId is not a user ID", {
            sourceChatId: payload.sourceChatId,
            sourceMessageId: payload.sourceMessageId,
            senderId: payload.senderId
          });
          return;
        }

        if (env.USERBOT_READ_ONLY) {
          const sent = await sendTelegramBotMessage(senderUserId, text);
          if (!sent) {
            await writeInfo("Passenger private notify skipped: Bot API token is not configured", {
              sourceChatId: payload.sourceChatId,
              sourceMessageId: payload.sourceMessageId,
              senderId: payload.senderId
            });
          }
          return;
        }

        await runThrottledTelegramWrite("notify_passenger", async () =>
          client.sendMessage(senderUserId, {
            message: text
          })
        );
      },
      notifySourceChat: async (text: string, options?: { replyToSource?: boolean }) => {
        if (shouldBlockPassengerGroupWrite(sourceChatIdNumber)) {
          return;
        }

        if (env.USERBOT_READ_ONLY) {
          const botMessageOptions = options?.replyToSource ? { replyToMessageId: payload.sourceMessageId } : {};
          const sent = await sendTelegramBotMessage(sourceChatIdNumber, text, botMessageOptions);

          if (!sent) {
            await writeWarn("Passenger source notify skipped: Bot API token is not configured", {
              sourceChatId: payload.sourceChatId,
              sourceMessageId: payload.sourceMessageId
            });
          }
          return;
        }

        const messageOptions: Record<string, unknown> = {
          message: text
        };

        if (options?.replyToSource) {
          messageOptions.replyTo = payload.sourceMessageId;
        }

        await sendUserbotChannelMessage(sourceChatIdNumber, "notify_source_chat", messageOptions, {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId
        });
      }
    };

    if (canDeleteFromSource && !env.USERBOT_READ_ONLY) {
      actions.deleteFromSource = async () => {
        if (!(await guardUserbotChannelWrite(sourceChatIdNumber, "delete_source_message", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId
        }))) {
          return;
        }

        await runThrottledTelegramWrite("delete_source_message", async () =>
          client.deleteMessages(sourceChatIdNumber, [payload.sourceMessageId], {
            revoke: true
          })
        );
      };
    }

    return actions;
  };

  const processStoredSourceMessage = async (
    sourceChatIdNumber: number,
    driverChatId: number,
    message: any,
    canDeleteFromSource: boolean,
    shouldScanByMessageId: (messageId: number) => boolean
  ): Promise<StoredMessageScanResult> => {
    const messageId = Number(message?.id ?? 0);
    if (!Number.isInteger(messageId) || messageId <= 0 || !shouldScanByMessageId(messageId)) {
      return { scanned: false, leadResult: null };
    }

    markSeenSourceMessageId(sourceChatIdNumber, messageId);
    if (message.out === true && !env.LISTENER_PROCESS_OUTGOING_MESSAGES) {
      return { scanned: true, leadResult: null };
    }

    try {
      const built = await buildUnifiedPayloadFromStoredMessage(client, sourceChatIdNumber, message);
      if (!built) {
        return { scanned: true, leadResult: null };
      }
      applyKnownSourceUsernameFallback(built.payload);
      built.payload.isStartupBackfill = true;

      const effectiveDriverChatId = getEffectiveDriverChatIdForPayload(built.payload, driverChatId);
      if (shouldResolveSenderProtectionFlags) {
        const senderFlags = await resolveSenderProtectionFlags(sourceChatIdNumber, effectiveDriverChatId, built.payload.senderId);
        built.payload.isSourceAdmin = senderFlags.isSourceAdmin;
        built.payload.isDriverChatMember = senderFlags.isDriverChatMember;
      }

      const actions = buildActions(
        built.payload,
        sourceChatIdNumber,
        effectiveDriverChatId,
        canDeleteFromSource,
        async () => sourceChatIdNumber
      );

      const leadResult = await processIncomingLead(built.payload, actions);
      return { scanned: true, leadResult };
    } catch (error) {
      if (classifySessionAuthError(error)) {
        throw error;
      }

      await writeWarn("Failed to process stored source message", {
        sourceChatId: String(sourceChatIdNumber),
        sourceMessageId: messageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return { scanned: true, leadResult: null };
    }
  };

  const getOrderedSourceMessages = async (sourceChatIdNumber: number, limit: number): Promise<any[]> => {
    try {
      const recent = await client.getMessages(sourceChatIdNumber, { limit });
      return [...recent].filter(Boolean).sort((a: any, b: any) => Number(a?.id ?? 0) - Number(b?.id ?? 0));
    } catch (error) {
      await markSourceChatUnreachable(sourceChatIdNumber, "fetch_messages", error);
      return [];
    }
  };

  const resolveSourceScanContext = async (
    stage: "startup backfill" | "periodic catch-up",
    sourceChatIdNumber: number
  ): Promise<{ sourceRegion: SourceRegion; driverChatId: number } | null> => {
    if (unreachableSourceChatIds.has(sourceChatIdNumber)) {
      return null;
    }

    const sourceRegion = getSourceRegionByPassengerChatId(sourceChatIdNumber);
    const driverChatId = getDriverChatIdBySourceChatId(sourceChatIdNumber);
    if (!sourceRegion || driverChatId === null) {
      await writeWarn(`Skipping ${stage}: source chat missing region/driver mapping`, {
        sourceChatId: String(sourceChatIdNumber)
      });
      return null;
    }

    return { sourceRegion, driverChatId };
  };

  const scanStoredSourceMessages = async (params: {
    sourceChatIdNumber: number;
    driverChatId: number;
    messages: any[];
    canDeleteFromSource: boolean;
    shouldScanByMessageId: (messageId: number) => boolean;
  }): Promise<SourceScanStats> => {
    const stats = createSourceScanStats();

    for (const message of params.messages) {
      if (!message) {
        continue;
      }

      const result = await processStoredSourceMessage(
        params.sourceChatIdNumber,
        params.driverChatId,
        message,
        params.canDeleteFromSource,
        params.shouldScanByMessageId
      );
      recordSourceScanResult(stats, result);
    }

    return stats;
  };

  const runStartupBackfill = async (): Promise<void> => {
    if (startupBackfillLimit === 0 || listenerBlockedBySessionAuthError || startupBackfillCompleted) {
      return;
    }

    startupBackfillCompleted = true;

    for (const sourceChatIdNumber of env.PASSENGER_CHAT_IDS) {
      try {
        const scanContext = await resolveSourceScanContext("startup backfill", sourceChatIdNumber);
        if (!scanContext) {
          continue;
        }

        const { sourceRegion, driverChatId } = scanContext;
        const canDeleteFromSource =
          env.DELETE_SOURCE_MESSAGE_IF_ADMIN && env.STARTUP_BACKFILL_DELETE_SOURCE
            ? await resolveDeleteCapability(sourceChatIdNumber)
            : false;
        const latestStored = await prisma.lead.findFirst({
          where: { sourceChatId: String(sourceChatIdNumber) },
          select: { sourceMessageId: true },
          orderBy: { sourceMessageId: "desc" }
        });
        const latestStoredSourceMessageId = latestStored?.sourceMessageId ?? 0;
        const ordered = await getOrderedSourceMessages(sourceChatIdNumber, startupBackfillLimit);
        markSeenSourceMessageId(sourceChatIdNumber, latestStoredSourceMessageId);
        const stats = await scanStoredSourceMessages({
          sourceChatIdNumber,
          driverChatId,
          messages: ordered,
          canDeleteFromSource,
          shouldScanByMessageId: (messageId) => messageId > latestStoredSourceMessageId
        });

        await writeInfo("Userbot startup backfill completed", {
          sourceChatId: String(sourceChatIdNumber),
          sourceRegion,
          driverChatId,
          fetched: ordered.length,
          scanned: stats.scanned,
          limit: startupBackfillLimit,
          latestStoredSourceMessageId,
          processed: stats.processed,
          sent: stats.sent,
          skipped: stats.skipped,
          topSkippedReasons: getTopSkippedReasons(stats)
        });
      } catch (error) {
        const isSessionAuthFailure = await handleSessionAuthFailure("startup_backfill", error, {
          sourceChatId: String(sourceChatIdNumber)
        });
        if (isSessionAuthFailure) {
          throw new Error(buildSessionRecoveryHint(classifySessionAuthError(error)!));
        }

        await markSourceChatUnreachable(sourceChatIdNumber, "startup_backfill", error);
        await writeWarn("Userbot startup backfill failed for source chat", {
          sourceChatId: String(sourceChatIdNumber),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const runPeriodicCatchUp = async (): Promise<void> => {
    if (!periodicCatchUpEnabled || periodicCatchUpLimit <= 0 || periodicCatchUpInFlight || listenerBlockedBySessionAuthError) {
      return;
    }

    periodicCatchUpInFlight = true;

    try {
      for (const sourceChatIdNumber of env.PASSENGER_CHAT_IDS) {
        try {
          const scanContext = await resolveSourceScanContext("periodic catch-up", sourceChatIdNumber);
          if (!scanContext) {
            continue;
          }

          const { sourceRegion, driverChatId } = scanContext;
          const ordered = await getOrderedSourceMessages(sourceChatIdNumber, periodicCatchUpLimit);
          const canDeleteFromSource = getDeleteSourceMessageIfAdmin(sourceRegion) ? await resolveDeleteCapability(sourceChatIdNumber) : false;
          const stats = await scanStoredSourceMessages({
            sourceChatIdNumber,
            driverChatId,
            messages: ordered,
            canDeleteFromSource,
            shouldScanByMessageId: (messageId) => messageId > (highestSeenSourceMessageId.get(sourceChatIdNumber) ?? 0)
          });

          if (stats.scanned > 0) {
            await writeInfo("Userbot periodic catch-up completed", {
              sourceChatId: String(sourceChatIdNumber),
              sourceRegion,
              driverChatId,
              fetched: ordered.length,
              scannedFresh: stats.scanned,
              processed: stats.processed,
              sent: stats.sent,
              skipped: stats.skipped,
              topSkippedReasons: getTopSkippedReasons(stats)
            });
          }
        } catch (error) {
          const isSessionAuthFailure = await handleSessionAuthFailure("periodic_catch_up", error, {
            sourceChatId: String(sourceChatIdNumber)
          });
          if (isSessionAuthFailure) {
            break;
          }

          await writeWarn("Userbot periodic catch-up failed for source chat", {
            sourceChatId: String(sourceChatIdNumber),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      periodicCatchUpInFlight = false;
    }
  };

  const handler = async (event: NewMessageEvent): Promise<void> => {
    const handlerStartedAtMs = Date.now();
    let eventAgeMs: number | null = null;

    try {
      if (listenerBlockedBySessionAuthError) {
        return;
      }

      const commandText = toText(event.message.message).trim();
      const commandHandled = await handleAdminCommand(client, event, commandText, state, guardUserbotChannelWrite);
      if (commandHandled) {
        return;
      }

      if (state.paused) {
        return;
      }

      const eventDateMs = getMessageDate(event.message.date).getTime();
      eventAgeMs = Math.max(0, handlerStartedAtMs - eventDateMs);
      const backfillWindowMs = Math.max(0, env.LISTENER_BACKFILL_SECONDS) * 1000;
      if (eventDateMs < listenerStartedAtMs - backfillWindowMs) {
        return;
      }

      const payload = await buildUnifiedPayload(client, event, {
        sourceIdentityByChatId,
        senderIdentityByUserId
      });
      if (!payload) {
        const peerId = event.message.peerId;
        if (peerId) {
          try {
            const candidatePeer = toNumberId(getPeerId(peerId, true));
            const configuredRegion = candidatePeer === null ? null : getSourceRegionByPassengerChatId(candidatePeer);
            const shouldIgnoreLog =
              candidatePeer === null ||
              isDriverChatId(candidatePeer) ||
              candidatePeer === env.ADMIN_TELEGRAM_ID ||
              env.PASSENGER_CHAT_IDS.includes(candidatePeer) ||
              configuredRegion !== null;

            if (!shouldIgnoreLog && !ignoredSourceLogCache.has(candidatePeer)) {
              ignoredSourceLogCache.add(candidatePeer);
              await writeInfo("Message ignored: source chat not in configured list", {
                candidatePeerId: candidatePeer,
                configuredSourceChats: env.PASSENGER_CHAT_IDS
              });
            }
          } catch {
            // ignore
          }
        }
        return;
      }

      const sourceChatIdNumber = toNumericId(payload.sourceChatId);
      if (sourceChatIdNumber === null) {
        return;
      }
      applyKnownSourceUsernameFallback(payload);
      notifyAdminAboutWatchedSource(payload, eventAgeMs);

      const driverChatId = getDriverChatIdBySourceChatId(sourceChatIdNumber);
      if (driverChatId === null) {
        await writeWarn("Message skipped: source chat has no driver mapping", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId
        });
        return;
      }
      const effectiveDriverChatId = getEffectiveDriverChatIdForPayload(payload, driverChatId);

      markSeenSourceMessageId(sourceChatIdNumber, payload.sourceMessageId);

      if (shouldResolveSenderProtectionFlags) {
        const senderFlags = await resolveSenderProtectionFlags(sourceChatIdNumber, effectiveDriverChatId, payload.senderId);
        payload.isSourceAdmin = senderFlags.isSourceAdmin;
        payload.isDriverChatMember = senderFlags.isDriverChatMember;
      }

      const canDeleteFromSource = getDeleteSourceMessageIfAdmin(payload.sourceRegion) ? await resolveDeleteCapability(sourceChatIdNumber) : false;
      const actions = buildActions(
        payload,
        sourceChatIdNumber,
        effectiveDriverChatId,
        canDeleteFromSource,
        async () => (await event.getInputChat()) ?? sourceChatIdNumber
      );

      const result = await processIncomingLead(payload, actions);

      const messageLogFields = buildInboundMessageLogFields(payload.text);

      if (result.processed) {
        void writeInfo("Userbot message processed", {
          sourceChatId: payload.sourceChatId,
          sourceRegion: payload.sourceRegion,
          driverChatId: effectiveDriverChatId,
          sourceMessageId: payload.sourceMessageId,
          status: LeadStatus.SENT,
          reason: result.reason,
          eventAgeMs,
          processingMs: Date.now() - handlerStartedAtMs,
          configuredOutboundMinDelayMs: outboundMinDelayMs,
          configuredOutboundJitterMs: outboundJitterMs,
          ...messageLogFields
        });
      } else {
        void writeWarn("Userbot message skipped", {
          sourceChatId: payload.sourceChatId,
          sourceRegion: payload.sourceRegion,
          driverChatId: effectiveDriverChatId,
          sourceMessageId: payload.sourceMessageId,
          reason: result.reason,
          eventAgeMs,
          processingMs: Date.now() - handlerStartedAtMs,
          configuredOutboundMinDelayMs: outboundMinDelayMs,
          configuredOutboundJitterMs: outboundJitterMs,
          ...messageLogFields
        });
      }
    } catch (error) {
      const isSessionAuthFailure = await handleSessionAuthFailure("event_handler", error);
      if (isSessionAuthFailure) {
        return;
      }

      await writeError("Unhandled userbot listener error", error);
    }
  };

  // Register live listener first so new messages are handled immediately.
  client.addEventHandler(
    handler,
    new NewMessage(env.LISTENER_PROCESS_OUTGOING_MESSAGES ? {} : { incoming: true })
  );

  for (const sourceChatIdNumber of env.PASSENGER_CHAT_IDS) {
    warmSourceIdentityCache(sourceChatIdNumber);
  }

  void resolveConfiguredPassengerUsernameSources(client).catch(async (error) => {
    await writeWarn("Failed to resolve configured passenger usernames", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  void runStartupBackfill().catch(async (error) => {
    await writeError("Userbot startup backfill failed", error);
  });

  if (periodicCatchUpEnabled && periodicCatchUpLimit > 0) {
    setInterval(() => {
      void runPeriodicCatchUp();
    }, periodicCatchUpIntervalMs).unref();
  }

  if (env.USERBOT_HEARTBEAT_INTERVAL_MS > 0) {
    setInterval(() => {
      void runHeartbeat();
    }, env.USERBOT_HEARTBEAT_INTERVAL_MS).unref();
  }

  if (configuredStartupBackfillLimit > maxStartupBackfillLimit) {
    await writeWarn("LISTENER_STARTUP_BACKFILL_LIMIT capped to protect from duplicate/flood bursts", {
      configured: configuredStartupBackfillLimit,
      applied: startupBackfillLimit
    });
  }

  await writeInfo("Userbot outbound throttle enabled", {
    minDelayMs: outboundMinDelayMs,
    jitterMs: outboundJitterMs
  });

  if (periodicCatchUpEnabled && periodicCatchUpLimit > 0) {
    await writeInfo("Userbot periodic catch-up enabled", {
      intervalMs: periodicCatchUpIntervalMs,
      limit: periodicCatchUpLimit
    });
  } else {
    await writeInfo("Userbot periodic catch-up disabled", {
      enabled: periodicCatchUpEnabled,
      limit: periodicCatchUpLimit
    });
  }

  await writeInfo("Userbot heartbeat watchdog configured", {
    intervalMs: env.USERBOT_HEARTBEAT_INTERVAL_MS,
    maxFailures: env.USERBOT_HEARTBEAT_MAX_FAILURES
  });

  for (const sourceChatIdNumber of env.PASSENGER_CHAT_IDS) {
    const canWrite = await resolveUserbotWriteCapability(sourceChatIdNumber);
    await writeInfo("Passenger source write permission", {
      sourceChatId: String(sourceChatIdNumber),
      region: getSourceRegionByPassengerChatId(sourceChatIdNumber),
      canWriteAsAdmin: canWrite,
      autoRepliesEnabled: env.PASSENGER_GROUP_AUTO_REPLIES
    });
  }

  await writeInfo("Userbot listener started", {
    sourceChats: env.PASSENGER_CHAT_IDS,
    passengerByRegion: env.PASSENGER_CHAT_IDS_BY_REGION,
    passengerUsernamesByRegion: env.PASSENGER_CHAT_USERNAMES_BY_REGION,
    driverByRegion: env.DRIVER_CHAT_ID_BY_REGION,
    driverDeliveryMode: env.DRIVER_DELIVERY_MODE,
    driverDeliveryRequestedMode: env.DRIVER_DELIVERY_REQUESTED_MODE,
    processOutgoingMessages: env.LISTENER_PROCESS_OUTGOING_MESSAGES,
    startupBackfillLimit,
    periodicCatchUpEnabled,
    periodicCatchUpLimit,
    heartbeatIntervalMs: env.USERBOT_HEARTBEAT_INTERVAL_MS,
    heartbeatMaxFailures: env.USERBOT_HEARTBEAT_MAX_FAILURES,
    passengerGroupAutoReplies: env.PASSENGER_GROUP_AUTO_REPLIES,
    sendDriverAdWarnings: env.SEND_DRIVER_AD_WARNINGS,
    userbotReadOnly: env.USERBOT_READ_ONLY,
    passengerChannelWrites: env.USERBOT_READ_ONLY ? "bot_api_when_enabled" : "admin_only",
    adminId: env.ADMIN_TELEGRAM_ID
  });
}
