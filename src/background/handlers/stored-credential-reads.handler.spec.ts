/**
 * Story 1.13 Phase 8 — the two stored-credential disclosure boundaries.
 *
 * The load-bearing assertion is NEGATIVE and made against the SERIALIZED
 * result: no unselected claim value may appear anywhere in what the page
 * receives. A test that enumerates expected keys passes for a projection that
 * leaks by nesting — `{ claims: {...selected}, _raw: credential }` has exactly
 * the right top-level keys and hands over the whole credential.
 *
 * So each credential here carries SENTINELS: distinctive strings in the claims
 * the caller did not ask for. If a sentinel turns up in `JSON.stringify` of the
 * payload, the boundary leaked, whatever shape the leak took.
 */
import { describe, it, expect } from 'vitest'
import {
  summarizeStoredCredentials,
  buildResharePresentation,
} from './stored-credential-reads.handler'
import type { VaultData } from '@/stores/wallet'
import type { StoredCredential } from '@/types/credential'

/** Values that must never leave the vault unless explicitly selected. */
const SENTINEL = {
  cedula: '1-1234-5678-SENTINEL',
  salary: 'CRC-9999999-SENTINEL',
  address: 'Nosara-SENTINEL',
}

function credential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: 'cred-1',
    format: 'sd-jwt',
    raw: `raw-payload-containing-${SENTINEL.cedula}`,
    issuer: 'did:web:muni.go.cr',
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    types: ['VerifiableCredential', 'EmploymentCredential'],
    decodedClaims: {
      nombre: 'Titular',
      cedula: SENTINEL.cedula,
      salario: SENTINEL.salary,
      direccion: SENTINEL.address,
    },
    metadata: { addedAt: '2026-01-01T00:00:00Z', source: 'push' },
    ...overrides,
  } as StoredCredential
}

function vaultWith(...credentials: StoredCredential[]): VaultData {
  return {
    did: null,
    privateKeyJwk: null,
    credentials,
    linkedSolanaAddress: null,
    keyShares: [],
    proofRequests: [],
    preparedPresentations: [],
  }
}

/** Everything the page would actually receive, as text. */
const wire = (value: unknown): string => JSON.stringify(value)

describe('summarizeStoredCredentials', () => {
  it('reports the claim key NAMES and not one claim value', () => {
    const out = summarizeStoredCredentials(vaultWith(credential()))

    expect(out).toHaveLength(1)
    expect(out[0].claimKeys).toEqual(['nombre', 'cedula', 'salario', 'direccion'])
    for (const [field, value] of Object.entries(SENTINEL)) {
      expect(wire(out), `leaked ${field}`).not.toContain(value)
    }
  })

  it('does not ship the raw credential, which contains the claims verbatim', () => {
    const out = summarizeStoredCredentials(vaultWith(credential()))
    expect(wire(out)).not.toContain('raw-payload-containing')
  })

  it('carries the metadata a site legitimately needs to choose a credential', () => {
    const out = summarizeStoredCredentials(vaultWith(credential()))
    expect(out[0]).toMatchObject({
      id: 'cred-1',
      format: 'sd-jwt',
      issuer: 'did:web:muni.go.cr',
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
      types: ['VerifiableCredential', 'EmploymentCredential'],
      source: 'push',
    })
  })

  it('answers a locked vault with an empty list, revealing neither lock state nor holdings', () => {
    expect(summarizeStoredCredentials(null)).toEqual([])
  })

  it('answers an empty vault the same way a locked one is answered', () => {
    expect(summarizeStoredCredentials(vaultWith())).toEqual(summarizeStoredCredentials(null))
  })

  it('survives a credential with no decoded claims', () => {
    const out = summarizeStoredCredentials(
      vaultWith(credential({ decodedClaims: undefined as unknown as Record<string, unknown> })),
    )
    expect(out[0].claimKeys).toEqual([])
  })

  it('summarizes every credential held', () => {
    const out = summarizeStoredCredentials(
      vaultWith(credential({ id: 'a' }), credential({ id: 'b' })),
    )
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('buildResharePresentation', () => {
  it('shares ONLY the selected field — no unselected claim reaches the page', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['nombre'],
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.presentation.claims).toEqual({ nombre: 'Titular' })
    for (const [field, value] of Object.entries(SENTINEL)) {
      expect(wire(result), `leaked ${field}`).not.toContain(value)
    }
  })

  it('shares a selected sensitive field, and still nothing else', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['cedula'],
    })

    expect(result.ok && result.presentation.claims).toEqual({ cedula: SENTINEL.cedula })
    expect(wire(result)).toContain(SENTINEL.cedula)
    expect(wire(result)).not.toContain(SENTINEL.salary)
    expect(wire(result)).not.toContain(SENTINEL.address)
  })

  it('does not ship the raw credential alongside the selection', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['nombre'],
    })
    expect(wire(result)).not.toContain('raw-payload-containing')
  })

  it('ignores a field the credential does not have, rather than emitting undefined', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['nombre', 'noSuchField'],
    })
    expect(result.ok && result.presentation.claims).toEqual({ nombre: 'Titular' })
    expect(result.ok && 'noSuchField' in result.presentation.claims).toBe(false)
  })

  it('shares nothing when nothing was selected', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: [],
    })
    expect(result.ok && result.presentation.claims).toEqual({})
    for (const value of Object.values(SENTINEL)) {
      expect(wire(result)).not.toContain(value)
    }
  })

  it('cannot be walked onto a prototype key to reach something it should not', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['constructor', '__proto__', 'toString'],
    })
    // `in` copied Object.prototype members in here; own-property check does not.
    // Asserted on `claims` alone — `selectedFields` legitimately echoes the
    // requested names back, so the whole payload would contain them either way.
    expect(result.ok && Object.keys(result.presentation.claims)).toEqual([])
  })

  it('selecting __proto__ cannot reassign the outgoing object\'s prototype', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['__proto__'],
    })
    const claims = result.ok ? result.presentation.claims : {}
    expect(Object.getPrototypeOf(claims)).toBeNull()
    expect(Object.keys(claims)).toEqual([])
  })

  it('an own claim literally named __proto__ is shared as a KEY when selected', () => {
    const claimsWithOddKey = Object.create(null) as Record<string, unknown>
    Object.defineProperty(claimsWithOddKey, '__proto__', {
      value: 'a-legitimate-value',
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const result = buildResharePresentation(
      vaultWith(credential({ decodedClaims: claimsWithOddKey })),
      { credentialId: 'cred-1', selectedFields: ['__proto__'] },
    )
    const claims = result.ok ? result.presentation.claims : {}
    expect(Object.keys(claims)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(claims)).toBeNull()
  })

  it('serves the credential asked for, not a neighbour', () => {
    const other = credential({
      id: 'cred-2',
      decodedClaims: { nombre: 'Otra Persona', cedula: 'OTHER-SENTINEL' },
    })
    const result = buildResharePresentation(vaultWith(credential(), other), {
      credentialId: 'cred-2',
      selectedFields: ['nombre'],
    })
    expect(result.ok && result.presentation.credentialId).toBe('cred-2')
    expect(result.ok && result.presentation.claims).toEqual({ nombre: 'Otra Persona' })
    expect(wire(result)).not.toContain('OTHER-SENTINEL')
  })

  it('refuses on a locked vault without saying anything about holdings', () => {
    expect(buildResharePresentation(null, { credentialId: 'cred-1', selectedFields: ['nombre'] })).toEqual({
      ok: false,
      error: 'Vault locked',
    })
  })

  it('refuses for an unknown credential id', () => {
    expect(
      buildResharePresentation(vaultWith(credential()), { credentialId: 'nope', selectedFields: ['nombre'] }),
    ).toEqual({ ok: false, error: 'Credential not found' })
  })

  it('echoes the requested field list even where fields were dropped, so the page can tell', () => {
    const result = buildResharePresentation(vaultWith(credential()), {
      credentialId: 'cred-1',
      selectedFields: ['nombre', 'noSuchField'],
    })
    expect(result.ok && result.presentation.selectedFields).toEqual(['nombre', 'noSuchField'])
  })
})
