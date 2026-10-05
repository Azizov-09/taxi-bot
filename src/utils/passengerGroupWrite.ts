import { env, getSourceRegionByPassengerChatId, SOURCE_REGIONS, type SourceRegion } from "../config/env.js";

function buildChatIdLookupCandidates(chatId: number): number[] {
  const candidates = new Set<number>([chatId]);

  if (chatId > 0) {
    const botApiStyle = Number(`-100${chatId}`);
    if (Number.isSafeInteger(botApiStyle)) {
      candidates.add(botApiStyle);
    }
  }

  const asString = String(chatId);
  if (asString.startsWith("-100")) {
    const innerId = Number(asString.slice(4));
    if (Number.isInteger(innerId) && innerId > 0) {
      candidates.add(innerId);
      candidates.add(-innerId);
    }
  } else if (chatId < 0) {
    const innerId = Math.abs(chatId);
    const botApiStyle = Number(`-100${innerId}`);
    if (Number.isSafeInteger(botApiStyle)) {
      candidates.add(botApiStyle);
    }
    candidates.add(innerId);
  }

  return [...candidates];
}

function isConfiguredPassengerChatId(chatId: number): boolean {
  if (getSourceRegionByPassengerChatId(chatId) !== null) {
    return true;
  }

  if (env.PASSENGER_CHAT_IDS.includes(chatId)) {
    return true;
  }

  return SOURCE_REGIONS.some((region) => env.PASSENGER_CHAT_IDS_BY_REGION[region].includes(chatId));
}

export function isPassengerGroupChatId(chatId: number): boolean {
  return buildChatIdLookupCandidates(chatId).some((candidate) => isConfiguredPassengerChatId(candidate));
}

export function shouldBlockPassengerGroupWrite(chatId: number): boolean {
  return !env.PASSENGER_GROUP_AUTO_REPLIES && isPassengerGroupChatId(chatId);
}

export function toNumericChatId(chatId: number | string): number | null {
  const parsed = Number(chatId);
  return Number.isInteger(parsed) && Number.isFinite(parsed) ? parsed : null;
}
