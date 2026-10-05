import { LeadStatus, Prisma } from "@prisma/client";
import type { Context } from "grammy";
import { DRIVER_AD_NEGATIVE_KEYWORDS } from "../config/defaultKeywords.js";
import {
  env,
  getDeleteIgnoredMessageIfAdmin,
  getDeleteSourceMessageIfAdmin,
  getDriverChatIdBySourceChatId,
  getPassengerGroupAutoReplies,
  getSourceRegionByPassengerChatId,
  type SourceRegion
} from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { classifyMessage, keywordClassify, normalizeText } from "./leadClassifier.service.js";
import { extractPhone } from "../utils/phone.js";
import { detectRoute } from "../utils/route.js";
import { formatMessageDate } from "../utils/time.js";
import { hasSpamSignals, stripExtraPunctuation } from "../utils/text.js";
import { writeError, writeInfo, writeWarn } from "./logger.service.js";

export interface ProcessMessageResult {
  processed: boolean;
  reason?: string;
}

export interface DriverSendResult {
  driverMessageId: number;
  forwardedOriginal: boolean;
  forwardedContactVisible?: boolean;
}

export interface UnifiedIncomingMessage {
  sourceChatId: string;
  sourceRegion?: SourceRegion;
  sourceChatTitle: string;
  sourceChatUsername?: string | null;
  sourceMessageId: number;
  senderId: string;
  senderFullName: string;
  senderUsername: string | null;
  isSourceAdmin?: boolean;
  isDriverChatMember?: boolean;
  isStartupBackfill?: boolean;
  text: string;
  messageDate: Date;
  isForwarded?: boolean;
}

export interface UnifiedMessageActions {
  sendToDriver: (formattedText: string, originalText: string) => Promise<DriverSendResult>;
  deleteFromSource?: () => Promise<void>;
  notifyPassenger?: (text: string) => Promise<void>;
  notifySourceChat?: (text: string, options?: { replyToSource?: boolean }) => Promise<void>;
}

function getSourceChatScopeForDriver(driverChatId: number | null): string[] {
  if (driverChatId === null) {
    return [];
  }

  return env.PASSENGER_CHAT_IDS.filter((chatId) => getDriverChatIdBySourceChatId(chatId) === driverChatId).map((chatId) => String(chatId));
}

const DRIVER_AD_KEYWORDS_NORMALIZED = [...new Set(DRIVER_AD_NEGATIVE_KEYWORDS.map((keyword) => normalizeText(keyword)))];
const DRIVER_AD_REGEX_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "olib_ketaman", pattern: /\b(?:olib|ob)\s*ket(?:aman|amiz|amz)\b/iu },
  { id: "odam_olaman", pattern: /\bodam\s*(?:olaman|olamiz)\b/iu },
  { id: "yolovchi_olaman", pattern: /\byo'?lovchi\s*(?:olaman|olamiz)\b/iu },
  { id: "mijoz_olaman", pattern: /\bmijoz\s*(?:olaman|olamiz)\b/iu },
  {
    id: "taksi_kerak_driver_ad",
    pattern:
      /\b(?:taxi|taksi|taxsi|takis|taksilar|taksislar|taxsilar|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|avto)\b.{0,24}\b(?:odam|kishi|yo'?lovchi|yolovchi|yulovchi|mijoz|klient)\b.{0,24}\b(?:kerak|kere|kerede|keremas|krk)\b/iu
  },
  {
    id: "odam_pochta_bolsa_olamiz",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:po(?:ch|c)ta|odam|yuk|\u043e\u0434\u0430\u043c|\u043f\u043e\u0447\u0442\u0430|\u044e\u043a)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])(?:bo'?l(?:sa|sayam?)|\u0431[\u045e\u0443]\u043b(?:\u0441\u0430|\u0441\u0430\u044f\u043c?)|\u0431\u043e\u043b(?:\u0441\u0430|\u0441\u0430\u044f\u043c?))(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])(?:olaman|olamiz|olamz|\u043e\u043b\u0430\u043c\u0430\u043d|\u043e\u043b\u0430\u043c\u0438\u0437)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "odam_pochta_olamiz_direct",
    pattern:
      /\b(?:po(?:ch|c)ta|odam|yuk|\u043e\u0434\u0430\u043c|\u043f\u043e\u0447\u0442\u0430|\u044e\u043a)\b.{0,24}\b(?:olaman|olamiz|olamz|\u043e\u043b\u0430\u043c\u0430\u043d|\u043e\u043b\u0430\u043c\u0438\u0437)\b/iu
  },
  {
    id: "yuramiz_odam_pochta",
    pattern: /\b(?:yuraman|yuramiz|ketaman|ketamiz|chiqaman|chiqamiz|jo'?nayman|jo'?naymiz)\b.{0,40}\b(?:po(?:ch|c)ta|odam|yuk)\b.{0,20}\b(?:olaman|olamiz)\b/iu
  },
  {
    id: "passenger_take_cyrillic",
    pattern:
      /\b(?:yo'?lovchi|yolovchi|yulovchi|mijoz|klient|passajir|\u043f\u0430\u0441\u0441\u0430\u0436\u0438\u0440|\u0439[\u0443\u045e]\u043b\u043e\u0432\u0447\u0438|\u043c\u0438\u0436\u043e\u0437)\b.{0,20}\b(?:olaman|olamiz|olamz|\u043e\u043b\u0430\u043c\u0430\u043d|\u043e\u043b\u0430\u043c\u0438\u0437)\b/iu
  },
  {
    id: "taksi_bor_olib_ketamz",
    pattern:
      /\b(?:taxi|taksi|taxsi)\b.{0,30}\bbor\b.{0,30}\b(?:kishi|odam|yo'?lovchi|yolovchi|yulovchi)\b(?:.{0,20}\bbo'?lsa\b)?(?:.{0,30}\b(?:olib|ob)\s*ket(?:aman|amiz|amz)\b)/iu
  },
  { id: "taksi_bor", pattern: /\b(?:taxi|taksi|taxsi)\s*bor\b/iu },
  {
    id: "taksi_possessive_bor",
    pattern:
      /\b(?:taxi|taksi|taxsi|taxis|taksis|taxsis|takis)(?:si|sini|lari|larim|larimiz)?\s*(?:bor|mavjud)\b/iu
  },
  {
    id: "taksi_any_suffix_bor",
    pattern: /\b(?:taxi|taksi|taxsi|takis)[a-z']{0,10}\s*(?:bor|mavjud)\b/iu
  },
  {
    id: "taksi_bor_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])\u0442\u0430\u043a\u0441\u0438(?:\u0441\u0438|\u043b\u0430\u0440\u0438|\u043b\u0430\u0440\u0438\u043c|\u043b\u0430\u0440\u0438\u043c\u0438\u0437)?\s*(?:\u0431\u043e\u0440|\u0435\u0441\u0442\u044c)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "bosh_vehicle_ad",
    pattern:
      /\b(?:bo'?sh|bosh)\s+(?:taxi|taksi|taxsi|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|avto)\b(?![^.!?\n]{0,18}\b(?:bormi|bori?mi|yo'?qmi|yuqmi|kerak|kere|kk|krk)\b)(?:[^.!?\n]{0,24}\bbor\b)?/iu
  },
  {
    id: "bosh_vehicle_ad_compact",
    pattern:
      /\b(?:bo'?sh|bosh)\s*(?:taxi|taksi|taxsi|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|avto)\b(?![^.!?\n]{0,18}\b(?:bormi|bori?mi|yo'?qmi|yuqmi|kerak|kere|kk|krk)\b)(?:[^.!?\n]{0,24}\bbor\b)?/iu
  },
  {
    id: "bosh_bor_contact_driver_ad",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:bo'?sh|bosh)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])bor(?=$|[^\p{L}\p{N}]).{0,60}(?:^|[^\p{L}\p{N}])(?:ketadigan|aloqaga|chiqilar|chiqing|tel|telefon|phone|raqam|nomer)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "bosh_bor_contact_driver_ad_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u0431\u043e\u0448|\u0431[\u045e\u0443]\u0448)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])\u0431\u043e\u0440(?=$|[^\p{L}\p{N}]).{0,80}(?:^|[^\p{L}\p{N}])(?:\u043a\u0435\u0442\u0430\u0434\u0438\u0433\u0430\u043d|\u0430\u043b\u043e\u049b\u0430\u0433\u0430|\u0430\u043b\u043e\u043a\u0430\u0433\u0430|\u0447\u0438\u049b\u0438\u043b\u0430\u0440|\u0447\u0438\u043a\u0438\u043b\u0430\u0440|\u0442\u0435\u043b|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u0440\u0430\u049b\u0430\u043c|\u0440\u0430\u043a\u0430\u043c|\u043d\u043e\u043c\u0435\u0440)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "bosh_taksi_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u0431[\u045e\u0443]\u0448|\u0431\u043e\u0448)\s+\u0442\u0430\u043a\u0441\u0438(?![^.!?\n]{0,18}(?:\u0431\u043e\u0440\u043c\u0438|\u043a\u0435\u0440\u0430\u043a|\u043a\u0435\u0440\u0435|\u043a\u0440\u043a|\u0439[\u045e\u0443]\u049b\u043c\u0438))(?:[^.!?\n]{0,24}(?:\u0431\u043e\u0440|\u0435\u0441\u0442\u044c))?/iu
  },
  {
    id: "joy_bor",
    pattern:
      /\b(?:(?:\d{1,2}|bir|bitta|bita)\s*(?:ta)?\s*)?(?:bo'?sh|bosh)?\s*joy(?:im|imiz|lar|lari)?\s*bor\b/iu
  },
  {
    id: "joy_bor_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:(?:\d{1,2}|\u0431\u0438\u0440|\u0431\u0438\u0442\u0442\u0430|\u0431\u0438\u0442\u0430)\s*(?:ta|\u0442\u0430)?\s*)?(?:\u0431[\u045e\u0443]\u0448\s*)?(?:\u0436\u043e\u0439|\u043c\u0435\u0441\u0442[\u0430\u043e])(?:\u0438\u043c|\u0438\u043c\u0438\u0437|\u043b\u0430\u0440\u0438)?\s*\u0431\u043e\u0440(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "numbered_seat_available",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:(?:\d{1,2}|bir|bitta|bita|ikki|uch|\u0431\u0438\u0440|\u0431\u0438\u0442\u0442\u0430|\u0438\u043a\u043a\u0438|\u0443\u0447)\s*(?:ta|\u0442\u0430)?\s*)?(?:joy|joyim|\u0436\u043e\u0439|\u0436\u043e\u0439\u0438\u043c|mesta|\u043c\u0435\u0441\u0442\u0430)\s*(?:bor|\u0431\u043e\u0440)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "cyrillic_taxi_driver_terms",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u0442\u0430\u043a\u0441\u0438(?:\u0441\u0438|\u043b\u0430\u0440\u0438)?|\u0431\u043e\u0448\s*\u043c\u043e\u0448\u0438\u043d|\u0431\u043e\u0448\s*\u043c\u0430\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d\u0430|\u043c\u0430\u0448\u0438\u043d\u0430|\u0436\u043e\u0439(?:\u0438\u043c|\u0438\u043c\u0438\u0437)?)(?=$|[^\p{L}\p{N}]).{0,28}(?:^|[^\p{L}\p{N}])(?:\u0431\u043e\u0440|\u043c\u0430\u0432\u0436\u0443\u0434)(?=$|[^\p{L}\p{N}])/iu
  },
  { id: "mashina_bor", pattern: /\b(?:mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|avto)\s*bor\b/iu },
  {
    id: "mashina_bor_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u0431[\u045e\u0443\u043e]\u0448\s*)?(?:\u043c\u0430\u0448\u0438\u043d\u0430?|\u043c\u043e\u0448\u0438\u043d\u0430?)\s*\u0431\u043e\u0440(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "conditioner_driver_ad",
    pattern:
      /\b(?:kan[st]aner|kandi[st]ioner|kond[ei]tsioner|kondisaner|kandisaner|condit?ioner|conditioner)\s*(?:bor|mavjud)\b|(?:^|[^\p{L}\p{N}])(?:\u043a\u0430\u043d\u0434\u0438\u0446\u0438\u043e\u043d\u0435\u0440|\u043a\u043e\u043d\u0434\u0438\u0446\u0438\u043e\u043d\u0435\u0440)\s*(?:\u0431\u043e\u0440|\u0435\u0441\u0442\u044c)(?=$|[^\p{L}\p{N}])/iu
  },
  { id: "avto_model_ad", pattern: /\b(?:avto|taxi|taksi|taxsi|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin)\b.{0,12}\b(?:kobalt|koblt|coblt|cobalt|cobult|cobolt|jentra|gentra|lasetti|lacetti|damas|nexia|malibu)\b/iu },
  {
    id: "avto_model_ad_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u043c\u0430\u0448\u0438\u043d\u0430?|\u043c\u043e\u0448\u0438\u043d\u0430?)(?=$|[^\p{L}\p{N}]).{0,16}(?:^|[^\p{L}\p{N}])(?:\u043a\u043e\u0431\u0430\u043b\u044c\u0442|\u043a\u043e\u0431\u0430\u043b\u0442|\u0434\u0436\u0435\u043d\u0442\u0440\u0430|\u0436\u0435\u043d\u0442\u0440\u0430|\u043d\u0435\u043a\u0441\u0438\u044f|\u043b\u0430\u0441\u0435\u0442\u0442\u0438|\u043b\u0430\u0446\u0435\u0442\u0442\u0438|\u0434\u0430\u043c\u0430\u0441|\u043c\u0430\u043b\u0438\u0431\u0443)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "avto_model_with_passenger_signal",
    pattern:
      /\b(?:kobalt|koblt|coblt|cobalt|cobult|cobolt|jentra|gentra|lasetti|lacetti|damas|nexia|malibu|\u043a\u043e\u0431\u0430\u043b\u044c\u0442|\u0434\u0436\u0435\u043d\u0442\u0440\u0430|\u043d\u0435\u043a\u0441\u0438\u044f)\b.{0,28}\b(?:odam|yo'?lovchi|yolovchi|yulovchi|mijoz|joy|po(?:ch|c)ta|yuk|\u043e\u0434\u0430\u043c|\u0439[\u0443\u045e]\u043b\u043e\u0432\u0447\u0438|\u043f\u043e\u0447\u0442\u0430)\b/iu
  },
  { id: "private_dm_ad", pattern: /\b(?:lichka|lichkaga|lichkadan|lichku)\b/iu },
  { id: "ketadiganlar_bolsa", pattern: /\bketadiganlar?\s*bo'?lsa\b/iu },
  { id: "reklama", pattern: /\b(reklama|РґРѕСЃС‚Р°РІРєР°|dostavka|xizmat ko'?rsatamiz|taxi xizmati|С‚Р°РєСЃРё С…РёР·РјР°С‚Рё)\b/iu },
  { id: "ru_passenger_take", pattern: /\b(?:РїР°СЃСЃР°Р¶РёСЂ|РјРёР¶РѕР·|Р№[СћСѓ]Р»РѕРІС‡Рё)\s*РѕР»Р°Рј(?:Р°РЅ|РёР·)\b/iu },
  { id: "ru_seat_available", pattern: /\b(?:Р±[СћСѓ]С€\s*Р¶РѕР№|Р¶РѕР№)\s*Р±РѕСЂ\b/iu }
];
const CARGO_REGEX_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "cargo_bor",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:po(?:ch|c)ta|yuk|\u043f\u043e\u0447\u0442\u0430|\u044e\u043a)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])(?:bor|bosa|bo'?lsa|ketadi|olib\s*borish|olib\s*ketish|\u0431\u043e\u0440|\u043a\u0435\u0442\u0430\u0434\u0438)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "route_cargo",
    pattern:
      /(?:dan|den|\u0434\u0430\u043d).{0,80}(?:^|[^\p{L}\p{N}])(?:po(?:ch|c)ta|yuk|\u043f\u043e\u0447\u0442\u0430|\u044e\u043a)(?=$|[^\p{L}\p{N}])/iu
  }
];
const DRIVER_COMMERCIAL_VERB_REGEX =
  /(?:^|[^\p{L}\p{N}])(?:olaman|olamiz|olamz|yuraman|yuramiz|yuramz|ketaman|ketamiz|ketamz|qatnayman|qatnaymiz|qatnaymz|chiqaman|chiqamiz|chiqamz|jo'?nayman|jo'?naymiz|jo'?naymz|yetkazib beraman|yetkazib beramiz|olib ketaman|olib ketamiz|olib ketamz|ob ketaman|ob ketamiz|ob ketamz|\u043e\u043b\u0430\u043c\u0430\u043d|\u043e\u043b\u0430\u043c\u0438\u0437|\u044e\u0440\u0430\u043c\u0430\u043d|\u044e\u0440\u0430\u043c\u0438\u0437|\u043a\u0435\u0442\u0430\u043c\u0430\u043d|\u043a\u0435\u0442\u0430\u043c\u0438\u0437|\u049b\u0430\u0442\u043d\u0430\u0439\u043c\u0438\u0437|\u043a\u0430\u0442\u043d\u0430\u0439\u043c\u0438\u0437|\u0447\u0438\u049b\u0430\u043c\u0438\u0437|\u0447\u0438\u043a\u0430\u043c\u0438\u0437)(?=$|[^\p{L}\p{N}])/iu;
const DRIVER_COMMERCIAL_CONTEXT_REGEX =
  /(?:^|[^\p{L}\p{N}])(?:odam|yo'?lovchi|yolovchi|yulovchi|mijoz|klient|po(?:ch|c)ta|yuk|joy|avto|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|taxi|taksi|taxsi|kobalt|koblt|coblt|cobalt|cobult|cobolt|jentra|gentra|lasetti|lacetti|damas|nexia|malibu|\u043e\u0434\u0430\u043c|\u043a\u0438\u0448\u0438|\u0439[\u0443\u045e]\u043b\u043e\u0432\u0447\u0438|\u043c\u0438\u0436\u043e\u0437|\u043a\u043b\u0438\u0435\u043d\u0442|\u043f\u043e\u0447\u0442\u0430|\u044e\u043a|\u0436\u043e\u0439|\u0442\u0430\u043a\u0441\u0438|\u043c\u0430\u0448\u0438\u043d\u0430?|\u043c\u043e\u0448\u0438\u043d\u0430?|\u043a\u043e\u0431\u0430\u043b\u044c\u0442|\u043a\u043e\u0431\u0430\u043b\u0442|\u0434\u0436\u0435\u043d\u0442\u0440\u0430|\u0436\u0435\u043d\u0442\u0440\u0430|\u043d\u0435\u043a\u0441\u0438\u044f|\u043b\u0430\u0441\u0435\u0442\u0442\u0438|\u043b\u0430\u0446\u0435\u0442\u0442\u0438|\u0434\u0430\u043c\u0430\u0441|\u043c\u0430\u043b\u0438\u0431\u0443)(?=$|[^\p{L}\p{N}])/iu;
const PRICE_QUERY_KEYWORDS_NORMALIZED = [
  "qancha",
  "qanchaga",
  "qancha boladi",
  "qancha buladi",
  "qancha bulayabdi",
  "necha pul",
  "narx",
  "narxi",
  "СЃРєРѕР»СЊРєРѕ",
  "С†РµРЅР°",
  "СЃС‚РѕРёРјРѕСЃС‚СЊ",
  "СЃРєРѕРє",
  "skolko"
].map((keyword) => normalizeText(keyword));

const STRONG_PASSENGER_INTENT_PATTERNS: RegExp[] = [
  /\b(?:taxi|taksi|taxsi|takis|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin)\b.{0,24}\b(?:kerak|kere|kerak edi|kere edi|bormi|bori?mi|yo'?qmi|yuqmi)\b/iu,
  /\b(?:bormi|bori?mi|yo'?qmi|yuqmi)\b.{0,24}\b(?:taxi|taksi|taxsi|takis|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin)\b/iu,
  /\b(?:kerak|kere|kerak edi|kere edi)\b.{0,24}\b(?:taxi|taksi|taxsi|takis|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin)\b/iu,
  /\b(?:taxi|taksi|taxsi|takis)\s*(?:ker|kere|kerek|kerak|krk|kera|kk)\b/iu,
  /\b(?:kk|krk)\b.{0,10}\b(?:taxi|taksi|taxsi|takis)\b/iu,
  /\b(?:borish kerak|ketish kerak|borishim kerak|ketishim kerak|joy bormi|poputchik bormi|olib ketadigan bormi|ob ketadigan bormi)\b/iu,
  /(?:^|[^\p{L}\p{N}])(?:\u0442\u0430\u043a\u0441\u0438|\u043c\u0430\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])(?:\u043a\u0435\u0440\u0430\u043a|\u043a\u0435\u0440\u0435|\u043a\u0440\u043a|\u0431\u043e\u0440\u043c\u0438)(?=$|[^\p{L}\p{N}])/iu,
  /(?:^|[^\p{L}\p{N}])(?:\u043a\u0435\u0440\u0430\u043a|\u043a\u0435\u0440\u0435|\u043a\u0440\u043a)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])(?:\u0442\u0430\u043a\u0441\u0438|\u043c\u0430\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d)(?=$|[^\p{L}\p{N}])/iu,
  /\b(?:С‚Р°РєСЃРё|РјР°С€РёРЅР°|РјРѕС€РёРЅР°)\b.{0,24}\b(?:РєРµСЂР°Рє|РєРµСЂРµ|Р±РѕСЂРјРё)\b/iu,
  /\b(?:Р±РѕСЂРёС€ РєРµСЂР°Рє|РєРµС‚РёС€ РєРµСЂР°Рє|Р№СћР»РѕРІС‡Рё Р±РѕСЂ|Р№СѓР»РѕРІС‡Рё Р±РѕСЂ)\b/iu
];
const PASSENGER_SOFT_SIGNAL_REGEX = /\b(?:kishi|odam|yo'?lovchi|yolovchi|yulovchi)\b/iu;
const PASSENGER_SOFT_SIGNAL_CYRILLIC_REGEX =
  /(?:^|[^\p{L}\p{N}])(?:\u043a\u0438\u0448\u0438|\u043e\u0434\u0430\u043c|\u0439\u045e\u043b\u043e\u0432\u0447\u0438|\u0439\u0443\u043b\u043e\u0432\u0447\u0438)(?=$|[^\p{L}\p{N}])/iu;
const TAXI_NEED_INTENT_REGEX =
  /(?:^|[^\p{L}\p{N}])(?:taxi|taksi|taxsi|takis|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|\u0442\u0430\u043a\u0441\u0438|\u043c\u0430\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d)(?=$|[^\p{L}\p{N}]).{0,24}(?:^|[^\p{L}\p{N}])(?:kerak|kere|kk|krk|bormi|bori?mi|yo'?qmi|yuqmi|\u043a\u0435\u0440\u0430\u043a|\u043a\u0435\u0440\u0435|\u043a\u0440\u043a|\u0431\u043e\u0440\u043c\u0438)(?=$|[^\p{L}\p{N}])/iu;
const CHAT_NOISE_PATTERNS: RegExp[] = [
  /^(?:ok+|xo?p|hop|bop|boldi|bo'?ldi|ha|yo'?q|bor|oldim|olindi|tushunarli|kerakmas|keremas|zakaz\s*kerakmas|zakaz\s*keremas|zaks\s*keremas)$/iu,
  /^(?:assalomu?\s*alaykum|asalomu?\s*alaykum|salom|va\s*alaykum\s*assalom|alaykum\s*assalom)$/iu,
  /^(?:rahmat|raxmat|spasiba|thanks)$/iu,
  /^[.?!,\s]+$/u
];
const CONTACT_DROP_TOKENS = new Set([
  "tel",
  "telefon",
  "phone",
  "nomer",
  "raqam",
  "number",
  "aloqa",
  "murojaat",
  "uchun",
  "zvonok",
  "call"
]);
const COMMERCIAL_AD_NOISE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "service_banner", pattern: /\b(?:xizmatlar[iy]?|service|servis|navbatsiz|murojaat\s+uchun)\b/iu },
  { id: "offline_store", pattern: /\b(?:manzil|apteka|do'?kon|magazin|filial)\b/iu },
  { id: "mass_reach_ad", pattern: /\b(?:telegram|instagram|youtube|kanal|obuna)\b/iu }
];
const COMMERCIAL_SERVICE_SPAM_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "construction_service", pattern: /\b(?:beton|g'?isht|devor|eshik|deraza|pol|plita|teshish|kesish|montaj|remont)\b/iu },
  { id: "service_offer", pattern: /\b(?:xizmat|xizmati|xizmatlar|ustalar|usta|yetkazib|dostavka)\b/iu },
  { id: "regional_service_ad", pattern: /\b(?:viloyatlar|sirdaryo|chang\s*siz|changsiz)\b.{0,80}\b(?:xizmat|teshish|kesish)\b/iu },
  { id: "group_admin_noise", pattern: /\b(?:gurpa|gruppa|guruh|gruh|group|blokdan|blok|ochaman|shart|qiyasma|qiyamsi|qiyvossan)\b/iu },
  { id: "profanity_noise", pattern: /\b(?:naxuy|nahuy|нахуй|kot|qotoq|jalab|blya|blet|suka|sani\s+am)\b/iu }
];
const HARD_TAXI_DRIVER_AD_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "vehicle_available_latin",
    pattern:
      /\b(?:taxi|taksi|taxsi|takis|taxis|taxisi|taksisi|taxsisi|taksilari|taxilari|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|avto)[a-z']{0,8}\s*(?:bor|mavjud|tayyor)\b/iu
  },
  {
    id: "vehicle_available_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u0442\u0430\u043a\u0441\u0438|\u0442\u0430\u043a\u0441\u0438\u0441\u0438|\u0442\u0430\u043a\u0441\u0438\u043b\u0430\u0440\u0438|\u043c\u0430\u0448\u0438\u043d\u0430|\u043c\u0430\u0448\u0438\u043d|\u043c\u043e\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d|\u0430\u0432\u0442\u043e)[\p{L}']{0,8}\s*(?:\u0431\u043e\u0440|\u043c\u0430\u0432\u0436\u0443\u0434|\u0442\u0430\u0439\u0451\u0440|\u0442\u0430\u0439\u0435\u0440|\u0435\u0441\u0442\u044c)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "empty_vehicle_available_latin",
    pattern:
      /\b(?:bo'?sh|bosh|bush|bow)\b.{0,24}\b(?:taxi|taksi|taxsi|takis|mashina|mashin|moshina|moshin|mowina|mowin|mawina|mawin|avto)?\b.{0,24}\b(?:bor|ketadigan|aloqaga|chiqilar|chiqing|tel|telefon|raqam|nomer)\b/iu
  },
  {
    id: "empty_vehicle_available_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:\u0431\u043e\u0448|\u0431[\u045e\u0443]\u0448)(?=$|[^\p{L}\p{N}]).{0,28}(?:\u0442\u0430\u043a\u0441\u0438|\u043c\u0430\u0448\u0438\u043d|\u043c\u0430\u0448\u0438\u043d\u0430|\u043c\u043e\u0448\u0438\u043d|\u043c\u043e\u0448\u0438\u043d\u0430|\u0430\u0432\u0442\u043e)?(?=$|[^\p{L}\p{N}]).{0,28}(?:\u0431\u043e\u0440|\u043a\u0435\u0442\u0430\u0434\u0438\u0433\u0430\u043d|\u0430\u043b\u043e\u049b\u0430\u0433\u0430|\u0430\u043b\u043e\u043a\u0430\u0433\u0430|\u0447\u0438\u049b\u0438\u043b\u0430\u0440|\u0447\u0438\u043a\u0438\u043b\u0430\u0440|\u0442\u0435\u043b|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u0440\u0430\u049b\u0430\u043c|\u0440\u0430\u043a\u0430\u043c|\u043d\u043e\u043c\u0435\u0440)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "seat_available_latin",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:(?:\d{1,2}|bir|bitta|bita|ikki|uch|tort|to'?rt)\s*(?:ta)?\s*)?(?:bo'?sh|bosh|bush)?\s*(?:joy|joyim|joyimiz|mesta)\s*(?:bor|mavjud)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "seat_available_cyrillic",
    pattern:
      /(?:^|[^\p{L}\p{N}])(?:(?:\d{1,2}|\u0431\u0438\u0440|\u0431\u0438\u0442\u0442\u0430|\u0438\u043a\u043a\u0438|\u0443\u0447|\u0442[\u045e\u0443]\u0440\u0442)\s*(?:ta|\u0442\u0430)?\s*)?(?:\u0431\u043e\u0448|\u0431[\u045e\u0443]\u0448)?\s*(?:\u0436\u043e\u0439|\u0436\u043e\u0439\u0438\u043c|\u0436\u043e\u0439\u0438\u043c\u0438\u0437|\u043c\u0435\u0441\u0442\u0430)\s*(?:\u0431\u043e\u0440|\u043c\u0430\u0432\u0436\u0443\u0434)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "conditioner_available",
    pattern:
      /\b(?:kan[st]aner|kandi[st]ioner|kond[ei]tsioner|kondisaner|kandisaner|condit?ioner|conditioner)\s*(?:bor|mavjud)\b|(?:^|[^\p{L}\p{N}])(?:\u043a\u0430\u043d\u0434\u0438\u0446\u0438\u043e\u043d\u0435\u0440|\u043a\u043e\u043d\u0434\u0438\u0446\u0438\u043e\u043d\u0435\u0440)\s*(?:\u0431\u043e\u0440|\u043c\u0430\u0432\u0436\u0443\u0434|\u0435\u0441\u0442\u044c)(?=$|[^\p{L}\p{N}])/iu
  },
  {
    id: "driver_contact_offer",
    pattern:
      /\b(?:ketadigan|qatnaydigan|yuradigan)\b.{0,40}\b(?:aloqaga|chiqilar|chiqing|tel|telefon|raqam|nomer)\b|(?:^|[^\p{L}\p{N}])(?:\u043a\u0435\u0442\u0430\u0434\u0438\u0433\u0430\u043d|\u049b\u0430\u0442\u043d\u0430\u0439\u0434\u0438\u0433\u0430\u043d|\u043a\u0430\u0442\u043d\u0430\u0439\u0434\u0438\u0433\u0430\u043d|\u044e\u0440\u0430\u0434\u0438\u0433\u0430\u043d)(?=$|[^\p{L}\p{N}]).{0,50}(?:\u0430\u043b\u043e\u049b\u0430\u0433\u0430|\u0430\u043b\u043e\u043a\u0430\u0433\u0430|\u0447\u0438\u049b\u0438\u043b\u0430\u0440|\u0447\u0438\u043a\u0438\u043b\u0430\u0440|\u0442\u0435\u043b|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u0440\u0430\u049b\u0430\u043c|\u0440\u0430\u043a\u0430\u043c|\u043d\u043e\u043c\u0435\u0440)(?=$|[^\p{L}\p{N}])/iu
  }
];

const META_INSTRUCTION_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "nickname_or_username", pattern: /\b(?:nick\s*name|nickname|nikname|username)\b/iu },
  { id: "write_instruction", pattern: /\b(?:aniq\s+yoz(?:ing|ilar)?|yoz(?:ing|ilar)?\s+deb|qayerga\s+borish(?:ingiz|iz)ni\s+aniq\s+yoz)\b/iu },
  { id: "ai_notice", pattern: /\b(?:sun[вЂ™'`]?iy|suniy)\s+intellekt\b/iu },
  { id: "operator_notice", pattern: /\b(?:taksi(?:lar|chilar)(?:imiz)?|taksislar(?:imiz)?|ulab\s+beradi)\b/iu },
  { id: "admin_notice", pattern: /\b(?:qoidalar?|e'lon|elon)\b/iu }
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(normalizedText: string, normalizedKeyword: string): boolean {
  if (!normalizedKeyword) {
    return false;
  }

  const boundaryPattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedKeyword)}(?=$|[^\\p{L}\\p{N}])`, "iu");
  return boundaryPattern.test(normalizedText);
}

function patternMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function collectPatternHits(entries: Array<{ id: string; pattern: RegExp }>, text: string, normalizedText?: string): string[] {
  return entries
    .filter((entry) => patternMatches(entry.pattern, text) || (normalizedText !== undefined && patternMatches(entry.pattern, normalizedText)))
    .map((entry) => entry.id);
}

function detectDriverAdHits(normalizedText: string): string[] {
  return DRIVER_AD_KEYWORDS_NORMALIZED.filter((keyword) => keyword.length > 0 && containsKeyword(normalizedText, keyword));
}

function detectPriceQueryHits(normalizedText: string): string[] {
  return PRICE_QUERY_KEYWORDS_NORMALIZED.filter((keyword) => keyword.length > 0 && containsKeyword(normalizedText, keyword));
}

function detectDriverAdPatternHits(text: string, normalizedText: string): string[] {
  return collectPatternHits(DRIVER_AD_REGEX_PATTERNS, text, normalizedText);
}

function detectCargoPatternHits(text: string, normalizedText: string): string[] {
  return collectPatternHits(CARGO_REGEX_PATTERNS, text, normalizedText);
}

function hasStrongPassengerIntent(text: string): boolean {
  return STRONG_PASSENGER_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function detectMetaInstructionHits(text: string, normalizedText: string): string[] {
  return collectPatternHits(META_INSTRUCTION_PATTERNS, text, normalizedText);
}

function detectCommercialAdNoiseHits(text: string, normalizedText: string): string[] {
  return collectPatternHits(COMMERCIAL_AD_NOISE_PATTERNS, text, normalizedText);
}

function detectCommercialServiceSpamHits(text: string, normalizedText: string): string[] {
  return collectPatternHits(COMMERCIAL_SERVICE_SPAM_PATTERNS, text, normalizedText);
}

function detectHardTaxiDriverAdHits(text: string, normalizedText: string): string[] {
  const hits = collectPatternHits(HARD_TAXI_DRIVER_AD_PATTERNS, text, normalizedText);
  const normalized = normalizedText
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const literalDriverPhrases = [
    "taxisi bor",
    "taksisi bor",
    "taxis bor",
    "taxsi bor",
    "taksi bor",
    "taxi bor",
    "bosh bor",
    "bosh moshin bor",
    "boshmoshin bor",
    "bosh mashina bor",
    "boshmashina bor",
    "joyim bor",
    "joy bor",
    "1ta joy bor",
    "2ta joy bor",
    "3ta joy bor",
    "1ta joyim bor",
    "2ta joyim bor",
    "3ta joyim bor",
    "\u0442\u0430\u043a\u0441\u0438 \u0431\u043e\u0440",
    "\u0442\u0430\u043a\u0441\u0438\u0441\u0438 \u0431\u043e\u0440",
    "\u0431\u043e\u0448 \u0431\u043e\u0440",
    "\u0431\u045e\u0448 \u0431\u043e\u0440",
    "\u0431\u0443\u0448 \u0431\u043e\u0440",
    "\u0431\u043e\u0448 \u043c\u043e\u0448\u0438\u043d \u0431\u043e\u0440",
    "\u0431\u043e\u0448\u043c\u043e\u0448\u0438\u043d \u0431\u043e\u0440",
    "\u0436\u043e\u0439 \u0431\u043e\u0440",
    "\u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "\u0431\u0438\u0442\u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "\u0431\u0438\u0442\u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "1 \u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "2 \u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "3 \u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "1 \u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "2 \u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "3 \u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "1\u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "2\u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "3\u0442\u0430 \u0436\u043e\u0439 \u0431\u043e\u0440",
    "1\u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "2\u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "3\u0442\u0430 \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "1ta \u0436\u043e\u0439 \u0431\u043e\u0440",
    "2ta \u0436\u043e\u0439 \u0431\u043e\u0440",
    "3ta \u0436\u043e\u0439 \u0431\u043e\u0440",
    "1ta \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "2ta \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440",
    "3ta \u0436\u043e\u0439\u0438\u043c \u0431\u043e\u0440"
  ];

  for (const phrase of literalDriverPhrases) {
    if (normalized.includes(phrase)) {
      hits.push(`literal:${phrase}`);
    }
  }

  return [...new Set(hits)];
}

function isChatNoiseMessage(originalText: string, normalizedText: string): boolean {
  const compact = normalizedText
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) {
    return true;
  }

  if (compact.length > 40) {
    return false;
  }

  if (CHAT_NOISE_PATTERNS.some((pattern) => pattern.test(compact))) {
    return true;
  }

  if (/^[\p{N}\s()+\-./]+$/u.test(originalText.trim())) {
    return true;
  }

  return false;
}

function isPhoneDropMessage(originalText: string, phone: string | null): boolean {
  if (!phone) {
    return false;
  }

  const withoutPhone = originalText
    .replace(/\+?\d[\d\s().-]{5,}\d/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!withoutPhone) {
    return true;
  }

  const tokens = normalizeText(withoutPhone).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }

  if (tokens.length <= 3 && tokens.every((token) => CONTACT_DROP_TOKENS.has(token))) {
    return true;
  }

  return false;
}

function isGenericLocationToken(value: string | null): boolean {
  if (!value) {
    return true;
  }

  const normalized = normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  return new Set([
    "qayer",
    "qayerga",
    "qayerdan",
    "qayerda",
    "qaer",
    "qaerga",
    "qaerdan",
    "qaerda",
    "qayoqqa",
    "РєСѓРґР°",
    "РѕС‚РєСѓРґР°",
    "where",
    "where to",
    "from where"
  ]).has(normalized);
}

function sanitizeLocationValue(value: string | null): string | null {
  if (!value || isGenericLocationToken(value)) {
    return null;
  }

  return value.trim();
}

function isAmbiguousRouteOnlyMessage(normalizedText: string): boolean {
  const cleaned = normalizedText.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return /^(qayerdan qayerga|qayerga qayerdan|qayerga|qayerdan|qayerda|qaerdan qaerga|qaerga|qaerdan|РєСѓРґР° РєСѓРґР°|РѕС‚РєСѓРґР° РєСѓРґР°|РєСѓРґР°|РѕС‚РєСѓРґР°|where to|from where)$/iu.test(cleaned);
}

function toPositiveUserId(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function errorToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractRouteParts(route: string | null): { from: string | null; to: string | null } {
  if (!route) {
    return { from: null, to: null };
  }

  const [rawFrom, rawTo] = route.split("->").map((part) => part.trim());
  const from = rawFrom && rawFrom.toLowerCase() !== "aniq emas" ? rawFrom : null;
  const to = rawTo && rawTo.length > 0 ? rawTo : null;

  return { from, to };
}

function extractPassengerCount(text: string): number | null {
  const regexes = [
    /(?:^|[^\p{L}\p{N}])(\d{1,2})\s*(?:(?:ta)|(?:\u0442\u0430))?\s*(?:kishi|odam|\u043a\u0438\u0448\u0438|\u043e\u0434\u0430\u043c)(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])(?:kishi|odam|\u043a\u0438\u0448\u0438|\u043e\u0434\u0430\u043c)\s*(\d{1,2})(?=$|[^\p{L}\p{N}])/iu
  ];

  for (const regex of regexes) {
    const match = text.match(regex);
    if (match?.[1]) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function extractTimeHint(text: string): string | null {
  const normalized = normalizeText(text);
  const hourMatch = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (hourMatch?.[0]) {
    return hourMatch[0];
  }

  const words = ["hozir", "bugun", "ertalab", "kechqurun", "tunda", "ertaga", "СЃРµРіРѕРґРЅСЏ", "Р·Р°РІС‚СЂР°"];
  const found = words.find((word) => normalized.includes(word));

  return found ?? null;
}

function extractFareMentions(text: string): string[] {
  const sanitized = text.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return [];
  }

  const patterns = [
    /\b\d{2,8}\s*(?:ming|minga|mingdan|k|kk|mln|million|som|sum|so['`]?m|so'mga|usd|уе|у\.е\.|rub|rubl|руб)\b/giu,
    /\b(?:narx(?:i)?|pul|beraman|beradi|taklif)\s*[:=-]?\s*\d{2,8}\b/giu,
    /\b\d{2,8}\s*(?:so'm|som|sum)\s*(?:beraman|beradi|boladi)?\b/giu
  ];

  const values: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (const match of sanitized.matchAll(pattern)) {
      const raw = match[0]?.trim();
      if (!raw) {
        continue;
      }

      const key = normalizeText(raw);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      values.push(raw);
      if (values.length >= 4) {
        return values;
      }
    }
  }

  return values;
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

function buildDriverLeadSummary(params: {
  senderFullName: string;
  senderUsername: string | null;
  senderId: string;
  phone: string | null;
  fromLocation: string | null;
  toLocation: string | null;
  passengerCount: number | null;
  timeHint: string | null;
  messageTime: string;
  sourceChatTitle: string;
  originalMessage: string;
  sourceChatId: string;
  sourceChatUsername: string | null;
  sourceMessageId: number;
  provider: string;
  confidence: number;
  status: LeadStatus;
  hasHiddenSenderIdentity: boolean;
  fareMentions: string[];
}): string {
  const usernameValue = params.senderUsername ? `@${params.senderUsername}` : "yo'q";
  const phoneValue = params.phone ?? "xabarda topilmadi";
  const fareValue = params.fareMentions.length > 0 ? params.fareMentions.join(", ") : "aniqlanmadi";
  const sourceMessageLink = buildSourceMessageLink(params.sourceChatId, params.sourceMessageId, params.sourceChatUsername);

  return [
    "🚕✨ Yangi yo'lovchi so'rovi",
    "━━━━━━━━━━━━━━━━━━",
    `👤 Ism: ${params.senderFullName}`,
    `🔖 Username: ${usernameValue}`,
    `📞 Telefon: ${phoneValue}`,
    "",
    `📍 Qayerdan: ${params.fromLocation ?? "aniqlanmadi"}`,
    `🎯 Qayerga: ${params.toLocation ?? "aniqlanmadi"}`,
    `👥 Odam soni: ${params.passengerCount ?? "aniqlanmadi"}`,
    `🕒 Vaqt: ${params.timeHint ?? params.messageTime}`,
    `💰 Narx/kelishuv: ${fareValue}`,
    "",
    "📝 Xabar:",
    params.originalMessage,
    "",
    `🔗 Source link: ${sourceMessageLink ?? "mavjud emas"}`
  ].join("\n");
}

function buildPassengerAckMessage(params: {
  senderDisplayName: string;
  fromLocation: string | null;
  toLocation: string | null;
  passengerCount: number | null;
  timeHint: string | null;
  fareMentions: string[];
}): string {
  const route = `${params.fromLocation ?? "aniqlanmadi"} -> ${params.toLocation ?? "aniqlanmadi"}`;
  const fare = params.fareMentions.length > 0 ? params.fareMentions.join(", ") : "ko'rsatilmagan";
  const helpGroups = parseHelpGroupLinks(env.PASSENGER_HELP_GROUP_LINK);
  const helpGroupsLine =
    helpGroups.length > 0
      ? ["", "📌 Tezroq javob uchun admin guruhlar:", ...helpGroups.map((link) => `- ${link}`)].join("\n")
      : "";

  return [
    `✅ ${params.senderDisplayName}, so'rovingiz qabul qilindi`,
    "🚕 So'rovingiz taksi guruhiga muvaffaqiyatli yuborildi.",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `📍 Yo'nalish: ${route}`,
    `👥 Yo'lovchi soni: ${params.passengerCount ?? "aniqlanmadi"}`,
    `🕒 Vaqt: ${params.timeHint ?? "aniqlanmadi"}`,
    `💰 Narx/kelishuv: ${fare}`,
    "",
    "📞 Iltimos, telefoningiz ochiq bo'lsin.",
    "🙏 Tez orada siz bilan bog'lanishadi.",
    helpGroupsLine
  ].join("\n");
}

function buildSenderDisplayName(payload: UnifiedIncomingMessage): string {
  const username = payload.senderUsername?.trim().replace(/^@/, "");
  if (username) {
    return `@${username}`;
  }

  const fullName = payload.senderFullName.replace(/\s+/g, " ").trim();
  if (fullName && fullName.toLowerCase() !== "noma'lum") {
    return fullName;
  }

  if (payload.senderId && !payload.senderId.startsWith("chat:")) {
    return `ID ${payload.senderId}`;
  }

  return "Foydalanuvchi";
}

function buildSourcePassengerAckMessage(senderDisplayName: string): string {
  return [`✅ ${senderDisplayName}, so'rovingiz qabul qilindi.`, "🚕 Taksi guruhiga yuborildi."].join("\n");
}

function parseHelpGroupLinks(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function buildSourceFormatHintMessage(): string {
  const helpGroups = parseHelpGroupLinks(env.PASSENGER_HELP_GROUP_LINK);
  const helpGroupsLine =
    helpGroups.length > 0
      ? ["", "Qo'shimcha guruhlar:", ...helpGroups.map((link) => `- ${link}`)].join("\n")
      : "";

  return [
    "⚠️ Xabar qabul qilinmadi",
    "Username (@username) yoki telefon ko'rsatilmagan.",
    "Iltimos, xabarni quyidagi formatda qayta yozing:",
    "",
    "🚕 Taxi kerak",
    "📍 Yo'nalish: Qayerdan -> Qayerga",
    "📞 Telefon: +998XXXXXXXXX",
    "🕒 Vaqt: hozir / soat 18:30",
    "👥 Odam soni: 1-2 ta",
    helpGroupsLine
  ].join("\n");
}

function buildPrivateFormatHintMessage(): string {
  const helpGroups = parseHelpGroupLinks(env.PASSENGER_HELP_GROUP_LINK);
  const helpGroupLine =
    helpGroups.length > 0
      ? ["🔗 Admin guruhlar:", ...helpGroups.map((link) => `- ${link}`)].join("\n")
      : "🔗 Guruh linkini admin sizga yuboradi.";

  return [
    "⚠️ Xabaringiz qabul qilinmadi",
    "Username (@username) yoki telefon ko'rsatilmagan.",
    "",
    "Iltimos, quyidagicha yuboring:",
    "🚕 Taxi kerak",
    "📍 Yo'nalish: Qayerdan -> Qayerga",
    "📞 Telefon: +998XXXXXXXXX",
    "🕒 Vaqt: hozir / soat 18:30",
    "👥 Odam soni: 1-2 ta",
    "",
    "Bizda haydovchilar tezroq javob berishi uchun to'liq format muhim.",
    helpGroupLine
  ].join("\n");
}

function buildPrivateForwardSecretHintMessage(): string {
  const helpGroups = parseHelpGroupLinks(env.PASSENGER_HELP_GROUP_LINK);
  const helpGroupsLine =
    helpGroups.length > 0
      ? ["", "📌 Tezroq javob uchun admin guruhlar:", ...helpGroups.map((link) => `- ${link}`)].join("\n")
      : "";

  return [
    "✅ So'rovingiz qabul qilindi va taksi guruhiga yuborildi.",
    "⚠️ Muhim eslatma:",
    "Haydovchilar siz bilan bog'lana olmasligi mumkin.",
    "Sabab: username va telefon ko'rsatilmagan, forwardda profilingiz yopiq (secret) bo'lishi mumkin.",
    "",
    "Iltimos, quyidagilardan bittasini qiling:",
    "1) Telegram username qo'shing",
    "2) Telefon raqamingizni xabarda yozing",
    "",
    "Shunda haydovchilar siz bilan tezroq bog'lanadi.",
    helpGroupsLine
  ].join("\n");
}

function buildDriverPremiumJoinLine(): string {
  if (env.DRIVER_PREMIUM_GROUP_LINK) {
    return `👉 Pullik Drivers guruhiga qo'shiling: ${env.DRIVER_PREMIUM_GROUP_LINK}`;
  }

  return "👉 Pullik Drivers guruhiga qo'shilish uchun admin bilan bog'laning.";
}

function buildDriverPremiumPricingBlock(): string[] {
  return [
    "Tariflar:",
    "🗓 15 kunga 20 ming so'm 💸",
    "🗓 1 oyga 40 ming so'm 💸",
    "🗓 3 oyga skidkada 100 ming so'm 💸",
    "🗓 6 oyga 150 ming so'm 💸"
  ];
}

function buildDriverAdMembershipRequiredPrivateMessage(senderDisplayName?: string): string {
  const greeting = senderDisplayName
    ? `🚫 ${senderDisplayName}, haydovchi e'loningiz qabul qilinmadi.`
    : "🚫 Haydovchi e'loningiz qabul qilinmadi.";

  return [
    greeting,
    "Siz pullik Drivers guruhida emassiz.",
    buildDriverPremiumJoinLine(),
    "",
    ...buildDriverPremiumPricingBlock(),
    "",
    "Lichkaga yozing. A'zo bo'lgach, haydovchi e'lonlari guruhda qoladi."
  ].join("\n");
}

function buildSourceDriverAdWarningMessage(senderDisplayName: string): string {
  return [
    `🚫 ${senderDisplayName}, haydovchi e'loningiz qabul qilinmadi.`,
    `Passenger guruhiga haydovchi reklama yoki "joy bor" xabarini yozish mumkin emas.`,
    buildDriverPremiumJoinLine()
  ].join("\n");
}

function getMessageText(msg: Context["msg"]): string | null {
  if (!msg) {
    return null;
  }

  if ("text" in msg && typeof msg.text === "string") {
    return msg.text;
  }

  if ("caption" in msg && typeof msg.caption === "string") {
    return msg.caption;
  }

  return null;
}

function isForwardedMessage(msg: NonNullable<Context["msg"]>): boolean {
  return (
    ("forward_origin" in msg && Boolean(msg.forward_origin)) ||
    ("forward_from" in msg && Boolean(msg.forward_from)) ||
    ("forward_from_chat" in msg && Boolean(msg.forward_from_chat)) ||
    ("forward_sender_name" in msg && Boolean(msg.forward_sender_name)) ||
    ("forward_date" in msg && typeof msg.forward_date === "number")
  );
}

function formatRegionDisplayName(region?: SourceRegion | null): string | null {
  if (!region) return null;
  switch (region) {
    case "GULISTON": return "Guliston";
    case "TASHKENT": return "Toshkent";
    case "KOMSOMOL": return "Komsomol";
    case "ANDIJON": return "Andijon";
    default: return region;
  }
}

function formatFullName(firstName: string, lastName?: string): string {
  const combined = `${firstName} ${lastName ?? ""}`.replace(/\s+/g, " ").trim();
  return combined.length > 0 ? combined : "Noma'lum";
}

async function saveLeadWithStatus(params: {
  payload: UnifiedIncomingMessage;
  originalText: string;
  normalizedText: string;
  detectedRoute: string | null;
  fromLocation: string | null;
  toLocation: string | null;
  phone: string | null;
  passengerCount: number | null;
  timeHint: string | null;
  confidence: number;
  isDriverAd: boolean;
  isSpam: boolean;
  status: LeadStatus;
  driverMessageId?: number;
  errorMessage?: string;
}): Promise<void> {
  const sourceChatIdNumber = Number(params.payload.sourceChatId);
  const targetDriverChatId =
    Number.isInteger(sourceChatIdNumber) && Number.isFinite(sourceChatIdNumber) ? getDriverChatIdBySourceChatId(sourceChatIdNumber) : null;
  const targetDriverChatIdBigInt = targetDriverChatId !== null ? BigInt(targetDriverChatId) : null;

  const data: Prisma.LeadCreateInput = {
    sourceChatId: params.payload.sourceChatId,
    sourceMessageId: params.payload.sourceMessageId,
    sourceChatTitle: params.payload.sourceChatTitle,
    senderId: params.payload.senderId,
    senderFullName: params.payload.senderFullName,
    senderUsername: params.payload.senderUsername,
    userId: params.payload.senderId,
    fullName: params.payload.senderFullName,
    username: params.payload.senderUsername,
    phone: params.phone,
    originalText: params.originalText,
    normalizedText: params.normalizedText,
    fromLocation: params.fromLocation,
    toLocation: params.toLocation,
    passengerCount: params.passengerCount,
    timeHint: params.timeHint,
    confidence: params.confidence,
    isDriverAd: params.isDriverAd,
    isSpam: params.isSpam,
    targetDriverChatId: targetDriverChatIdBigInt,
    detectedRoute: params.detectedRoute,
    status: params.status
  };

  if (params.driverMessageId !== undefined) {
    data.driverMessageId = params.driverMessageId;
    data.forwardedMessageId = params.driverMessageId;
  }

  if (params.errorMessage !== undefined) {
    data.errorMessage = params.errorMessage;
  }

  await prisma.lead.create({ data });
}

async function updateLeadStatus(params: {
  leadId: number;
  status: LeadStatus;
  driverMessageId?: number;
  errorMessage?: string;
}): Promise<void> {
  const data: Prisma.LeadUpdateInput = {
    status: params.status
  };

  if (params.driverMessageId !== undefined) {
    data.driverMessageId = params.driverMessageId;
    data.forwardedMessageId = params.driverMessageId;
  }

  if (params.errorMessage !== undefined) {
    data.errorMessage = params.errorMessage;
  }

  await prisma.lead.update({
    where: { id: params.leadId },
    data
  });
}

const INBOUND_MESSAGE_LOG_MAX_WORDS = 20;

export function buildInboundMessageLogFields(
  text: string,
  maxWords: number = INBOUND_MESSAGE_LOG_MAX_WORDS
): {
  messageText: string;
  messageWordCount: number;
  messageTruncated: boolean;
} {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return { messageText: "", messageWordCount: 0, messageTruncated: false };
  }

  const words = normalized.split(/\s+/u);
  const messageWordCount = words.length;
  const messageTruncated = messageWordCount > maxWords;
  const messageText = messageTruncated ? `${words.slice(0, maxWords).join(" ")}…` : normalized;

  return { messageText, messageWordCount, messageTruncated };
}

export async function processIncomingLead(payload: UnifiedIncomingMessage, actions: UnifiedMessageActions): Promise<ProcessMessageResult> {
  const originalText = stripExtraPunctuation(payload.text);
  const messageLogFields = buildInboundMessageLogFields(originalText);

  if (originalText.length === 0) {
    return { processed: false, reason: "No text/caption in message" };
  }

  const sourceChatIdNumber = Number(payload.sourceChatId);
  const targetDriverChatId =
    Number.isInteger(sourceChatIdNumber) && Number.isFinite(sourceChatIdNumber) ? getDriverChatIdBySourceChatId(sourceChatIdNumber) : null;
  const targetDriverChatIdBigInt = targetDriverChatId !== null ? BigInt(targetDriverChatId) : null;

  if (payload.isStartupBackfill === true) {
    const existingByMessage = await prisma.lead.findUnique({
      where: {
        sourceChatId_sourceMessageId: {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId
        }
      }
    });

    if (existingByMessage) {
      const shouldRetryDelivery =
        existingByMessage.status === LeadStatus.NEW ||
        existingByMessage.status === LeadStatus.ERROR;
      const shouldRetryForDriverRemap =
        targetDriverChatIdBigInt !== null &&
        existingByMessage.targetDriverChatId !== targetDriverChatIdBigInt;

      if (shouldRetryDelivery || shouldRetryForDriverRemap) {
        await writeWarn("Existing source message requires re-delivery", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId,
          existingLeadId: existingByMessage.id,
          existingStatus: existingByMessage.status,
          existingTargetDriverChatId: existingByMessage.targetDriverChatId?.toString() ?? null,
          targetDriverChatId: targetDriverChatIdBigInt?.toString() ?? null,
          retryReason: shouldRetryForDriverRemap ? "driver_chat_remap" : "unsent_or_error"
        });

        await prisma.lead.delete({
          where: { id: existingByMessage.id }
        });
      } else {
        await writeWarn("Lead skipped", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId,
          existingLeadId: existingByMessage.id,
          existingStatus: existingByMessage.status,
          skipReason: "Duplicate source message",
          ...messageLogFields
        });

        return { processed: false, reason: "Duplicate source message" };
      }
    }
  }

  const normalizedText = normalizeText(originalText);
  const duplicateWindowStart = new Date(Date.now() - env.DUPLICATE_WINDOW_MINUTES * 60_000);
  const duplicateSourceChatScope = getSourceChatScopeForDriver(targetDriverChatId);

  const duplicateBySenderText = await prisma.lead.findFirst({
    where: {
      sourceChatId:
        duplicateSourceChatScope.length > 0
          ? {
              in: duplicateSourceChatScope
            }
          : payload.sourceChatId,
      senderId: payload.senderId,
      normalizedText,
      createdAt: { gte: duplicateWindowStart }
    },
    orderBy: { createdAt: "desc" }
  });

  if (duplicateBySenderText) {
    await saveLeadWithStatus({
      payload,
      originalText,
      normalizedText,
      detectedRoute: detectRoute(originalText),
      fromLocation: null,
      toLocation: null,
      phone: extractPhone(originalText),
      passengerCount: extractPassengerCount(originalText),
      timeHint: extractTimeHint(originalText),
      confidence: 0,
      isDriverAd: false,
      isSpam: false,
      status: LeadStatus.DUPLICATE,
      errorMessage:
        targetDriverChatId !== null
          ? `Duplicate sender/text for driver ${targetDriverChatId} in ${env.DUPLICATE_WINDOW_MINUTES} minutes`
          : `Duplicate sender/text in ${env.DUPLICATE_WINDOW_MINUTES} minutes`
    });

    const duplicateReason =
      targetDriverChatId !== null
        ? `Duplicate sender/text window (driver=${targetDriverChatId})`
        : "Duplicate sender/text window";

    await writeWarn("Lead skipped", {
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId,
      senderId: payload.senderId,
      skipReason: duplicateReason,
      duplicateWindowMinutes: env.DUPLICATE_WINDOW_MINUTES,
      ...messageLogFields
    });

    return {
      processed: false,
      reason: duplicateReason
    };
  }

  const classification = await classifyMessage(originalText, payload.sourceRegion ?? null);
  const keywordResult = keywordClassify(originalText, payload.sourceRegion ?? null);
  const driverAdHits = detectDriverAdHits(classification.normalizedText);
  const driverAdPatternHits = detectDriverAdPatternHits(originalText, classification.normalizedText);
  const hardTaxiDriverAdHits = detectHardTaxiDriverAdHits(originalText, classification.normalizedText);
  const cargoPatternHits = detectCargoPatternHits(originalText, classification.normalizedText);
  const priceQueryHits = detectPriceQueryHits(classification.normalizedText);
  const spamByRules = hasSpamSignals(originalText);
  const commercialServiceSpamHits = detectCommercialServiceSpamHits(originalText, classification.normalizedText);

  const routeFromRules = detectRoute(originalText);
  const strongPassengerIntent = hasStrongPassengerIntent(originalText);
  const metaInstructionHits = detectMetaInstructionHits(originalText, classification.normalizedText);
  const routeParts = extractRouteParts(routeFromRules);
  const phoneFromRules = extractPhone(originalText);
  const passengerCountFromRules = extractPassengerCount(originalText);
  const timeHintFromRules = extractTimeHint(originalText);

  const rawFromLocation = sanitizeLocationValue(classification.fromLocation ?? routeParts.from);
  const toLocation = sanitizeLocationValue(classification.toLocation ?? routeParts.to);
  const phone = classification.phone ?? phoneFromRules;
  const passengerCount = classification.passengerCount ?? passengerCountFromRules;
  const timeHint = classification.timeHint ?? timeHintFromRules;
  const fareMentions = extractFareMentions(originalText);

  const hasCommercialVerb = DRIVER_COMMERCIAL_VERB_REGEX.test(originalText);
  const hasCommercialContext = DRIVER_COMMERCIAL_CONTEXT_REGEX.test(classification.normalizedText);
  const looksLikeDriverCommercial = hasCommercialVerb && hasCommercialContext && !strongPassengerIntent;
  const categoryIsPassenger = classification.category === "PASSENGER_LEAD";
  const categoryIsDriver = classification.category === "DRIVER_AD";
  const categoryIsCargo = classification.category === "POSTAL_CARGO";
  const categoryIsSpam = classification.category === "IGNORE_SPAM";
  const hasExplicitDriverAdSignal = driverAdHits.length > 0 || driverAdPatternHits.length > 0 || hardTaxiDriverAdHits.length > 0;
  const isDriverAd = hasExplicitDriverAdSignal || looksLikeDriverCommercial || (categoryIsDriver && hasExplicitDriverAdSignal);
  const isSpam = categoryIsSpam || classification.isSpam || spamByRules || commercialServiceSpamHits.length > 0;
  const isCargo = categoryIsCargo || cargoPatternHits.length > 0;
  const isRouteFareInquiry = Boolean(routeFromRules) && priceQueryHits.length > 0;
  const isAmbiguousRouteOnly = isAmbiguousRouteOnlyMessage(classification.normalizedText);
  const senderIsHiddenByTelegram = payload.senderId.startsWith("chat:");
  const hasHiddenSenderIdentity = senderIsHiddenByTelegram;
  const hiddenWithoutContactIdentity = senderIsHiddenByTelegram && !payload.senderUsername && !phone;
  const missingDriverContactIdentity = senderIsHiddenByTelegram && !payload.senderUsername && !phone;
  const isSourceAdmin = payload.isSourceAdmin === true;
  const isDriverChatMember = payload.isDriverChatMember === true;
  const isProtectedFromDeletion = isSourceAdmin || isDriverChatMember;
  const senderDisplayName = buildSenderDisplayName(payload);
  const hasPassengerSoftSignal = PASSENGER_SOFT_SIGNAL_REGEX.test(originalText) || PASSENGER_SOFT_SIGNAL_CYRILLIC_REGEX.test(originalText);
  const hasTaxiNeedIntent = TAXI_NEED_INTENT_REGEX.test(originalText);

  const hasHardPassengerSignal =
    !hasExplicitDriverAdSignal && (keywordResult.score >= 2 || strongPassengerIntent || hasTaxiNeedIntent || Boolean(phone) || Boolean(routeFromRules));

  const hasExplicitRouteDetails = Boolean(routeFromRules) || Boolean(rawFromLocation) || Boolean(toLocation);
  const hasTaxiIntentWithoutRoute = (hasTaxiNeedIntent || categoryIsPassenger || strongPassengerIntent) && !hiddenWithoutContactIdentity;
  const fallbackFromLocation = rawFromLocation ?? (hasTaxiIntentWithoutRoute && payload.sourceRegion ? formatRegionDisplayName(payload.sourceRegion) : null);
  const fromLocation = rawFromLocation ?? fallbackFromLocation;
  const hasRouteDetails = hasExplicitRouteDetails || (hasTaxiIntentWithoutRoute && Boolean(fromLocation));
  const hasMinimumLeadDetails = Boolean(phone) || hasRouteDetails || hasTaxiIntentWithoutRoute;
  const isMetaInstructionMessage = metaInstructionHits.length >= 2 && !hasMinimumLeadDetails;
  const chatNoiseMessage = isChatNoiseMessage(originalText, classification.normalizedText);
  const phoneDropMessage = isPhoneDropMessage(originalText, phone);
  const commercialAdNoiseHits = detectCommercialAdNoiseHits(originalText, classification.normalizedText);
  const commercialAdNoiseMessage = commercialAdNoiseHits.length > 0 && !hasHardPassengerSignal && !hasRouteDetails;
  const taxiRelatedCandidateMessage =
    categoryIsPassenger ||
    classification.is_passenger_request ||
    strongPassengerIntent ||
    hasTaxiNeedIntent ||
    hasRouteDetails ||
    keywordResult.score >= 2;
  const shouldSendSourceFormatHint =
    hasHiddenSenderIdentity &&
    !payload.senderUsername &&
    !phone &&
    taxiRelatedCandidateMessage &&
    !chatNoiseMessage &&
    !isDriverAd &&
    !isSpam &&
    !isCargo &&
    !isMetaInstructionMessage;
  const shouldSendPrivateFormatHint =
    hasHiddenSenderIdentity &&
    !payload.senderId.startsWith("chat:") &&
    !payload.senderUsername &&
    !phone &&
    taxiRelatedCandidateMessage &&
    !chatNoiseMessage &&
    !isDriverAd &&
    !isSpam &&
    !isCargo &&
    !isMetaInstructionMessage;

  const shouldSendByAI = categoryIsPassenger || (classification.is_passenger_request && classification.confidence >= env.AI_MIN_CONFIDENCE);
  const shouldSendByKeywordRescue =
    !shouldSendByAI &&
    keywordResult.score >= 2 &&
    (keywordResult.is_passenger_request || strongPassengerIntent || Boolean(routeFromRules) || Boolean(phone));
  const shouldSendByStrongPassengerIntent =
    !shouldSendByAI &&
    !shouldSendByKeywordRescue &&
    strongPassengerIntent &&
    !isRouteFareInquiry &&
    !isDriverAd &&
    !isSpam &&
    !isCargo;
  const shouldSendByRoutePassengerPattern =
    !shouldSendByAI &&
    !shouldSendByKeywordRescue &&
    !shouldSendByStrongPassengerIntent &&
    hasRouteDetails &&
    (Boolean(passengerCount) || hasPassengerSoftSignal || hasTaxiNeedIntent || Boolean(phone)) &&
    !isRouteFareInquiry;
  const shouldSendByTaxiNeedPhone =
    !shouldSendByAI &&
    !shouldSendByKeywordRescue &&
    !shouldSendByStrongPassengerIntent &&
    !shouldSendByRoutePassengerPattern &&
    hasTaxiNeedIntent &&
    Boolean(phone) &&
    !isRouteFareInquiry &&
    !isDriverAd &&
    !isSpam &&
    !isCargo;
  const shouldSendByRouteFareInquiry = !shouldSendByAI && !shouldSendByKeywordRescue && isRouteFareInquiry;
  const shouldSend =
    (shouldSendByAI ||
      shouldSendByKeywordRescue ||
      shouldSendByStrongPassengerIntent ||
      shouldSendByRoutePassengerPattern ||
      shouldSendByTaxiNeedPhone ||
      shouldSendByRouteFareInquiry) &&
    hasMinimumLeadDetails &&
    !missingDriverContactIdentity &&
    !hiddenWithoutContactIdentity &&
    !isAmbiguousRouteOnly &&
    !isMetaInstructionMessage &&
    !isDriverAd &&
    !isCargo &&
    !isSpam;

  void writeInfo("Message classification", {
    sourceChatId: payload.sourceChatId,
    sourceMessageId: payload.sourceMessageId,
    ...messageLogFields,
    provider: classification.provider,
    category: classification.category,
    confidence: classification.confidence,
    reason: classification.reason,
    keywordScore: keywordResult.score,
    driverAdHits,
    driverAdPatternHits,
    hardTaxiDriverAdHits,
    cargoPatternHits,
    commercialServiceSpamHits,
    isDriverAd,
    isSpam,
    isCargo,
    isAmbiguousRouteOnly,
    metaInstructionHits,
    hasMinimumLeadDetails,
    isMetaInstructionMessage,
    hasHiddenSenderIdentity,
    hiddenWithoutContactIdentity,
    missingDriverContactIdentity,
    isSourceAdmin,
    isDriverChatMember,
    isProtectedFromDeletion,
    hasHardPassengerSignal,
    hasTaxiNeedIntent,
    chatNoiseMessage,
    phoneDropMessage,
    commercialAdNoiseHits,
    shouldSend,
    providerStatuses: classification.providerStatuses.map((status) => ({
      name: status.name,
      status: status.status,
      disabledUntil: status.disabledUntil,
      keyConfigured: status.keyConfigured,
      reason: status.reason
    }))
  });

  const sourceMessageMeta = {
    sourceChatId: payload.sourceChatId,
    sourceMessageId: payload.sourceMessageId
  };
  const senderMessageMeta = {
    ...sourceMessageMeta,
    senderId: payload.senderId,
    senderDisplayName
  };
  const notifySafely = async (params: {
    send: () => Promise<void>;
    successLog: string;
    failureLog: string;
    meta?: Record<string, unknown>;
  }): Promise<boolean> => {
    const meta = { ...sourceMessageMeta, ...(params.meta ?? {}) };

    try {
      await params.send();
      await writeInfo(params.successLog, meta);
      return true;
    } catch (error) {
      await writeWarn(params.failureLog, {
        ...meta,
        error: errorToString(error)
      });
      return false;
    }
  };

  const deleteFromSourceIfPossible = async (reason: string): Promise<boolean> => {
    if (!getDeleteSourceMessageIfAdmin(payload.sourceRegion) || !actions.deleteFromSource) {
      return false;
    }

    try {
      await actions.deleteFromSource();
      await writeInfo("Source message deleted", {
        ...sourceMessageMeta,
        reason
      });
      return true;
    } catch (deleteError) {
      await writeWarn("Failed to delete source message", {
        ...sourceMessageMeta,
        reason,
        error: errorToString(deleteError)
      });
      return false;
    }
  };

  if (!hasHardPassengerSignal || !shouldSend) {
    const ignoreReason = isDriverAd
      ? "Driver ad detected"
      : isCargo
        ? "Cargo/postal message detected"
      : isSpam
        ? "Spam detected"
        : isAmbiguousRouteOnly
          ? "Ambiguous route-only message"
        : isMetaInstructionMessage
          ? "Meta instruction message ignored"
          : missingDriverContactIdentity
            ? "Missing username/phone for driver contact"
          : hiddenWithoutContactIdentity
            ? "Hidden sender without username/phone"
            : chatNoiseMessage
              ? "Chat noise message ignored"
              : phoneDropMessage
                ? "Contact-only message ignored"
                : commercialAdNoiseMessage
                  ? "Commercial ad noise ignored"
                  : !hasMinimumLeadDetails
                    ? "Missing minimum lead details (phone/route)"
                    : "Classifier rejected";

    await saveLeadWithStatus({
      payload,
      originalText,
      normalizedText: classification.normalizedText,
      detectedRoute: routeFromRules,
      fromLocation,
      toLocation,
      phone,
      passengerCount,
      timeHint,
      confidence: classification.confidence,
      isDriverAd,
      isSpam,
      status: LeadStatus.IGNORED,
      errorMessage: ignoreReason
    });

    const driverAdDeletedFromSource = isDriverAd ? await deleteFromSourceIfPossible(ignoreReason) : false;
    const shouldWarnDriverAdSender = env.SEND_DRIVER_AD_WARNINGS && isDriverAd && !isDriverChatMember;

    if (shouldWarnDriverAdSender && !payload.isStartupBackfill) {
      if (actions.notifySourceChat && getPassengerGroupAutoReplies(payload.sourceRegion)) {
        await notifySafely({
          send: async () => actions.notifySourceChat!(buildSourceDriverAdWarningMessage(senderDisplayName), { replyToSource: !driverAdDeletedFromSource }),
          successLog: "Driver ad source warning sent",
          failureLog: "Failed to send driver ad source warning",
          meta: senderMessageMeta
        });
      }

      if (actions.notifyPassenger && !payload.senderId.startsWith("chat:")) {
        await notifySafely({
          send: async () => actions.notifyPassenger!(buildDriverAdMembershipRequiredPrivateMessage(senderDisplayName)),
          successLog: "Driver ad private warning sent",
          failureLog: "Failed to send driver ad private warning",
          meta: senderMessageMeta
        });
      }
    }

    if (shouldSendSourceFormatHint && getPassengerGroupAutoReplies(payload.sourceRegion) && actions.notifySourceChat && !payload.isStartupBackfill) {
      await notifySafely({
        send: async () => actions.notifySourceChat!(buildSourceFormatHintMessage()),
        successLog: "Source format hint sent",
        failureLog: "Failed to send source format hint"
      });
    }

    if (shouldSendPrivateFormatHint && actions.notifyPassenger && !payload.isStartupBackfill) {
      await notifySafely({
        send: async () => actions.notifyPassenger!(buildPrivateFormatHintMessage()),
        successLog: "Passenger private format hint sent",
        failureLog: "Failed to send passenger private format hint",
        meta: { senderId: payload.senderId }
      });
    }

    const shouldDeleteIgnoredMessage =
      !isDriverAd &&
      !isProtectedFromDeletion &&
        (isCargo ||
          isSpam ||
          isMetaInstructionMessage ||
          (getDeleteIgnoredMessageIfAdmin(payload.sourceRegion) &&
            taxiRelatedCandidateMessage &&
            (isAmbiguousRouteOnly ||
              shouldSendSourceFormatHint ||
              chatNoiseMessage ||
              phoneDropMessage ||
              commercialAdNoiseMessage ||
              !hasHardPassengerSignal ||
              !hasMinimumLeadDetails)));

    if (shouldDeleteIgnoredMessage) {
      await deleteFromSourceIfPossible(ignoreReason);
    }

    const classifierSkipReason = `Skipped by classifier (${classification.provider}, score=${keywordResult.score})`;

    await writeWarn("Lead skipped", {
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId,
      senderId: payload.senderId,
      senderDisplayName: senderDisplayName,
      skipReason: classifierSkipReason,
      ignoreReason,
      category: classification.category,
      provider: classification.provider,
      keywordScore: keywordResult.score,
      shouldSend,
      isDriverAd,
      isCargo,
      isSpam,
      ...messageLogFields
    });

    return {
      processed: false,
      reason: classifierSkipReason
    };
  }

  let createdLead: { id: number };
  try {
    createdLead = await prisma.lead.create({
      data: {
        sourceChatId: payload.sourceChatId,
        sourceMessageId: payload.sourceMessageId,
        sourceChatTitle: payload.sourceChatTitle,
        senderId: payload.senderId,
        senderFullName: payload.senderFullName,
        senderUsername: payload.senderUsername,
        userId: payload.senderId,
        fullName: payload.senderFullName,
        username: payload.senderUsername,
        phone,
        originalText,
        normalizedText: classification.normalizedText,
        fromLocation,
        toLocation,
        passengerCount,
        timeHint,
        confidence: classification.confidence,
        isDriverAd,
        isSpam,
        targetDriverChatId: targetDriverChatIdBigInt,
        detectedRoute: routeFromRules,
        status: LeadStatus.NEW
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      await writeWarn("Lead skipped", {
        sourceChatId: payload.sourceChatId,
        sourceMessageId: payload.sourceMessageId,
        skipReason: "Duplicate source message (race)",
        ...messageLogFields
      });
      return { processed: false, reason: "Duplicate source message" };
    }

    throw error;
  }

  try {
    const messageTime = formatMessageDate(payload.messageDate);
    const formattedMessage = buildDriverLeadSummary({
      senderFullName: payload.senderFullName,
      senderUsername: payload.senderUsername,
      senderId: payload.senderId,
      phone,
      fromLocation,
      toLocation,
      passengerCount,
      timeHint,
      messageTime,
      sourceChatTitle: payload.sourceChatTitle,
      originalMessage: originalText,
      sourceChatId: payload.sourceChatId,
      sourceChatUsername: payload.sourceChatUsername ?? null,
      sourceMessageId: payload.sourceMessageId,
      provider: classification.provider,
      confidence: classification.confidence,
      status: LeadStatus.SENT,
      hasHiddenSenderIdentity,
      fareMentions
    });

    const messageToSend = env.SEND_FORMATTED_MESSAGE ? formattedMessage : originalText;
    const sendResult = await actions.sendToDriver(messageToSend, originalText);
    const driverMessageId = sendResult.driverMessageId;

    await updateLeadStatus({
      leadId: createdLead.id,
      status: LeadStatus.SENT,
      driverMessageId
    });

    let sourceDeletedFromSource = false;
    let sourceDeleteReason: string | undefined;

    if (getDeleteSourceMessageIfAdmin(payload.sourceRegion) && actions.deleteFromSource) {
      try {
        await actions.deleteFromSource();
        sourceDeletedFromSource = true;

        await updateLeadStatus({
          leadId: createdLead.id,
          status: LeadStatus.DELETED_FROM_SOURCE,
          driverMessageId
        });
      } catch (deleteError) {
        sourceDeleteReason = "Sent but source delete not permitted";
        await writeWarn("Failed to delete source message", {
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId,
          error: deleteError instanceof Error ? deleteError.message : String(deleteError)
        });

        await updateLeadStatus({
          leadId: createdLead.id,
          status: LeadStatus.NOT_DELETED_NO_PERMISSION,
          driverMessageId,
          errorMessage: deleteError instanceof Error ? deleteError.message : String(deleteError)
        });
      }
    } else if (env.DELETE_SOURCE_MESSAGE_IF_ADMIN) {
      sourceDeleteReason = "Sent but source delete unavailable";
      await writeInfo("Source message delete skipped (no delete capability)", {
        sourceChatId: payload.sourceChatId,
        sourceMessageId: payload.sourceMessageId,
        isStartupBackfill: payload.isStartupBackfill === true
      });
    }

    const isRealUserId = !payload.senderId.startsWith("chat:") && toPositiveUserId(payload.senderId) !== null;
const canDriversContactPassenger = Boolean(payload.senderUsername) || Boolean(phone) || Boolean(sendResult.forwardedContactVisible) || isRealUserId;
    if (
      env.SEND_PRIVATE_ACK_TO_PASSENGER &&
      actions.notifyPassenger &&
      !payload.senderId.startsWith("chat:") &&
      canDriversContactPassenger
    ) {
      const passengerAck = buildPassengerAckMessage({
        senderDisplayName,
        fromLocation,
        toLocation,
        passengerCount,
        timeHint,
        fareMentions
      });

      await notifySafely({
        send: async () => actions.notifyPassenger!(passengerAck),
        successLog: "Passenger private ack sent",
        failureLog: "Passenger private ack failed",
        meta: { senderId: payload.senderId }
      });
    }

    if (
      env.SEND_PRIVATE_ACK_TO_PASSENGER &&
      actions.notifyPassenger &&
      !payload.senderId.startsWith("chat:") &&
      !canDriversContactPassenger
    ) {
      await notifySafely({
        send: async () => actions.notifyPassenger!(buildPrivateForwardSecretHintMessage()),
        successLog: "Passenger private contact hint sent (forward hidden)",
        failureLog: "Passenger private contact hint failed",
        meta: { senderId: payload.senderId }
      });
    }

    if (env.SEND_PRIVATE_ACK_TO_PASSENGER && !canDriversContactPassenger) {
      await writeInfo("Passenger private ack skipped (missing username/phone)", {
        sourceChatId: payload.sourceChatId,
        sourceMessageId: payload.sourceMessageId,
        senderId: payload.senderId
      });
    }

    if (env.PASSENGER_GROUP_AUTO_REPLIES && actions.notifySourceChat && !payload.isStartupBackfill) {
      await notifySafely({
        send: async () => actions.notifySourceChat!(buildSourcePassengerAckMessage(senderDisplayName), { replyToSource: !sourceDeletedFromSource }),
        successLog: "Passenger source ack sent",
        failureLog: "Passenger source ack failed",
        meta: {
          ...senderMessageMeta,
          isProtectedFromDeletion,
          isSourceAdmin,
          isDriverChatMember
        }
      });
    }

    if (!sendResult.forwardedOriginal) {
      void writeWarn("Original source message could not be forwarded, link/text fallback was sent", {
        sourceChatId: payload.sourceChatId,
        sourceMessageId: payload.sourceMessageId,
        leadId: createdLead.id,
        ...messageLogFields
      });
    }

    void writeInfo("Lead sent to driver", {
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId,
      senderId: payload.senderId,
      senderDisplayName,
      leadId: createdLead.id,
      driverMessageId,
      driverChatId: targetDriverChatId,
      category: classification.category,
      provider: classification.provider,
      keywordScore: keywordResult.score,
      forwardedOriginal: sendResult.forwardedOriginal,
      sourceDeletedFromSource,
      ...messageLogFields
    });

    if (sendResult.forwardedOriginal) {
      return sourceDeleteReason ? { processed: true, reason: sourceDeleteReason } : { processed: true };
    }

    return { processed: true, reason: "Sent with link fallback" };
  } catch (error) {
    await writeError("Failed to send lead to driver chat", error, {
      leadId: createdLead.id,
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId,
      ...messageLogFields
    });

    await updateLeadStatus({
      leadId: createdLead.id,
      status: LeadStatus.ERROR,
      errorMessage: error instanceof Error ? error.message : String(error)
    });

    return { processed: false, reason: "Send failed" };
  }
}

function getTelegramPhoneDigits(text: string): string | null {
  const phone = extractPhone(text);
  if (!phone) {
    return null;
  }

  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("998")) {
    return digits;
  }

  return null;
}

interface TelegramContactCandidate {
  type: "username" | "phone" | "sender_id";
  url: string;
}

function addUniqueTelegramContactCandidate(
  candidates: TelegramContactCandidate[],
  candidate: TelegramContactCandidate | null
): void {
  if (!candidate || candidates.some((item) => item.url === candidate.url)) {
    return;
  }

  candidates.push(candidate);
}

function buildTelegramUserContactCandidates(ctx: Context, text: string): TelegramContactCandidate[] {
  const candidates: TelegramContactCandidate[] = [];
  const username = ctx.from?.username?.trim().replace(/^@/, "");
  if (username) {
    addUniqueTelegramContactCandidate(candidates, {
      type: "username",
      url: `https://t.me/${username}`
    });
  }

  const phoneDigits = getTelegramPhoneDigits(text);
  if (phoneDigits) {
    addUniqueTelegramContactCandidate(candidates, {
      type: "phone",
      url: `tg://resolve?phone=${phoneDigits}`
    });
  }

  if (ctx.from?.id !== undefined) {
    addUniqueTelegramContactCandidate(candidates, {
      type: "sender_id",
      url: `tg://user?id=${ctx.from.id}`
    });
  }

  return candidates;
}

function buildTelegramContactReplyMarkup(candidate: TelegramContactCandidate): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        {
          text: "🚕 MIJOZGA YOZISH",
          url: candidate.url
        }
      ]
    ]
  };
}

function isPassengerContactButtonError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("BUTTON_USER_INVALID") ||
    message.includes("BUTTON_URL_INVALID") ||
    message.includes("BUTTON_TYPE_INVALID") ||
    message.includes("unsupported URL protocol")
  );
}

export async function processIncomingMessage(ctx: Context): Promise<ProcessMessageResult> {
  const msg = ctx.msg;

  if (!msg || !ctx.chat) {
    return { processed: false, reason: "Message context missing" };
  }

  if (!env.PASSENGER_CHAT_IDS.includes(ctx.chat.id)) {
    return { processed: false, reason: "Message from disallowed chat" };
  }

  const sourceRegion = getSourceRegionByPassengerChatId(ctx.chat.id);
  const driverChatId = getDriverChatIdBySourceChatId(ctx.chat.id);
  if (!sourceRegion || driverChatId === null) {
    return { processed: false, reason: "Source chat has no configured region/driver mapping" };
  }

  if (ctx.from?.is_bot) {
    return { processed: false, reason: "Message from bot user" };
  }

  const text = getMessageText(msg);
  if (!text) {
    return { processed: false, reason: "No text/caption in message" };
  }

  const senderId =
    ctx.from?.id !== undefined
      ? String(ctx.from.id)
      : "sender_chat" in msg && msg.sender_chat
        ? `chat:${msg.sender_chat.id}`
        : `chat:${ctx.chat.id}`;
  const senderFullName =
    ctx.from?.first_name !== undefined
      ? formatFullName(ctx.from.first_name, ctx.from.last_name)
      : "sender_chat" in msg && msg.sender_chat?.title
        ? msg.sender_chat.title
        : ctx.chat.title ?? "Noma'lum";

  let isDriverChatMember = false;
  if (ctx.from?.id) {
    for (const candidateDriverChatId of env.DRIVER_CHAT_IDS) {
      try {
        const member = await ctx.api.getChatMember(candidateDriverChatId, ctx.from.id);
        if (member.status !== "left" && member.status !== "kicked") {
          isDriverChatMember = true;
          break;
        }
      } catch {
        // Bot may not be able to inspect every driver chat.
      }
    }
  }

  const payload: UnifiedIncomingMessage = {
    sourceChatId: String(ctx.chat.id),
    sourceRegion,
    sourceChatTitle: ctx.chat.title ?? String(ctx.chat.id),
    sourceChatUsername: ctx.chat.username ?? null,
    sourceMessageId: msg.message_id,
    senderId,
    senderFullName,
    senderUsername: ctx.from?.username ?? null,
    isSourceAdmin: ctx.from?.id === env.ADMIN_TELEGRAM_ID,
    isDriverChatMember,
    isStartupBackfill: false,
    text,
    messageDate: new Date(msg.date * 1000),
    isForwarded: isForwardedMessage(msg)
  };

  const actions: UnifiedMessageActions = {
    sendToDriver: async (formattedText, _originalText) => {
      const contactCandidates = buildTelegramUserContactCandidates(ctx, _originalText);
      let summaryMessage: { message_id: number } | null = null;

      for (const contactCandidate of contactCandidates) {
        try {
          summaryMessage = await ctx.api.sendMessage(driverChatId, formattedText, {
            reply_markup: buildTelegramContactReplyMarkup(contactCandidate)
          } as any);
          break;
        } catch (error) {
          if (!isPassengerContactButtonError(error)) {
            throw error;
          }

          await writeWarn("Passenger contact button candidate invalid, trying next fallback", {
            sourceChatId: String(ctx.chat!.id),
            sourceMessageId: msg.message_id,
            senderId,
            senderUsername: ctx.from?.username ?? null,
            contactType: contactCandidate.type,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (!summaryMessage) {
        if (contactCandidates.length > 0) {
          await writeWarn("Passenger contact buttons invalid, retrying driver lead without button", {
            sourceChatId: String(ctx.chat!.id),
            sourceMessageId: msg.message_id,
            senderId,
            senderUsername: ctx.from?.username ?? null,
            triedContactTypes: contactCandidates.map((candidate) => candidate.type)
          });
        }

        summaryMessage = await ctx.api.sendMessage(driverChatId, formattedText);
      }

      return {
        driverMessageId: summaryMessage.message_id,
        forwardedOriginal: true,
        forwardedContactVisible: false
      };
    },
    deleteFromSource: async () => {
      await ctx.api.deleteMessage(ctx.chat!.id, msg.message_id);
    },
    notifyPassenger: async (text: string) => {
      if (ctx.from?.id === undefined) {
        return;
      }

      await ctx.api.sendMessage(ctx.from.id, text);
    },
    notifySourceChat: async (text: string, options?: { replyToSource?: boolean }) => {
      const sendOptions =
        options?.replyToSource === true
          ? {
              reply_parameters: {
                message_id: msg.message_id,
                allow_sending_without_reply: true
              }
            }
          : {};

      await ctx.api.sendMessage(ctx.chat!.id, text, sendOptions as any);
    }
  };

  const result = await processIncomingLead(payload, actions);
  return result;
}


export async function getStatusSnapshot(): Promise<{
  total: number;
  sent: number;
  deletedFromSource: number;
  notDeletedNoPermission: number;
  ignored: number;
  duplicate: number;
  error: number;
}> {
  const grouped = await prisma.lead.groupBy({
    by: ["status"],
    _count: { status: true }
  });

  const counts = {
    total: 0,
    sent: 0,
    deletedFromSource: 0,
    notDeletedNoPermission: 0,
    ignored: 0,
    duplicate: 0,
    error: 0
  };

  for (const row of grouped) {
    counts.total += row._count.status;

    if (row.status === LeadStatus.SENT) {
      counts.sent = row._count.status;
    }

    if (row.status === LeadStatus.DELETED_FROM_SOURCE) {
      counts.deletedFromSource = row._count.status;
    }

    if (row.status === LeadStatus.NOT_DELETED_NO_PERMISSION) {
      counts.notDeletedNoPermission = row._count.status;
    }

    if (row.status === LeadStatus.IGNORED) {
      counts.ignored = row._count.status;
    }

    if (row.status === LeadStatus.DUPLICATE) {
      counts.duplicate = row._count.status;
    }

    if (row.status === LeadStatus.ERROR) {
      counts.error = row._count.status;
    }
  }

  return counts;
}

export async function getStatsSnapshot(): Promise<{
  today: { leads: number; sent: number; deleted: number; duplicates: number; errors: number };
  week: { leads: number; sent: number; deleted: number; duplicates: number; errors: number };
}> {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 6);
  weekStart.setHours(0, 0, 0, 0);

  const [
    todayLeads,
    todaySent,
    todayDeleted,
    todayDuplicates,
    todayErrors,
    weekLeads,
    weekSent,
    weekDeleted,
    weekDuplicates,
    weekErrors
  ] = await Promise.all([
    prisma.lead.count({ where: { createdAt: { gte: dayStart }, status: { in: [LeadStatus.NEW, LeadStatus.SENT, LeadStatus.DELETED_FROM_SOURCE] } } }),
    prisma.lead.count({ where: { createdAt: { gte: dayStart }, status: LeadStatus.SENT } }),
    prisma.lead.count({ where: { createdAt: { gte: dayStart }, status: LeadStatus.DELETED_FROM_SOURCE } }),
    prisma.lead.count({ where: { createdAt: { gte: dayStart }, status: LeadStatus.DUPLICATE } }),
    prisma.lead.count({ where: { createdAt: { gte: dayStart }, status: LeadStatus.ERROR } }),
    prisma.lead.count({ where: { createdAt: { gte: weekStart }, status: { in: [LeadStatus.NEW, LeadStatus.SENT, LeadStatus.DELETED_FROM_SOURCE] } } }),
    prisma.lead.count({ where: { createdAt: { gte: weekStart }, status: LeadStatus.SENT } }),
    prisma.lead.count({ where: { createdAt: { gte: weekStart }, status: LeadStatus.DELETED_FROM_SOURCE } }),
    prisma.lead.count({ where: { createdAt: { gte: weekStart }, status: LeadStatus.DUPLICATE } }),
    prisma.lead.count({ where: { createdAt: { gte: weekStart }, status: LeadStatus.ERROR } })
  ]);

  return {
    today: {
      leads: todayLeads,
      sent: todaySent,
      deleted: todayDeleted,
      duplicates: todayDuplicates,
      errors: todayErrors
    },
    week: {
      leads: weekLeads,
      sent: weekSent,
      deleted: weekDeleted,
      duplicates: weekDuplicates,
      errors: weekErrors
    }
  };
}

export async function getAdminStatsSnapshot(): Promise<{
  today: { leads: number; delivered: number; uniqueClients: number; ignored: number; duplicates: number; errors: number };
  month: { leads: number; delivered: number; uniqueClients: number; ignored: number; duplicates: number; errors: number };
}> {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const deliveredStatuses = [LeadStatus.SENT, LeadStatus.DELETED_FROM_SOURCE, LeadStatus.NOT_DELETED_NO_PERMISSION];
  const leadStatuses = [LeadStatus.NEW, ...deliveredStatuses];

  async function getPeriodStats(start: Date) {
    const whereCreatedAt = { createdAt: { gte: start } };
    const [leads, delivered, ignored, duplicates, errors, uniqueRows] = await Promise.all([
      prisma.lead.count({ where: { ...whereCreatedAt, status: { in: leadStatuses } } }),
      prisma.lead.count({ where: { ...whereCreatedAt, status: { in: deliveredStatuses } } }),
      prisma.lead.count({ where: { ...whereCreatedAt, status: LeadStatus.IGNORED } }),
      prisma.lead.count({ where: { ...whereCreatedAt, status: LeadStatus.DUPLICATE } }),
      prisma.lead.count({ where: { ...whereCreatedAt, status: LeadStatus.ERROR } }),
      prisma.lead.findMany({
        where: {
          ...whereCreatedAt,
          status: { in: deliveredStatuses },
          senderId: { not: null }
        },
        distinct: ["senderId"],
        select: { senderId: true }
      })
    ]);

    return {
      leads,
      delivered,
      uniqueClients: uniqueRows.length,
      ignored,
      duplicates,
      errors
    };
  }

  return {
    today: await getPeriodStats(dayStart),
    month: await getPeriodStats(monthStart)
  };
}

export async function getLastLeads(limit = 10): Promise<
  Array<{
    id: number;
    status: LeadStatus;
    sender: string;
    route: string;
    createdAt: Date;
    source: string;
  }>
> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  const rows = await prisma.lead.findMany({
    take: safeLimit,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      senderFullName: true,
      fullName: true,
      fromLocation: true,
      toLocation: true,
      detectedRoute: true,
      createdAt: true,
      sourceChatTitle: true,
      sourceChatId: true,
      sourceMessageId: true
    }
  });

  return rows.map((row) => {
    const sender = row.senderFullName ?? row.fullName;
    const routeFromFields = row.fromLocation || row.toLocation ? `${row.fromLocation ?? "?"} -> ${row.toLocation ?? "?"}` : row.detectedRoute ?? "aniqlanmadi";
    const source = row.sourceChatTitle ?? `${row.sourceChatId}/${row.sourceMessageId}`;

    return {
      id: row.id,
      status: row.status,
      sender,
      route: routeFromFields,
      createdAt: row.createdAt,
      source
    };
  });
}

