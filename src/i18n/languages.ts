/**
 * Language metadata for supported locales.
 *
 * To add a new language:
 * 1. Create a new folder: src/i18n/locales/{code}/translation.json
 * 2. Add an entry here with the language code, English name, and native name
 * 3. Optionally add a priority (lower = higher in dropdown, no priority = alphabetical at end)
 */
export const LANGUAGE_METADATA: Record<
  string,
  { name: string; nativeName: string; priority?: number }
> = {
  en: { name: "English", nativeName: "English", priority: 1 },
};
