/**
 * Extension-local English locale — self-contained, no monorepo dependency.
 *
 * Covers all views: Wallet, Credentials, Present, Consent, Prepared, Settings, Header.
 */
export default {
  common: {
    cancel: 'Cancel',
    back: 'Back',
    copy: 'Copy',
    copied: 'Copied!',
    delete: 'Delete',
    share: 'Share',
    approve: 'Approve',
    decline: 'Decline',
    refresh: 'Refresh',
    all: 'All',
    none: 'None',
    expired: 'Expired',
    loading: 'Loading...',
    error: 'Error',
    explorer: 'Explorer',
    unlink: 'Unlink',
  },

  header: {
    tabs: {
      wallet: 'Wallet',
      credentials: 'Credentials',
      settings: 'Settings',
    },
  },

  wallet: {
    unlocked: 'Wallet Unlocked',
    locked: 'Wallet Locked',
    noDid: 'No DID created yet',
    unlock: 'Unlock Wallet',
    createDid: 'Create DID',
    lock: 'Lock',
    linkedSolana: 'Linked Solana Wallet',
    linkInstruction: 'Link your Solana wallet from the {page} page in the CORTEX dashboard.',
    linkInstructionPage: 'Identity Wallet',
    linkInstructionDetail: 'Connect your wallet there, then use "Link to Vault" to push the address here.',
    tokens: 'Tokens',
    noTokens: 'No tokens found for this wallet.',
  },

  credentials: {
    title: 'Verifiable Credentials',
    empty: {
      title: 'No Credentials Yet',
      description: 'Verifiable credentials issued to your wallet will appear here. They can be shared with verifiers using selective disclosure.',
    },
    pendingRequests: '{count} pending proof request(s)',
    requestingAccess: '{name} is requesting access',
    preparedReady: '{count} prepared presentation(s) ready',
    deleteConfirm: {
      title: 'Delete Credential?',
      description: 'This will permanently remove the credential from your wallet.',
    },
    issued: 'Issued: {date}',
    expires: 'Expires: {date}',
    claims: '{count} claim | {count} claims',
    onChain: 'On-Chain',
    credential: 'Credential',
  },

  present: {
    title: 'Present Credential',
    selectClaims: 'Select claims to disclose',
    allClaimsShared: 'All claims will be shared',
    nonce: 'Nonce (from verifier) *',
    noncePlaceholder: 'Enter verifier nonce',
    audience: 'Audience (verifier ID)',
    audiencePlaceholder: 'Optional verifier identifier',
    preview: 'Preview what will be shared',
    hidePreview: 'Hide what will be shared',
    sharedClaims: 'Shared claims:',
    generate: 'Generate Presentation',
    generating: 'Generating...',
    ready: 'Presentation Ready',
    copyToClipboard: 'Copy to Clipboard',
    generateAnother: 'Generate Another',
    walletKeyError: 'Wallet key not available',
    generationFailed: 'Generation failed',
  },

  consent: {
    title: 'Proof Request',
    requestingAccess: '{name} is requesting access',
    requestedFields: 'Requested Fields',
    presentationShared: 'Presentation Shared',
    fieldsDisclosed: '{count} field(s) disclosed to {name}',
    requestDeclined: 'Request Declined',
    noDataShared: 'No data was shared with {name}',
    backToCredentials: 'Back to Credentials',
    transport: {
      didcomm: 'DIDComm v2 (P2P encrypted)',
      pushToVault: 'Push to Vault',
      platform: 'Attestto Platform',
    },
    disclosureNotice: 'Only the selected fields will be shared. Other credential data remains private.',
  },

  prepared: {
    title: 'Prepared Presentations',
    empty: {
      title: 'No prepared presentations',
      description: 'Use "Push to Vault" from the CORTEX Share Credential page to pre-build presentations for later use.',
    },
    remaining: '{time} remaining',
    copyAndPresent: 'Copy & Present',
    unknownCredential: 'Unknown',
    verifiableCredential: 'Verifiable Credential',
  },

  settings: {
    title: 'Quick Settings',
    openFull: 'Open Full Settings Page',
  },

  formats: {
    sdJwt: 'SD-JWT',
    jsonLd: 'JSON-LD',
    spl: 'SPL',
    token2022: 'Token-2022',
  },
}
