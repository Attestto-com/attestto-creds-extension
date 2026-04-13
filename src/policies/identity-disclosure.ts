/**
 * IdentityVC SD-JWT Selective Disclosure Policy
 *
 * Maps IdentityVC claim paths to human-readable labels and privacy tiers.
 * Consumed by PresentCredentialView when types.includes('IdentityVC').
 *
 * Tiers:
 *   - 'standard': low-risk fields, minimal friction for disclosure
 *   - 'sensitive': PII fields, shown with amber warning badge, user must explicitly approve
 */

export type DisclosureTier = 'standard' | 'sensitive'

export interface DisclosureField {
  /** JSON path within credentialSubject (dot notation for nested) */
  path: string
  /** Human-readable label in Spanish */
  label: string
  /** Privacy tier — controls UI friction during selective disclosure */
  tier: DisclosureTier
}

export interface DerivableProof {
  /** Source claim path */
  from: string
  /** Proof type identifier */
  proof: string
  /** Human-readable label */
  label: string
}

export const IDENTITY_DISCLOSURE_POLICY = {
  /** Credential type this policy applies to */
  credentialType: 'IdentityVC',

  /** Claims always visible in the JWT payload (not individually disclosable) */
  alwaysVisible: ['type', 'photoHash'] as const,

  /** SD-JWT disclosable fields with labels and privacy tiers */
  fields: [
    { path: 'fullName',              label: 'Nombre completo',       tier: 'standard' },
    { path: 'nationalId.type',       label: 'Tipo de documento',     tier: 'standard' },
    { path: 'nationalId.number',     label: 'Numero de cedula',      tier: 'sensitive' },
    { path: 'nationalId.country',    label: 'Pais de emision',       tier: 'standard' },
    { path: 'dateOfBirth',           label: 'Fecha de nacimiento',   tier: 'sensitive' },
    { path: 'nationality',           label: 'Nacionalidad',          tier: 'standard' },
    { path: 'maritalStatus',         label: 'Estado civil',          tier: 'standard' },
    { path: 'notarialAttestation',   label: 'Datos notariales',      tier: 'standard' },
    { path: 'organizationRoles',     label: 'Roles empresariales',   tier: 'sensitive' },
  ] as const satisfies readonly DisclosureField[],

  /** Phase 2: ZKP derivable proofs (not yet implemented) */
  derivable: [
    { from: 'dateOfBirth', proof: 'age-over-18',  label: 'Mayor de 18 anos' },
    { from: 'nationality', proof: 'is-national',   label: 'Es costarricense' },
  ] as const satisfies readonly DerivableProof[],
} as const

/**
 * Get the disclosure policy field for a given claim path.
 * Returns undefined if the claim is always visible or not in the policy.
 */
export function getFieldPolicy(path: string): DisclosureField | undefined {
  return IDENTITY_DISCLOSURE_POLICY.fields.find((f) => f.path === path)
}

/**
 * Check if a claim path is marked as sensitive (requires explicit user approval).
 */
export function isSensitiveField(path: string): boolean {
  return getFieldPolicy(path)?.tier === 'sensitive'
}

/**
 * Get all field labels for a list of requested claim paths.
 * Useful for building the consent UI.
 */
export function getDisclosureLabels(paths: string[]): Array<{ path: string; label: string; tier: DisclosureTier }> {
  return paths.map((p) => {
    const field = getFieldPolicy(p)
    return field
      ? { path: p, label: field.label, tier: field.tier }
      : { path: p, label: p, tier: 'standard' as DisclosureTier }
  })
}
