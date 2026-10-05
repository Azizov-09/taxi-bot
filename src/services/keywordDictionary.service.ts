import { KeywordCategory, KeywordLanguage, KeywordMatchType, type KeywordDictionary, Prisma } from "@prisma/client";
import type { SourceRegion } from "../config/env.js";
import { prisma } from "../prisma/client.js";
import { detectKeywordLanguage, normalizePhrase } from "../utils/keywordNormalize.js";

export type LeadCategory = "PASSENGER_LEAD" | "DRIVER_AD" | "POSTAL_CARGO" | "IGNORE_SPAM" | "AMBIGUOUS";
export type DictionaryCategoryInput = "passenger" | "driver" | "cargo" | "spam" | "ambiguous";

interface CachedKeyword {
  id: number;
  phrase: string;
  normalized: string;
  category: KeywordCategory;
  weight: number;
  language: KeywordLanguage;
  matchType: KeywordMatchType;
  source: string;
  customRegex?: RegExp;
  firstToken?: string;
}

interface CategoryScores {
  passenger: number;
  driver: number;
  cargo: number;
  spam: number;
}

interface MatchMeta {
  passenger: string[];
  driver: string[];
  cargo: string[];
  spam: string[];
}

export interface DictionaryRuleResult {
  category: LeadCategory;
  confidence: number;
  reason: string;
  passenger_score: number;
  driver_score: number;
  cargo_score: number;
  spam_score: number;
  matched_keywords: string[];
}

interface KeywordCacheState {
  loadedAt: number;
  all: CachedKeyword[];
  byCategory: Record<KeywordCategory, CachedKeyword[]>;
  phraseIndex: Map<string, CachedKeyword[]>;
  regexKeywords: CachedKeyword[];
}

let keywordCache: KeywordCacheState = {
  loadedAt: 0,
  all: [],
  byCategory: {
    PASSENGER: [],
    DRIVER: [],
    CARGO: [],
    SPAM: [],
    AMBIGUOUS: []
  },
  phraseIndex: new Map<string, CachedKeyword[]>(),
  regexKeywords: []
};

const SOURCE_REGION_SET = new Set<string>(["TASHKENT", "GULISTON", "KOMSOMOL", "ANDIJON"]);

function tryCompileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return undefined;
  }
}

function toCachedKeyword(row: KeywordDictionary): CachedKeyword {
  const keyword: CachedKeyword = {
    id: row.id,
    phrase: row.phrase,
    normalized: row.normalized,
    category: row.category,
    weight: row.weight,
    language: row.language,
    matchType: row.matchType,
    source: row.source
  };

  if (row.matchType === KeywordMatchType.PHRASE || row.matchType === KeywordMatchType.EXACT) {
    const firstToken = row.normalized.split(/\s+/).filter(Boolean)[0];
    if (firstToken) {
      keyword.firstToken = firstToken;
    }
  }

  if (row.matchType === KeywordMatchType.REGEX) {
    const compiled = tryCompileRegex(row.phrase);
    if (compiled) {
      keyword.customRegex = compiled;
    }
  }

  return keyword;
}

function scoreAccumulator(): CategoryScores {
  return {
    passenger: 0,
    driver: 0,
    cargo: 0,
    spam: 0
  };
}

function hasPhraseBoundary(normalizedText: string, normalizedKeyword: string): boolean {
  const haystack = ` ${normalizedText} `;
  const needle = ` ${normalizedKeyword} `;
  return haystack.includes(needle);
}

function matchesKeyword(text: string, normalizedText: string, keyword: CachedKeyword): boolean {
  if (keyword.matchType === KeywordMatchType.REGEX) {
    return keyword.customRegex ? keyword.customRegex.test(text) : false;
  }

  if (keyword.matchType === KeywordMatchType.EXACT) {
    return normalizedText === keyword.normalized;
  }

  if (!normalizedText.includes(keyword.normalized)) {
    return false;
  }

  return hasPhraseBoundary(normalizedText, keyword.normalized);
}

function matchesSourceRegion(source: string, sourceRegion?: SourceRegion | null): boolean {
  if (!source) {
    return true;
  }

  const normalizedSource = source.trim().toUpperCase();
  if (!SOURCE_REGION_SET.has(normalizedSource)) {
    return true;
  }

  return normalizedSource === sourceRegion;
}

function applyCategoryScore(scores: CategoryScores, matches: MatchMeta, keyword: CachedKeyword): void {
  if (keyword.category === KeywordCategory.PASSENGER) {
    scores.passenger += keyword.weight;
    matches.passenger.push(keyword.phrase);
    return;
  }

  if (keyword.category === KeywordCategory.DRIVER) {
    scores.driver += keyword.weight;
    matches.driver.push(keyword.phrase);
    return;
  }

  if (keyword.category === KeywordCategory.CARGO) {
    scores.cargo += keyword.weight;
    matches.cargo.push(keyword.phrase);
    return;
  }

  if (keyword.category === KeywordCategory.SPAM) {
    scores.spam += keyword.weight;
    matches.spam.push(keyword.phrase);
  }
}

function toConfidence(scores: CategoryScores, category: LeadCategory): number {
  const values = [scores.passenger, scores.driver, scores.cargo, scores.spam];
  const sorted = [...values].sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  const margin = Math.max(0, top - second);

  if (top <= 0 || category === "AMBIGUOUS") {
    return 0;
  }

  const base = Math.min(0.9, 0.45 + top / 25);
  const marginBonus = Math.min(0.1, margin / 30);
  return Number(Math.min(1, base + marginBonus).toFixed(2));
}

function resolveCategory(scores: CategoryScores): LeadCategory {
  if (scores.driver >= scores.passenger + 3 && scores.driver >= 7 && scores.driver >= scores.cargo && scores.driver >= scores.spam) {
    return "DRIVER_AD";
  }

  if (scores.passenger >= scores.driver + 3 && scores.passenger >= 7 && scores.passenger >= scores.cargo && scores.passenger >= scores.spam) {
    return "PASSENGER_LEAD";
  }

  if (scores.cargo >= 7 && scores.cargo >= scores.spam && scores.cargo >= Math.max(scores.passenger, scores.driver) - 2) {
    return "POSTAL_CARGO";
  }

  if (scores.spam >= 7 && scores.spam >= Math.max(scores.passenger, scores.driver, scores.cargo) - 2) {
    return "IGNORE_SPAM";
  }

  return "AMBIGUOUS";
}

function uniqueMatches(matches: MatchMeta): string[] {
  return [...new Set([...matches.passenger, ...matches.driver, ...matches.cargo, ...matches.spam])].slice(0, 40);
}

export function mapInputCategory(value: string): KeywordCategory | null {
  const key = value.trim().toLowerCase();
  if (["passenger", "yo'lovchi", "yolovchi", "mijoz", "odam", "kishi"].includes(key)) {
    return KeywordCategory.PASSENGER;
  }

  if (["driver", "haydovchi", "taksichi", "taxist", "taksist"].includes(key)) {
    return KeywordCategory.DRIVER;
  }

  if (["cargo", "pochta", "pocht", "yuk"].includes(key)) {
    return KeywordCategory.CARGO;
  }

  if (["spam", "reklama", "keraksiz"].includes(key)) {
    return KeywordCategory.SPAM;
  }

  if (["ambiguous", "noaniq", "aniqmas"].includes(key)) {
    return KeywordCategory.AMBIGUOUS;
  }

  return null;
}

export async function loadKeywordDictionaryCache(): Promise<void> {
  const rows = await prisma.keywordDictionary.findMany({
    where: { isActive: true },
    select: {
      id: true,
      phrase: true,
      normalized: true,
      category: true,
      weight: true,
      language: true,
      matchType: true,
      source: true
    },
    orderBy: [{ category: "asc" }, { weight: "desc" }, { normalized: "asc" }]
  });

  const all: CachedKeyword[] = [];
  const byCategory: Record<KeywordCategory, CachedKeyword[]> = {
    PASSENGER: [],
    DRIVER: [],
    CARGO: [],
    SPAM: [],
    AMBIGUOUS: []
  };
  const phraseIndex = new Map<string, CachedKeyword[]>();
  const regexKeywords: CachedKeyword[] = [];

  for (let i = 0; i < rows.length; i++) {
    const item = toCachedKeyword(rows[i] as any);
    all.push(item);
    byCategory[item.category]?.push(item);

    if (item.matchType === KeywordMatchType.REGEX) {
      regexKeywords.push(item);
      continue;
    }

    const token = item.firstToken;
    if (token) {
      const bucket = phraseIndex.get(token);
      if (!bucket) {
        phraseIndex.set(token, [item]);
      } else {
        bucket.push(item);
      }
    }
  }

  keywordCache = {
    loadedAt: Date.now(),
    all,
    byCategory,
    phraseIndex,
    regexKeywords
  };
}

export async function reloadKeywordDictionaryCache(): Promise<void> {
  await loadKeywordDictionaryCache();
}

export function getKeywordCacheStats(): { loadedAt: number; total: number; byCategory: Record<KeywordCategory, number> } {
  return {
    loadedAt: keywordCache.loadedAt,
    total: keywordCache.all.length,
    byCategory: {
      PASSENGER: keywordCache.byCategory.PASSENGER.length,
      DRIVER: keywordCache.byCategory.DRIVER.length,
      CARGO: keywordCache.byCategory.CARGO.length,
      SPAM: keywordCache.byCategory.SPAM.length,
      AMBIGUOUS: keywordCache.byCategory.AMBIGUOUS.length
    }
  };
}

export function analyzeByKeywordDictionary(text: string, sourceRegion?: SourceRegion | null): DictionaryRuleResult {
  const normalizedText = normalizePhrase(text);
  const tokens = [...new Set(normalizedText.split(/\s+/).filter(Boolean))];
  const candidateMap = new Map<number, CachedKeyword>();

  for (const token of tokens) {
    const candidates = keywordCache.phraseIndex.get(token);
    if (!candidates) {
      continue;
    }

    for (const candidate of candidates) {
      if (!matchesSourceRegion(candidate.source, sourceRegion)) {
        continue;
      }

      candidateMap.set(candidate.id, candidate);
    }
  }

  for (const regexKeyword of keywordCache.regexKeywords) {
    if (!matchesSourceRegion(regexKeyword.source, sourceRegion)) {
      continue;
    }

    candidateMap.set(regexKeyword.id, regexKeyword);
  }

  const scores = scoreAccumulator();
  const matches: MatchMeta = {
    passenger: [],
    driver: [],
    cargo: [],
    spam: []
  };

  for (const keyword of candidateMap.values()) {
    if (!matchesKeyword(text, normalizedText, keyword)) {
      continue;
    }

    applyCategoryScore(scores, matches, keyword);
  }

  const category = resolveCategory(scores);
  const confidence = toConfidence(scores, category);
  const matchedKeywords = uniqueMatches(matches);

  return {
    category,
    confidence,
    reason: `scores p=${scores.passenger}, d=${scores.driver}, c=${scores.cargo}, s=${scores.spam}`,
    passenger_score: scores.passenger,
    driver_score: scores.driver,
    cargo_score: scores.cargo,
    spam_score: scores.spam,
    matched_keywords: matchedKeywords
  };
}

export function isRuleAmbiguous(result: DictionaryRuleResult): boolean {
  if (result.category === "AMBIGUOUS") {
    return true;
  }

  const sortedScores = [result.passenger_score, result.driver_score, result.cargo_score, result.spam_score].sort((a, b) => b - a);
  const top = sortedScores[0] ?? 0;
  const second = sortedScores[1] ?? 0;
  return top <= 0 || top - second < 3;
}

export async function listKeywordsByCategory(category: KeywordCategory, limit = 60): Promise<KeywordDictionary[]> {
  return prisma.keywordDictionary.findMany({
    where: {
      category,
      isActive: true
    },
    orderBy: [{ weight: "desc" }, { normalized: "asc" }],
    take: Math.max(1, Math.min(200, limit))
  });
}

export async function getKeywordCountByCategory(): Promise<Record<KeywordCategory, number>> {
  const grouped = await prisma.keywordDictionary.groupBy({
    by: ["category"],
    where: { isActive: true },
    _count: { category: true }
  });

  const counts: Record<KeywordCategory, number> = {
    PASSENGER: 0,
    DRIVER: 0,
    CARGO: 0,
    SPAM: 0,
    AMBIGUOUS: 0
  };

  for (const row of grouped) {
    counts[row.category] = row._count.category;
  }

  return counts;
}

export async function addKeywordEntry(params: {
  category: KeywordCategory;
  phrase: string;
  weight: number;
  matchType?: KeywordMatchType;
  source?: string;
}): Promise<KeywordDictionary | null> {
  const phrase = params.phrase.trim();
  if (phrase.length === 0) {
    return null;
  }

  const normalized = normalizePhrase(phrase);
  if (!normalized) {
    return null;
  }

  const safeWeight = Math.max(1, Math.min(20, Math.round(params.weight)));
  const matchType = params.matchType ?? KeywordMatchType.PHRASE;
  const language = detectKeywordLanguage(phrase) as KeywordLanguage;

  const result = await prisma.keywordDictionary.upsert({
    where: {
      normalized_category_source: {
        normalized,
        category: params.category,
        source: params.source ?? "manual"
      }
    },
    create: {
      phrase,
      normalized,
      category: params.category,
      weight: safeWeight,
      language,
      matchType,
      source: params.source ?? "manual",
      isActive: true
    },
    update: {
      phrase,
      weight: safeWeight,
      language,
      matchType,
      source: params.source ?? "manual",
      isActive: true
    }
  });

  await loadKeywordDictionaryCache();
  return result;
}

export async function removeKeywordEntry(params: {
  phrase: string;
  category?: KeywordCategory | undefined;
  source?: string | undefined;
}): Promise<number> {
  const phrase = params.phrase.trim();
  if (phrase.length === 0) {
    return 0;
  }

  const normalized = normalizePhrase(phrase);
  if (!normalized) {
    return 0;
  }

  const where: Prisma.KeywordDictionaryWhereInput = {
    normalized,
    isActive: true
  };

  if (params.category) {
    where.category = params.category;
  }

  if (params.source) {
    where.source = params.source;
  }

  const result = await prisma.keywordDictionary.updateMany({
    where,
    data: {
      isActive: false
    }
  });

  if (result.count > 0) {
    await loadKeywordDictionaryCache();
  }

  return result.count;
}

export async function listKeywordEntries(params?: {
  category?: KeywordCategory | undefined;
  source?: string | undefined;
  limit?: number | undefined;
}): Promise<KeywordDictionary[]> {
  const where: Prisma.KeywordDictionaryWhereInput = {
    isActive: true
  };

  if (params?.category) {
    where.category = params.category;
  }

  if (params?.source) {
    where.source = params.source;
  }

  return prisma.keywordDictionary.findMany({
    where,
    orderBy: [{ weight: "desc" }, { createdAt: "desc" }],
    take: params?.limit ?? 50
  });
}

export function normalizeDictionaryPhrase(phrase: string): string {
  return normalizePhrase(phrase);
}

export async function bulkUpsertKeywordDictionary(records: Array<Prisma.KeywordDictionaryCreateInput>): Promise<void> {
  for (const record of records) {
    const updateData: Prisma.KeywordDictionaryUpdateInput = {
      phrase: record.phrase,
      isActive: true
    };

    if (record.weight !== undefined) {
      updateData.weight = record.weight;
    }

    if (record.language !== undefined) {
      updateData.language = record.language;
    }

    if (record.matchType !== undefined) {
      updateData.matchType = record.matchType;
    }

    if (record.source !== undefined) {
      updateData.source = record.source;
    }

    await prisma.keywordDictionary.upsert({
    where: {
        normalized_category_source: {
          normalized: record.normalized,
          category: record.category,
          source: String(record.source ?? "global")
        }
      },
      create: record,
      update: updateData
    });
  }
}
