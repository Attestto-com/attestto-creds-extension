/**
 * SOC-279 — `assertPresence` is required, enforced on the compile channel.
 *
 * The runtime blocker (`crypto/signing-presence-gate.blocker.spec.ts`) asserts
 * the worker binds a NAMED passthrough. This asserts the stronger property that
 * made that binding unavoidable: a `createSigningAdapters` call with no gate at
 * all does not compile.
 *
 * Restoring `assertPresence?: PresenceGate` would silently re-open the original
 * defect — the composition root omits it, the anonymous default takes over, and
 * every signature is produced with an unstated no-op. That regression is a type
 * change, so it belongs in the type channel where it cannot be missed.
 *
 * Guard-the-guard: the `@ts-expect-error` below is itself the assertion. If the
 * field became optional again the error would disappear, and `@ts-expect-error`
 * with nothing to suppress is an error in its own right — so this reddens in
 * both directions.
 */
import type { SigningAdapterDeps } from './signing-adapters'

/** Everything the adapters need EXCEPT the gate. */
type DepsWithoutGate = Omit<SigningAdapterDeps, 'assertPresence'>

declare const withoutGate: DepsWithoutGate

// @ts-expect-error — a gate-less deps object must not satisfy SigningAdapterDeps.
const _mustNotCompile: SigningAdapterDeps = withoutGate

// …and the same object WITH a gate must compile, so the check above is not
// passing for some unrelated structural reason.
declare const gate: SigningAdapterDeps['assertPresence']
const _mustCompile: SigningAdapterDeps = { ...withoutGate, assertPresence: gate }

void _mustNotCompile
void _mustCompile
