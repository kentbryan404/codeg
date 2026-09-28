import type { AbstractIntlMessages } from "next-intl"
import type { AppLocale } from "@/lib/types"

/**
 * Locale message sets, loaded on demand.
 *
 * Deliberately NO static English import. A static `import enMessages from
 * "…/en.json"` drags the whole ~280 KB message set into the boot graph of every
 * route — it was the largest single chunk the first paint paid for, on every
 * locale, even though the active locale's messages already arrive inlined in
 * the server payload (`app/layout.tsx` → `AppI18nProvider initialMessages`).
 * English is now fetched like every other locale, and only when actually
 * selected.
 *
 * The cache keeps a locale's parsed object alive across swaps, so switching
 * back to a previously used locale does not re-import it.
 */
const MESSAGE_CACHE = new Map<AppLocale, AbstractIntlMessages>()

async function loadMessages(locale: AppLocale): Promise<AbstractIntlMessages> {
  switch (locale) {
    case "zh_cn":
      return (await import("@/i18n/messages/zh-CN.json")).default
    case "zh_tw":
      return (await import("@/i18n/messages/zh-TW.json")).default
    case "ja":
      return (await import("@/i18n/messages/ja.json")).default
    case "ko":
      return (await import("@/i18n/messages/ko.json")).default
    case "es":
      return (await import("@/i18n/messages/es.json")).default
    case "de":
      return (await import("@/i18n/messages/de.json")).default
    case "fr":
      return (await import("@/i18n/messages/fr.json")).default
    case "pt":
      return (await import("@/i18n/messages/pt.json")).default
    case "ar":
      return (await import("@/i18n/messages/ar.json")).default
    case "en":
    default:
      return (await import("@/i18n/messages/en.json")).default
  }
}

export async function getMessagesForLocale(
  locale: AppLocale
): Promise<AbstractIntlMessages> {
  const cached = MESSAGE_CACHE.get(locale)
  if (cached) return cached

  const messages = await loadMessages(locale)
  MESSAGE_CACHE.set(locale, messages)
  return messages
}
