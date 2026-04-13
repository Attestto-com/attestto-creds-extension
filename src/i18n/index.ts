import { createI18n } from 'vue-i18n'
import en from './locales/en'
import es from './locales/es'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: {
    en: en as Record<string, unknown>,
    es: es as Record<string, unknown>,
  },
})

export default i18n
