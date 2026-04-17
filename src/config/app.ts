export const APP_NAME = 'Attestto ID'
export const APP_VERSION = '0.1.0'

export const STORAGE_KEYS = {
  LOCALE: 'attestto_ext_locale',
  THEME: 'attestto_ext_theme',
  VAULT: 'attestto_ext_vault',
  /** Unencrypted public data — credentials, DIDs, identities. Always readable. */
  PUBLIC_VAULT: 'attestto_ext_public',
  SESSION_KEY: 'attestto_ext_session_key',
  /** Base64url-encoded WebAuthn credential ID for passkey unlock */
  WEBAUTHN_CREDENTIAL_ID: 'attestto_ext_webauthn_cred_id',
  /** Base64url-encoded PRF salt used to derive the vault encryption key */
  PRF_SALT: 'attestto_ext_prf_salt',
} as const
