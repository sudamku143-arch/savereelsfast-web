import "server-only";
import type { Locale } from "./i18n-config";

const dictionaries = {
  en: () => import("../messages/en.json").then((m) => m.default),
  es: () => import("../messages/es.json").then((m) => m.default),
  pt: () => import("../messages/pt.json").then((m) => m.default),
};

export const getDictionary = async (locale: Locale) =>
  (dictionaries[locale] ?? dictionaries.en)();
