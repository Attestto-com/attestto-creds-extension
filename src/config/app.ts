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
  /** Origins the user has approved for silent identity-offer sync ({origin: {trustedSince, lastUsed}}) */
  TRUSTED_ORIGINS: 'attestto_ext_trusted_origins',
  /** Per-site identity preference ({origin: did}) — default selection in approval popup */
  SITE_IDENTITY_PREFS: 'attestto_ext_site_identity_prefs',
  /** Which KDF method was used at setup: 'prf' (passkey PRF) or 'passphrase' (Argon2id) */
  KDF_METHOD: 'attestto_ext_kdf_method',
  /** Base64url-encoded salt used for Argon2id passphrase KDF */
  PASSPHRASE_SALT: 'attestto_ext_passphrase_salt',
  /** User TOFU pin store ({host: {domain, addedAt, properties}}) — anti-phishing trust pin, per-device */
  PIN_STORE: 'attestto_pin_store',
  /** User-reported block list ({host: {domain, blockedAt, reason, sharedWithCommunity}}) — anti-phishing user-distrust, per-device */
  BLOCKLIST_STORE: 'attestto_blocklist_store',
  /** First-seen-per-host timestamp map ({host: ISO}) — local-only baseline for site age signal */
  FIRST_SEEN: 'attestto_first_seen',
} as const
