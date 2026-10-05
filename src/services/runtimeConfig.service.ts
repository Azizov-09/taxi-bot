import { readFile, writeFile } from "node:fs/promises";
import {
  ENV_FILE_PATH,
  env,
  normalizeTelegramChatUsername,
  registerResolvedPassengerChat,
  registerResolvedPassengerChatUsername,
  unregisterResolvedPassengerChat,
  unregisterResolvedPassengerChatUsername,
  unsetEnvDriverRegion,
  type SourceRegion
} from "../config/env.js";
import { prisma } from "../prisma/client.js";

const SOURCE_REGIONS: SourceRegion[] = ["TASHKENT", "GULISTON", "KOMSOMOL", "ANDIJON"];
const RUNTIME_CONFIG_KEYS = [
  "SOURCE_CHAT_IDS",
  "PASSENGER_CHAT_IDS",
  "PASSENGER_CHAT_IDS_TASHKENT",
  "PASSENGER_CHAT_IDS_GULISTON",
  "PASSENGER_CHAT_IDS_KOMSOMOL",
  "PASSENGER_CHAT_IDS_ANDIJON",
  "PASSENGER_CHAT_USERNAMES",
  "PASSENGER_CHAT_USERNAMES_TASHKENT",
  "PASSENGER_CHAT_USERNAMES_GULISTON",
  "PASSENGER_CHAT_USERNAMES_KOMSOMOL",
  "PASSENGER_CHAT_USERNAMES_ANDIJON",
  "DRIVER_CHAT_ID",
  "DRIVER_CHAT_ID_TASHKENT",
  "DRIVER_CHAT_ID_GULISTON",
  "DRIVER_CHAT_ID_KOMSOMOL",
  "DRIVER_CHAT_ID_ANDIJON",
  "PASSENGER_GROUP_AUTO_REPLIES",
  "PASSENGER_GROUP_AUTO_REPLIES_TASHKENT",
  "PASSENGER_GROUP_AUTO_REPLIES_GULISTON",
  "PASSENGER_GROUP_AUTO_REPLIES_KOMSOMOL",
  "PASSENGER_GROUP_AUTO_REPLIES_ANDIJON",
  "SEND_PRIVATE_ACK_TO_PASSENGER",
  "SEND_PRIVATE_ACK_TO_PASSENGER_TASHKENT",
  "SEND_PRIVATE_ACK_TO_PASSENGER_GULISTON",
  "SEND_PRIVATE_ACK_TO_PASSENGER_KOMSOMOL",
  "SEND_PRIVATE_ACK_TO_PASSENGER_ANDIJON",
  "DELETE_SOURCE_MESSAGE_IF_ADMIN",
  "DELETE_SOURCE_MESSAGE_IF_ADMIN_TASHKENT",
  "DELETE_SOURCE_MESSAGE_IF_ADMIN_GULISTON",
  "DELETE_SOURCE_MESSAGE_IF_ADMIN_KOMSOMOL",
  "DELETE_SOURCE_MESSAGE_IF_ADMIN_ANDIJON",
  "DELETE_IGNORED_MESSAGE_IF_ADMIN",
  "DELETE_IGNORED_MESSAGE_IF_ADMIN_TASHKENT",
  "DELETE_IGNORED_MESSAGE_IF_ADMIN_GULISTON",
  "DELETE_IGNORED_MESSAGE_IF_ADMIN_KOMSOMOL",
  "DELETE_IGNORED_MESSAGE_IF_ADMIN_ANDIJON",
  "SEND_DRIVER_AD_WARNINGS",
  "USERBOT_READ_ONLY"
] as const;
const RUNTIME_CONFIG_KEY_SET = new Set<string>(RUNTIME_CONFIG_KEYS);

export type RuntimeBooleanSetting =
  | "PASSENGER_GROUP_AUTO_REPLIES"
  | "DELETE_SOURCE_MESSAGE_IF_ADMIN"
  | "DELETE_IGNORED_MESSAGE_IF_ADMIN"
  | "SEND_PRIVATE_ACK_TO_PASSENGER";

export type PassengerSourceAddResult = { kind: "chat_id"; value: number } | { kind: "username"; value: string };

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && !result.includes(value)) {
      result.push(value);
    }
  }

  return result;
}

function parseChatId(rawValue: string): number | null {
  const value = rawValue.trim();
  if (!/^-?\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) >= 1 ? parsed : null;
}

function parseChatIdFromTelegramLink(rawValue: string): number | null {
  const value = rawValue.trim();
  const match = value.match(/^https?:\/\/(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/\d+)?(?:[/?#].*)?$/iu);
  if (!match?.[1]) {
    return null;
  }

  const internalId = Number(match[1]);
  if (!Number.isSafeInteger(internalId) || internalId <= 0) {
    return null;
  }

  const chatId = Number(`-100${internalId}`);
  return Number.isSafeInteger(chatId) ? chatId : null;
}

export function parseTelegramChatIdInput(rawValue: string, currentChatId?: number): number | null {
  const normalized = rawValue.trim().toLowerCase();
  if (["shu", "this", "current", "hozirgi"].includes(normalized) && currentChatId !== undefined) {
    return currentChatId;
  }

  return parseChatId(rawValue) ?? parseChatIdFromTelegramLink(rawValue);
}

export function parseTelegramUsernameInput(rawValue: string): string | null {
  return normalizeTelegramChatUsername(rawValue);
}

export function parsePassengerSourceInput(rawValue: string, currentChatId?: number): PassengerSourceAddResult | null {
  const chatId = parseTelegramChatIdInput(rawValue, currentChatId);
  if (chatId !== null) {
    return { kind: "chat_id", value: chatId };
  }

  const username = parseTelegramUsernameInput(rawValue);
  if (username) {
    return { kind: "username", value: username };
  }

  return null;
}

export function parseSourceRegionInput(rawValue: string): SourceRegion | null {
  const normalized = rawValue.trim().toUpperCase();
  const aliases: Record<string, SourceRegion> = {
    ANDIJON: "ANDIJON",
    ANDIJAN: "ANDIJON",
    KOMSOMOL: "KOMSOMOL",
    GULISTON: "GULISTON",
    TASHKENT: "TASHKENT",
    TOSHKENT: "TASHKENT"
  };
  const resolved = aliases[normalized];
  if (resolved) {
    return resolved;
  }

  if (SOURCE_REGIONS.includes(normalized as SourceRegion)) {
    return normalized as SourceRegion;
  }

  return null;
}

function formatChatIdList(values: number[]): string {
  return uniqueNumbers(values).join(",");
}

function formatStringList(values: string[]): string {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].join(",");
}

function formatOnOff(value: boolean): string {
  return value ? "YONIQ" : "O'CHIQ";
}

function parseBooleanValue(rawValue: string): boolean | null {
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function parseChatIdListValue(rawValue: string): number[] {
  return rawValue
    .split(",")
    .map((value) => parseChatId(value))
    .filter((value): value is number => value !== null);
}

function parseUsernameListValue(rawValue: string): string[] {
  return rawValue
    .split(/[\s,]+/u)
    .map((value) => parseTelegramUsernameInput(value))
    .filter((value): value is string => value !== null);
}

function setPassengerChatList(region: SourceRegion, rawValue: string): void {
  for (const chatId of parseChatIdListValue(rawValue)) {
    registerResolvedPassengerChat(chatId, region);
  }
}

function setPassengerUsernameList(region: SourceRegion, rawValue: string): void {
  for (const username of parseUsernameListValue(rawValue)) {
    registerResolvedPassengerChatUsername(username, region);
  }
}

function applyRuntimeConfigValue(key: string, value: string): void {
  if (key === "SOURCE_CHAT_IDS" || key === "PASSENGER_CHAT_IDS") {
    setPassengerChatList("TASHKENT", value);
    return;
  }

  const passengerIdsRegion = key.match(/^PASSENGER_CHAT_IDS_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (passengerIdsRegion) {
    setPassengerChatList(passengerIdsRegion, value);
    return;
  }

  if (key === "PASSENGER_CHAT_USERNAMES") {
    setPassengerUsernameList("TASHKENT", value);
    return;
  }

  const passengerUsernamesRegion = key.match(/^PASSENGER_CHAT_USERNAMES_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (passengerUsernamesRegion) {
    setPassengerUsernameList(passengerUsernamesRegion, value);
    return;
  }

  if (key === "DRIVER_CHAT_ID") {
    const chatId = parseChatId(value);
    if (chatId !== null) {
      for (const region of SOURCE_REGIONS) {
        if (env.DRIVER_CHAT_ID_BY_REGION[region] === null) {
          setEnvDriverRegion(region, chatId);
        }
      }
    }
    return;
  }

  const driverRegion = key.match(/^DRIVER_CHAT_ID_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (driverRegion) {
    const chatId = parseChatId(value);
    if (chatId !== null) {
      setEnvDriverRegion(driverRegion, chatId);
    }
    return;
  }

  const delSourceMatch = key.match(/^DELETE_SOURCE_MESSAGE_IF_ADMIN_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (delSourceMatch) {
    const parsed = parseBooleanValue(value);
    env.DELETE_SOURCE_MESSAGE_IF_ADMIN_BY_REGION[delSourceMatch] = parsed;
    return;
  }

  const delIgnoredMatch = key.match(/^DELETE_IGNORED_MESSAGE_IF_ADMIN_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (delIgnoredMatch) {
    const parsed = parseBooleanValue(value);
    env.DELETE_IGNORED_MESSAGE_IF_ADMIN_BY_REGION[delIgnoredMatch] = parsed;
    return;
  }

  const autoReplyMatch = key.match(/^PASSENGER_GROUP_AUTO_REPLIES_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (autoReplyMatch) {
    const parsed = parseBooleanValue(value);
    env.PASSENGER_GROUP_AUTO_REPLIES_BY_REGION[autoReplyMatch] = parsed;
    return;
  }

  const privateAckMatch = key.match(/^SEND_PRIVATE_ACK_TO_PASSENGER_(TASHKENT|GULISTON|KOMSOMOL|ANDIJON)$/u)?.[1] as SourceRegion | undefined;
  if (privateAckMatch) {
    const parsed = parseBooleanValue(value);
    env.SEND_PRIVATE_ACK_TO_PASSENGER_BY_REGION[privateAckMatch] = parsed;
    return;
  }

  if (
    key === "PASSENGER_GROUP_AUTO_REPLIES" ||
    key === "SEND_PRIVATE_ACK_TO_PASSENGER" ||
    key === "DELETE_SOURCE_MESSAGE_IF_ADMIN" ||
    key === "DELETE_IGNORED_MESSAGE_IF_ADMIN"
  ) {
    const parsed = parseBooleanValue(value);
    if (parsed !== null) {
      env[key] = parsed;
    }
    return;
  }

  if (key === "SEND_DRIVER_AD_WARNINGS" || key === "USERBOT_READ_ONLY") {
    const parsed = parseBooleanValue(value);
    if (parsed !== null) {
      env[key] = parsed;
    }
  }
}

function getRuntimeConfigSnapshot(): Record<string, string> {
  const passengerRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getPassengerRegionalEnvKey(item), formatChatIdList(getPassengerRegionalList(item))])
  );
  const passengerUsernameRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getPassengerUsernameRegionalEnvKey(item), formatStringList(env.PASSENGER_CHAT_USERNAMES_BY_REGION[item])])
  );
  const driverRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getDriverRegionalEnvKey(item), env.DRIVER_CHAT_ID_BY_REGION[item] === null ? "" : String(env.DRIVER_CHAT_ID_BY_REGION[item])])
  );

  const regionalDelSourceUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [`DELETE_SOURCE_MESSAGE_IF_ADMIN_${item}`, env.DELETE_SOURCE_MESSAGE_IF_ADMIN_BY_REGION[item] === null ? "" : String(env.DELETE_SOURCE_MESSAGE_IF_ADMIN_BY_REGION[item])])
  );
  const regionalDelIgnoredUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [`DELETE_IGNORED_MESSAGE_IF_ADMIN_${item}`, env.DELETE_IGNORED_MESSAGE_IF_ADMIN_BY_REGION[item] === null ? "" : String(env.DELETE_IGNORED_MESSAGE_IF_ADMIN_BY_REGION[item])])
  );
  const regionalAutoReplyUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [`PASSENGER_GROUP_AUTO_REPLIES_${item}`, env.PASSENGER_GROUP_AUTO_REPLIES_BY_REGION[item] === null ? "" : String(env.PASSENGER_GROUP_AUTO_REPLIES_BY_REGION[item])])
  );
  const regionalPrivateAckUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [`SEND_PRIVATE_ACK_TO_PASSENGER_${item}`, env.SEND_PRIVATE_ACK_TO_PASSENGER_BY_REGION[item] === null ? "" : String(env.SEND_PRIVATE_ACK_TO_PASSENGER_BY_REGION[item])])
  );

  return {
    ...passengerRegionalUpdates,
    ...passengerUsernameRegionalUpdates,
    ...driverRegionalUpdates,
    ...regionalDelSourceUpdates,
    ...regionalDelIgnoredUpdates,
    ...regionalAutoReplyUpdates,
    ...regionalPrivateAckUpdates,
    SOURCE_CHAT_IDS: formatChatIdList(env.PASSENGER_CHAT_IDS),
    PASSENGER_CHAT_IDS: formatChatIdList(env.PASSENGER_CHAT_IDS),
    PASSENGER_CHAT_USERNAMES: formatStringList(env.PASSENGER_CHAT_USERNAMES),
    DRIVER_CHAT_ID: env.DRIVER_CHAT_ID === 0 ? "" : String(env.DRIVER_CHAT_ID),
    PASSENGER_GROUP_AUTO_REPLIES: String(env.PASSENGER_GROUP_AUTO_REPLIES),
    SEND_PRIVATE_ACK_TO_PASSENGER: String(env.SEND_PRIVATE_ACK_TO_PASSENGER),
    DELETE_SOURCE_MESSAGE_IF_ADMIN: String(env.DELETE_SOURCE_MESSAGE_IF_ADMIN),
    DELETE_IGNORED_MESSAGE_IF_ADMIN: String(env.DELETE_IGNORED_MESSAGE_IF_ADMIN),
    SEND_DRIVER_AD_WARNINGS: String(env.SEND_DRIVER_AD_WARNINGS),
    USERBOT_READ_ONLY: String(env.USERBOT_READ_ONLY)
  };
}

async function upsertRuntimeConfigValues(updates: Record<string, string>): Promise<void> {
  const entries = Object.entries(updates).filter(([key]) => RUNTIME_CONFIG_KEY_SET.has(key));
  if (entries.length === 0) {
    return;
  }

  try {
    for (const [key, value] of entries) {
      await prisma.runtimeConfig.upsert({
        where: { key },
        create: { key, value },
        update: { value }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`RuntimeConfig DB sync skipped: ${message}`);
  }
}

async function updateEnvFile(updates: Record<string, string>): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(ENV_FILE_PATH, "utf8");
  } catch {
    raw = "";
  }

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.length > 0 ? raw.split(/\r?\n/u) : [];
  const hasTrailingBlank = lines.length > 0 && lines[lines.length - 1] === "";
  const workingLines = hasTrailingBlank ? lines.slice(0, -1) : [...lines];
  const seen = new Set<string>();

  for (let index = 0; index < workingLines.length; index += 1) {
    const line = workingLines[index] ?? "";
    const match = line.match(/^([A-Z0-9_]+)\s*=/u);
    const key = match?.[1];
    if (!key || !(key in updates)) {
      continue;
    }

    workingLines[index] = `${key}=${updates[key]}`;
    seen.add(key);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      workingLines.push(`${key}=${value}`);
    }
  }

  await writeFile(ENV_FILE_PATH, `${workingLines.join(eol)}${eol}`, "utf8");
  await upsertRuntimeConfigValues(updates);
}

export async function loadRuntimeConfigFromDatabase(): Promise<void> {
  try {
    const rows = await prisma.runtimeConfig.findMany({
      where: {
        key: {
          in: [...RUNTIME_CONFIG_KEYS]
        }
      }
    });
    const rowMap = new Map(rows.map((row) => [row.key, row.value]));
    const hasRegionalPassengerIds = SOURCE_REGIONS.some(
      (region) =>
        env.PASSENGER_CHAT_IDS_BY_REGION[region].length > 0 ||
        parseChatIdListValue(rowMap.get(getPassengerRegionalEnvKey(region)) ?? "").length > 0
    );
    const hasRegionalPassengerUsernames = SOURCE_REGIONS.some(
      (region) =>
        env.PASSENGER_CHAT_USERNAMES_BY_REGION[region].length > 0 ||
        parseUsernameListValue(rowMap.get(getPassengerUsernameRegionalEnvKey(region)) ?? "").length > 0
    );

    for (const row of rows) {
      if ((row.key === "SOURCE_CHAT_IDS" || row.key === "PASSENGER_CHAT_IDS") && hasRegionalPassengerIds) {
        continue;
      }

      if (row.key === "PASSENGER_CHAT_USERNAMES" && hasRegionalPassengerUsernames) {
        continue;
      }

      applyRuntimeConfigValue(row.key, row.value);
    }

    await upsertRuntimeConfigValues(getRuntimeConfigSnapshot());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`RuntimeConfig DB load skipped: ${message}`);
  }
}

function setEnvBoolean(key: RuntimeBooleanSetting, value: boolean): void {
  env[key] = value;
}

function getPassengerRegionalList(region: SourceRegion): number[] {
  return env.PASSENGER_CHAT_IDS_BY_REGION[region];
}

function getPassengerRegionalEnvKey(region: SourceRegion): string {
  return `PASSENGER_CHAT_IDS_${region}`;
}

function getPassengerUsernameRegionalEnvKey(region: SourceRegion): string {
  return `PASSENGER_CHAT_USERNAMES_${region}`;
}

function getDriverRegionalEnvKey(region: SourceRegion): string {
  return `DRIVER_CHAT_ID_${region}`;
}

function setEnvDriverRegion(region: SourceRegion, chatId: number): void {
  env.DRIVER_CHAT_ID_BY_REGION[region] = chatId;

  if (region === "TASHKENT") {
    env.DRIVER_CHAT_ID_TASHKENT = chatId;
  } else if (region === "GULISTON") {
    env.DRIVER_CHAT_ID_GULISTON = chatId;
  } else if (region === "KOMSOMOL") {
    env.DRIVER_CHAT_ID_KOMSOMOL = chatId;
  } else {
    env.DRIVER_CHAT_ID_ANDIJON = chatId;
  }

  const driverIds = uniqueNumbers(SOURCE_REGIONS.map((item) => env.DRIVER_CHAT_ID_BY_REGION[item]));
  env.DRIVER_CHAT_IDS.length = 0;
  env.DRIVER_CHAT_IDS.push(...driverIds);

  const primaryDriverId = driverIds[0];
  if (primaryDriverId !== undefined) {
    env.DRIVER_CHAT_ID = primaryDriverId;
  }
}

export async function setRuntimeBooleanSetting(key: RuntimeBooleanSetting, value: boolean): Promise<void> {
  setEnvBoolean(key, value);
  await updateEnvFile({
    [key]: String(value)
  });
}

export async function toggleRuntimeBooleanSetting(key: RuntimeBooleanSetting): Promise<boolean> {
  const nextValue = !env[key];
  await setRuntimeBooleanSetting(key, nextValue);
  return nextValue;
}

export async function addPassengerSourceChat(region: SourceRegion, chatId: number): Promise<void> {
  registerResolvedPassengerChat(chatId, region);

  const passengerRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getPassengerRegionalEnvKey(item), formatChatIdList(getPassengerRegionalList(item))])
  );

  await updateEnvFile({
    ...passengerRegionalUpdates,
    PASSENGER_CHAT_IDS: formatChatIdList(env.PASSENGER_CHAT_IDS),
    SOURCE_CHAT_IDS: formatChatIdList(env.PASSENGER_CHAT_IDS)
  });
}

export async function addPassengerSourceUsername(region: SourceRegion, username: string): Promise<string> {
  const normalizedUsername = registerResolvedPassengerChatUsername(username, region);

  const passengerUsernameRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getPassengerUsernameRegionalEnvKey(item), formatStringList(env.PASSENGER_CHAT_USERNAMES_BY_REGION[item])])
  );

  await updateEnvFile({
    ...passengerUsernameRegionalUpdates,
    PASSENGER_CHAT_USERNAMES: formatStringList(env.PASSENGER_CHAT_USERNAMES)
  });

  return normalizedUsername;
}

export async function addPassengerSource(region: SourceRegion, source: PassengerSourceAddResult): Promise<PassengerSourceAddResult> {
  if (source.kind === "chat_id") {
    await addPassengerSourceChat(region, source.value);
    return source;
  }

  const normalizedUsername = await addPassengerSourceUsername(region, source.value);
  return { kind: "username", value: normalizedUsername };
}

export async function removePassengerSourceChat(region: SourceRegion, chatId: number): Promise<void> {
  unregisterResolvedPassengerChat(chatId, region);

  const passengerRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getPassengerRegionalEnvKey(item), formatChatIdList(getPassengerRegionalList(item))])
  );

  await updateEnvFile({
    ...passengerRegionalUpdates,
    PASSENGER_CHAT_IDS: formatChatIdList(env.PASSENGER_CHAT_IDS),
    SOURCE_CHAT_IDS: formatChatIdList(env.PASSENGER_CHAT_IDS)
  });
}

export async function removePassengerSourceUsername(region: SourceRegion, username: string): Promise<string | null> {
  const normalizedUsername = unregisterResolvedPassengerChatUsername(username, region);
  if (!normalizedUsername) {
    return null;
  }

  const passengerUsernameRegionalUpdates = Object.fromEntries(
    SOURCE_REGIONS.map((item) => [getPassengerUsernameRegionalEnvKey(item), formatStringList(env.PASSENGER_CHAT_USERNAMES_BY_REGION[item])])
  );

  await updateEnvFile({
    ...passengerUsernameRegionalUpdates,
    PASSENGER_CHAT_USERNAMES: formatStringList(env.PASSENGER_CHAT_USERNAMES)
  });

  return normalizedUsername;
}

export async function removePassengerSource(region: SourceRegion, source: PassengerSourceAddResult): Promise<boolean> {
  if (source.kind === "chat_id") {
    await removePassengerSourceChat(region, source.value);
    return true;
  }

  const result = await removePassengerSourceUsername(region, source.value);
  return result !== null;
}

export function getPassengerSourcesByRegion(region: SourceRegion): { chatIds: number[]; usernames: string[] } {
  return {
    chatIds: [...(env.PASSENGER_CHAT_IDS_BY_REGION[region] ?? [])],
    usernames: [...(env.PASSENGER_CHAT_USERNAMES_BY_REGION[region] ?? [])]
  };
}

export async function removeDriverChat(region: SourceRegion): Promise<void> {
  unsetEnvDriverRegion(region);

  await updateEnvFile({
    [getDriverRegionalEnvKey(region)]: "",
    DRIVER_CHAT_ID: env.DRIVER_CHAT_ID === 0 ? "" : String(env.DRIVER_CHAT_ID)
  });
}

export async function setDriverChat(region: SourceRegion, chatId: number): Promise<void> {
  setEnvDriverRegion(region, chatId);

  await updateEnvFile({
    [getDriverRegionalEnvKey(region)]: String(chatId),
    DRIVER_CHAT_ID: String(env.DRIVER_CHAT_ID)
  });
}

export async function setRegionalRuntimeBooleanSetting(
  region: SourceRegion,
  setting: RuntimeBooleanSetting,
  value: boolean | null
): Promise<void> {
  const envKey = `${setting}_${region}` as const;
  if (setting === "DELETE_SOURCE_MESSAGE_IF_ADMIN") {
    env.DELETE_SOURCE_MESSAGE_IF_ADMIN_BY_REGION[region] = value;
  } else if (setting === "DELETE_IGNORED_MESSAGE_IF_ADMIN") {
    env.DELETE_IGNORED_MESSAGE_IF_ADMIN_BY_REGION[region] = value;
  } else if (setting === "PASSENGER_GROUP_AUTO_REPLIES") {
    env.PASSENGER_GROUP_AUTO_REPLIES_BY_REGION[region] = value;
  } else if (setting === "SEND_PRIVATE_ACK_TO_PASSENGER") {
    env.SEND_PRIVATE_ACK_TO_PASSENGER_BY_REGION[region] = value;
  }

  await updateEnvFile({
    [envKey]: value === null ? "" : String(value)
  });
}

function formatRegionalBoolean(map: Record<SourceRegion, boolean | null>, fallback: boolean): string {
  return SOURCE_REGIONS.map((r) => {
    const val = map[r];
    const display = val === null ? `[Default: ${formatOnOff(fallback)}]` : formatOnOff(val);
    return `${r}: ${display}`;
  }).join(", ");
}

export function getRuntimeConfigText(adminSummary = "-"): string {
  return [
    "🚕 Taxi bot boshqaruv paneli",
    "",
    `🔒 Userbot yozmasin: ${formatOnOff(env.USERBOT_READ_ONLY)}`,
    `🚖 Haydovchi guruhiga yuborish: ${env.DRIVER_DELIVERY_MODE}`,
    `💬 Yo'lovchi guruhiga javob: ${formatOnOff(env.PASSENGER_GROUP_AUTO_REPLIES)}`,
    `   └ Regional: ${formatRegionalBoolean(env.PASSENGER_GROUP_AUTO_REPLIES_BY_REGION, env.PASSENGER_GROUP_AUTO_REPLIES)}`,
    `📩 Mijozga lichka: ${formatOnOff(env.SEND_PRIVATE_ACK_TO_PASSENGER)}`,
    `   └ Regional: ${formatRegionalBoolean(env.SEND_PRIVATE_ACK_TO_PASSENGER_BY_REGION, env.SEND_PRIVATE_ACK_TO_PASSENGER)}`,
    `🗑 Topilgan xabarni o'chirish: ${formatOnOff(env.DELETE_SOURCE_MESSAGE_IF_ADMIN)}`,
    `   └ Regional: ${formatRegionalBoolean(env.DELETE_SOURCE_MESSAGE_IF_ADMIN_BY_REGION, env.DELETE_SOURCE_MESSAGE_IF_ADMIN)}`,
    `🧹 Keraksiz xabarni o'chirish: ${formatOnOff(env.DELETE_IGNORED_MESSAGE_IF_ADMIN)}`,
    `   └ Regional: ${formatRegionalBoolean(env.DELETE_IGNORED_MESSAGE_IF_ADMIN_BY_REGION, env.DELETE_IGNORED_MESSAGE_IF_ADMIN)}`,
    "",
    "💾 Guruh/kanal sozlamalari .env faylga ham, DBga ham saqlanadi.",
    `👮 Adminlar DB: ${adminSummary}`,
    "",
    `👥 Yo'lovchi guruhlari: ${env.PASSENGER_CHAT_IDS.length}`,
    `🔗 Public username/linklar: ${env.PASSENGER_CHAT_USERNAMES.length}`,
    `Toshkent: ${env.PASSENGER_CHAT_IDS_TASHKENT.length}`,
    `Guliston: ${env.PASSENGER_CHAT_IDS_GULISTON.length}`,
    `Komsomol: ${env.PASSENGER_CHAT_IDS_KOMSOMOL.length}`,
    `Andijon: ${env.PASSENGER_CHAT_IDS_ANDIJON.length}`,
    "",
    `🚘 Haydovchi TOSHKENT: ${env.DRIVER_CHAT_ID_TASHKENT ?? "-"}`,
    `🚘 Haydovchi GULISTON: ${env.DRIVER_CHAT_ID_GULISTON ?? "-"}`,
    `🚘 Haydovchi KOMSOMOL: ${env.DRIVER_CHAT_ID_KOMSOMOL ?? "-"}`,
    `🚘 Haydovchi ANDIJON: ${env.DRIVER_CHAT_ID_ANDIJON ?? "-"}`
  ].join("\n");
}
