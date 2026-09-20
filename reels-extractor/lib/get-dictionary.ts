import "server-only";
import type { Locale } from "./i18n-config";
import type en from "../messages/en.json";

export type Dictionary = typeof en;

const dictionaries: Record<Locale, () => Promise<Partial<Dictionary>>> = {
  en: () => import("../messages/en.json").then((m) => m.default),
  es: () => import("../messages/es.json").then((m) => m.default),
  pt: () => import("../messages/pt.json").then((m) => m.default),
  hi: () => import("../messages/hi.json").then((m) => m.default),
  bn: () => import("../messages/bn.json").then((m) => m.default),
  te: () => import("../messages/te.json").then((m) => m.default),
  ta: () => import("../messages/ta.json").then((m) => m.default),
  mr: () => import("../messages/mr.json").then((m) => m.default),
  id: () => import("../messages/id.json").then((m) => m.default),
  fr: () => import("../messages/fr.json").then((m) => m.default),
  ar: () => import("../messages/ar.json").then((m) => m.default),
};

export const getDictionary = async (locale: Locale): Promise<Dictionary> => {
  const messages = await (dictionaries[locale] ?? dictionaries.en)();
  // Languages without reviewed legal translations carry no "legal" block: show the English one.
  if (messages.legal) return messages as Dictionary;
  const english = await dictionaries.en();
  return { ...messages, legal: english.legal } as Dictionary;
};
