/**
 * Story 1.13 exit criterion — what makes `background.ts` a composition root.
 *
 * The acceptance criterion asks for a test that reddens if a handler body
 * reappears in the entrypoint. A line-count cap does not do that: a file can sit
 * under any cap and still be full of handler bodies, and the cap gets raised the
 * first time it is inconvenient. So these rules check STRUCTURE, and each one is
 * a regression that actually happened in this file during Story 1.13:
 *
 *  - a domain service imported and called inline (`parseSdJwt`, `createChapiVp`)
 *  - `crypto.subtle.generateKey` in the entrypoint — twice, in two copies
 *  - wire envelopes hand-written next to `chrome.tabs.sendMessage`
 *  - the vault read, mutated, and written in the middle of a `case`
 *
 * A handler body cannot be written without tripping at least one of them: to do
 * domain work you need a service, a crypto primitive, or the vault; to answer a
 * page you need the wire.
 *
 * The rules are pure functions over source text so the spec can run them against
 * synthetic VIOLATING sources as well as against the real file. A guard only
 * proven against the file it guards is a guard whose failure mode is untested.
 */
import ts from 'typescript'

export interface RuleViolation {
  line: number
  detail: string
}

export interface RuleResult {
  rule: string
  /** Why this rule stands, for the failure message. */
  because: string
  violations: RuleViolation[]
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('entrypoint.ts', source, ts.ScriptTarget.Latest, true)
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function eachNode(sf: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(sf)
}

/**
 * A composition root wires; it does not compute. Domain services live behind
 * handlers, so importing one into the entrypoint means the work is being done
 * here.
 */
export function noDomainServiceImports(source: string): RuleResult {
  const sf = parse(source)
  const violations: RuleViolation[] = []
  eachNode(sf, (node) => {
    if (!ts.isImportDeclaration(node)) return
    const spec = (node.moduleSpecifier as ts.StringLiteral).text
    if (spec.startsWith('@/services/')) {
      violations.push({ line: lineOf(node, sf), detail: spec })
    }
  })
  return {
    rule: 'no-domain-service-imports',
    because:
      'domain work belongs in a handler; importing @/services/* into the entrypoint means it is being done here',
    violations,
  }
}

/**
 * The F1 capability fence: the entrypoint holds no crypto symbol. Signing and
 * key generation reach it only as injected adapters.
 */
export function noCryptoPrimitives(source: string): RuleResult {
  const sf = parse(source)
  const violations: RuleViolation[] = []
  eachNode(sf, (node) => {
    if (!ts.isPropertyAccessExpression(node)) return
    if (node.name.text !== 'subtle') return
    violations.push({ line: lineOf(node, sf), detail: node.getText(sf) })
  })
  return {
    rule: 'no-crypto-primitives',
    because: 'the F1 fence: signing and keygen are injected adapters, never reached from the entrypoint',
    violations,
  }
}

/**
 * Every background → page message goes through `background/transport/`. The
 * entrypoint must not construct an envelope or reach `chrome.tabs.sendMessage`
 * itself, or the wire contract stops having one home.
 */
export function noWireEnvelopes(source: string): RuleResult {
  const sf = parse(source)
  const violations: RuleViolation[] = []
  eachNode(sf, (node) => {
    if (ts.isIdentifier(node) && node.text === 'notifyTab') {
      violations.push({ line: lineOf(node, sf), detail: 'notifyTab' })
      return
    }
    if (!ts.isPropertyAccessExpression(node)) return
    if (node.name.text !== 'sendMessage') return
    if (node.expression.getText(sf) === 'chrome.tabs') {
      violations.push({ line: lineOf(node, sf), detail: 'chrome.tabs.sendMessage' })
    }
  })
  return {
    rule: 'no-wire-envelopes',
    because: 'the transport module is the single writer of the background → page envelope',
    violations,
  }
}

/** Vault fields whose mutation is a handler's job, never the entrypoint's. */
const VAULT_RECORD_FIELDS = new Set([
  'credentials',
  'linkedIdentities',
  'proofRequests',
  'preparedPresentations',
  'linkedSolanaAddress',
  'keyShares',
  'privateKeyJwk',
  'ed25519PrivateKeyJwk',
  'holderDid',
  'siteDids',
])

/**
 * Read-mutate-write against the vault is the clearest signature of a handler
 * body. The entrypoint may pass the vault utilities into an adapter; it may not
 * assign to a vault record field.
 */
export function noVaultMutation(source: string): RuleResult {
  const sf = parse(source)
  const violations: RuleViolation[] = []
  eachNode(sf, (node) => {
    if (!ts.isBinaryExpression(node)) return
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
    const left = node.left
    if (!ts.isPropertyAccessExpression(left)) return
    if (!VAULT_RECORD_FIELDS.has(left.name.text)) return
    violations.push({ line: lineOf(node, sf), detail: left.getText(sf) })
  })
  return {
    rule: 'no-vault-mutation',
    because: 'read-mutate-write against the vault is a handler body, not wiring',
    violations,
  }
}

/** Statements inside a node, not counting the blocks that contain them. */
function statementCount(node: ts.Node): number {
  let count = 0
  const walk = (n: ts.Node): void => {
    if (ts.isStatement(n) && !ts.isBlock(n)) count++
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(node, walk)
  return count
}

export interface CaseSize {
  caseName: string
  statements: number
}

/** Every `case` in the message switch, largest first. */
export function measureCaseClauses(source: string): CaseSize[] {
  const sf = parse(source)
  const sizes: CaseSize[] = []
  eachNode(sf, (node) => {
    if (!ts.isCaseClause(node)) return
    sizes.push({ caseName: node.expression.getText(sf), statements: statementCount(node) })
  })
  return sizes.sort((a, b) => b.statements - a.statements)
}

/**
 * A size RATCHET, and honestly labelled as one: it cannot prove a case is
 * wiring, only that no case grew past what the migration left behind. It earns
 * its place by catching the slow way a composition root rots — one more branch
 * at a time — which the structural rules above do not see.
 */
export function caseClauseBudget(source: string, maxStatements: number): RuleResult {
  return {
    rule: 'case-clause-budget',
    because: `a delegating case is small; ${maxStatements} statements is the ceiling the migration left`,
    violations: measureCaseClauses(source)
      .filter((c) => c.statements > maxStatements)
      .map((c) => ({ line: 0, detail: `${c.caseName} has ${c.statements} statements` })),
  }
}

/** Run every structural rule. The budget is separate — it takes a threshold. */
export function compositionRootRules(source: string): RuleResult[] {
  return [
    noDomainServiceImports(source),
    noCryptoPrimitives(source),
    noWireEnvelopes(source),
    noVaultMutation(source),
  ]
}
