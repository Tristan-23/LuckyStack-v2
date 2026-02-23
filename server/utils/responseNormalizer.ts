import config from '../../config';
import fs from 'fs';
import path from 'path';
import deJson from '../../src/_locales/de.json';
import enJson from '../../src/_locales/en.json';
import frJson from '../../src/_locales/fr.json';
import nlJson from '../../src/_locales/nl.json';
import {
  ErrorParam,
  ErrorResponseInput,
  NormalizedErrorResponse,
  defaultHttpStatusForResponse,
  normalizeErrorResponseCore,
} from '../../shared/responseNormalizer';
import { SRC_DIR } from './paths';

type LanguageCode = 'nl' | 'en' | 'de' | 'fr';
type TranslationRecord = Record<string, string | Record<string, unknown>>;

let translationsByLanguage: Record<LanguageCode, TranslationRecord> = {
  nl: nlJson as TranslationRecord,
  en: enJson as TranslationRecord,
  de: deJson as TranslationRecord,
  fr: frJson as TranslationRecord,
};

const localePaths: Record<LanguageCode, string> = {
  nl: path.join(SRC_DIR, '_locales', 'nl.json'),
  en: path.join(SRC_DIR, '_locales', 'en.json'),
  de: path.join(SRC_DIR, '_locales', 'de.json'),
  fr: path.join(SRC_DIR, '_locales', 'fr.json'),
};

export const reloadLocaleTranslations = () => {
  const nextTranslations: Record<LanguageCode, TranslationRecord> = { ...translationsByLanguage };

  for (const language of Object.keys(localePaths) as LanguageCode[]) {
    try {
      const filePath = localePaths[language];
      const rawJson = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(rawJson) as TranslationRecord;

      if (parsed && typeof parsed === 'object') {
        nextTranslations[language] = parsed;
      }
    } catch (error) {
      console.log(`Failed to reload locale ${language}:`, error, 'yellow');
    }
  }

  translationsByLanguage = nextTranslations;
};

const normalizeLanguage = (language?: string | null): LanguageCode | null => {
  if (!language) return null;
  const short = language.toLowerCase().split('-')[0];
  if (short === 'nl' || short === 'en' || short === 'de' || short === 'fr') {
    return short;
  }
  return null;
};

export const extractLanguageFromHeader = (header?: string | string[]): LanguageCode | null => {
  if (!header) return null;
  const normalized = Array.isArray(header) ? header.join(',') : header;

  const candidates = normalized
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean);

  for (const candidate of candidates) {
    const language = normalizeLanguage(candidate);
    if (language) return language;
  }

  return null;
};

const resolveLanguage = ({
  preferredLocale,
  userLanguage,
}: {
  preferredLocale?: string | null;
  userLanguage?: string | null;
}): LanguageCode => {
  return (
    normalizeLanguage(userLanguage)
    || normalizeLanguage(preferredLocale)
    || normalizeLanguage(config.defaultLanguage)
    || 'en'
  );
};

const translate = ({
  language,
  key,
  params,
}: {
  language: LanguageCode;
  key: string;
  params?: ErrorParam[];
}): string => {
  const translationList = translationsByLanguage[language] || translationsByLanguage.en;
  const parts = key.split('.');
  let result: unknown = translationList;

  for (const part of parts) {
    if (result && typeof result === 'object' && part in result) {
      result = (result as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }

  if (typeof result !== 'string') return key;
  if (!params || params.length === 0) return result;

  let finalResult = result;
  for (const param of params) {
    if (!param.key) continue;
    const regex = new RegExp(`{{${param.key}}}`, 'g');
    finalResult = finalResult.replace(regex, String(param.value));
  }

  return finalResult;
};

export const resolveErrorMessage = ({
  errorCode,
  errorParams,
  preferredLocale,
  userLanguage,
}: {
  errorCode: string;
  errorParams?: ErrorParam[];
  preferredLocale?: string | null;
  userLanguage?: string | null;
}): string => {
  const language = resolveLanguage({ preferredLocale, userLanguage });
  return translate({ language, key: errorCode, params: errorParams });
};

export const normalizeErrorResponse = ({
  response,
  preferredLocale,
  userLanguage,
  fallbackHttpStatus,
}: {
  response: ErrorResponseInput;
  preferredLocale?: string | null;
  userLanguage?: string | null;
  fallbackHttpStatus?: number;
}): NormalizedErrorResponse => {
  const normalized = normalizeErrorResponseCore({
    response,
    fallbackHttpStatus,
    resolveMessage: ({ errorCode, errorParams }) => resolveErrorMessage({
      errorCode,
      errorParams,
      preferredLocale,
      userLanguage,
    }),
  });

  return {
    ...normalized,
    httpStatus: defaultHttpStatusForResponse({
      status: 'error',
      explicitHttpStatus: normalized.httpStatus,
    }),
  };
};

export { defaultHttpStatusForResponse };
