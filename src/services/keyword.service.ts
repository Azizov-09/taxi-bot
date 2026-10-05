import { KeywordType, type Keyword } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { DEFAULT_KEYWORDS } from "../config/defaultKeywords.js";
import { normalizeUzbekText } from "../utils/text.js";
import { removeKeywordEntry } from "./keywordDictionary.service.js";

export interface KeywordBucket {
  latin: string[];
  cyrillic: string[];
  route: string[];
  extra: string[];
}

const KEYWORD_CACHE_TTL_MS = 60_000;
const WEAK_ROUTE_WORDS = ["ga", "dan", "га", "дан"];

let keywordBucketCache: { expiresAt: number; value: KeywordBucket } | null = null;

function invalidateKeywordCache(): void {
  keywordBucketCache = null;
}

export function detectKeywordType(word: string): KeywordType {
  const normalized = normalizeUzbekText(word);

  if (/\p{Script=Cyrillic}/u.test(word)) {
    return KeywordType.CYRILLIC;
  }

  if (/(^|\s)(yo'nalish|yonalish|yunalish|tomon|йўналиш|йуналиш|томон)(\s|$)/iu.test(normalized)) {
    return KeywordType.ROUTE;
  }

  if (normalized.split(" ").length > 2) {
    return KeywordType.EXTRA;
  }

  return KeywordType.LATIN;
}

async function deactivateWeakRouteWords(): Promise<void> {
  const words = WEAK_ROUTE_WORDS.map((word) => normalizeUzbekText(word));

  await prisma.keyword.updateMany({
    where: {
      word: { in: words },
      type: KeywordType.ROUTE,
      isActive: true
    },
    data: {
      isActive: false
    }
  });
}

export async function seedDefaultKeywords(): Promise<void> {
  const allDefaults = [
    ...DEFAULT_KEYWORDS.latin.map((word) => ({ word, type: KeywordType.LATIN })),
    ...DEFAULT_KEYWORDS.cyrillic.map((word) => ({ word, type: KeywordType.CYRILLIC })),
    ...DEFAULT_KEYWORDS.route.map((word) => ({ word, type: KeywordType.ROUTE })),
    ...DEFAULT_KEYWORDS.extra.map((word) => ({ word, type: KeywordType.EXTRA }))
  ];

  for (const entry of allDefaults) {
    await prisma.keyword.upsert({
      where: { word: normalizeUzbekText(entry.word) },
      create: {
        word: normalizeUzbekText(entry.word),
        type: entry.type,
        isActive: true
      },
      update: {
        type: entry.type,
        isActive: true
      }
    });
  }

  await deactivateWeakRouteWords();
  invalidateKeywordCache();
}

export async function getActiveKeywordBucket(): Promise<KeywordBucket> {
  if (keywordBucketCache && Date.now() < keywordBucketCache.expiresAt) {
    return keywordBucketCache.value;
  }

  const keywords = await prisma.keyword.findMany({
    where: { isActive: true },
    orderBy: { word: "asc" }
  });

  const bucket = keywords.reduce<KeywordBucket>(
    (acc, keyword) => {
      if (keyword.type === KeywordType.CYRILLIC) {
        acc.cyrillic.push(keyword.word);
      } else if (keyword.type === KeywordType.ROUTE) {
        acc.route.push(keyword.word);
      } else if (keyword.type === KeywordType.EXTRA) {
        acc.extra.push(keyword.word);
      } else {
        acc.latin.push(keyword.word);
      }

      return acc;
    },
    { latin: [], cyrillic: [], route: [], extra: [] }
  );

  keywordBucketCache = {
    value: bucket,
    expiresAt: Date.now() + KEYWORD_CACHE_TTL_MS
  };

  return bucket;
}

export async function listActiveKeywords(): Promise<Keyword[]> {
  return prisma.keyword.findMany({
    where: { isActive: true },
    orderBy: [{ type: "asc" }, { word: "asc" }]
  });
}

export async function addKeyword(rawWord: string): Promise<Keyword> {
  const word = normalizeUzbekText(rawWord);

  const result = await prisma.keyword.upsert({
    where: { word },
    create: {
      word,
      type: detectKeywordType(word),
      isActive: true
    },
    update: {
      isActive: true,
      type: detectKeywordType(word)
    }
  });

  invalidateKeywordCache();
  return result;
}

export async function removeKeyword(rawWord: string): Promise<Keyword | null> {
  const word = normalizeUzbekText(rawWord);

  await removeKeywordEntry({ phrase: rawWord }).catch(() => 0);

  const existing = await prisma.keyword.findUnique({ where: { word } });

  if (!existing) {
    return null;
  }

  const result = await prisma.keyword.update({
    where: { id: existing.id },
    data: { isActive: false }
  });

  invalidateKeywordCache();
  return result;
}

