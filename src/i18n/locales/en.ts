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

  home: {
    openSettings: 'Open settings',
    firstRun: {
      title: 'Anti-phishing protection is on',
      body: 'Browse normally — Attestto will warn you if a site tries to impersonate one you trust.',
      cta: 'Set up identity →',
      alreadyHave: 'Already have one?',
      signIn: 'Sign in',
      footer: 'Sign in to sites · sign documents · store credentials',
    },
    trustedSites: {
      title: 'Your trusted sites',
      manage: 'Manage →',
    },
    identity: {
      active: 'Identity active',
      upgradeBody: 'Identity lets you sign in to sites, sign documents, and store credentials.',
      setupLink: 'Set up identity →',
    },
    currentSite: {
      loading: 'Checking site…',
      noSite: 'Visit a website to check it.',
      verifiedLabel: 'Verified institution',
      pinnedLabel: 'You trust this site',
      neutralLabel: 'Not yet evaluated',
      yellowLabel: 'Use caution',
      yellowReason: 'This site uses an unusual encoding.',
      redLabel: 'Possible impersonation',
      redReason: 'This site does not match any verified institution.',
      redBlockedReason: 'You reported this site as suspicious.',
      categoryPrefix: 'Category',
      trustAction: 'Trust this site',
      untrustAction: 'Stop trusting this site',
      reportAction: 'Report this site',
      detailsAction: 'View details',
      backToSafetyAction: 'Go back to safety',
      identityFooter: 'Optional: sign in to sites with Digital ID',
      setUpLink: 'Set up identity →',
    },
  },
  report: {
    title: 'Report this site',
    hostLabel: 'Site',
    reasonLabel: 'Reason (optional)',
    reasonPlaceholder: 'Why is this site suspicious?',
    shareCheckbox: 'Also share this report with the Attestto community',
    shareHelp: 'Your local block always works. Sharing helps us protect other users — opt in per report only.',
    submit: 'Add to my blocklist',
    submitting: 'Reporting…',
    shareFailed: 'Reported locally. Community share failed; will retry later.',
  },

  settingsNav: {
    overview: 'Overview',
    security: 'Security',
    privacy: 'Privacy',
    subtitle: 'Settings',
  },

  overview: {
    title: 'Welcome to Attestto ID',
    subtitle: 'Anti-phishing protection is on. Identity is optional.',
    protection: {
      title: 'Anti-phishing protection',
      body: 'Attestto checks the sites you visit and warns you when one tries to impersonate another. Works on every site — no setup needed.',
      trustedCount: 'no sites in your trusted list yet | 1 site in your trusted list | {n} sites in your trusted list',
      manage: 'Manage your trusted sites',
    },
    identity: {
      title: 'Identity',
      activeBody: 'Your identity is active.',
      upgradeBody: 'Sign in to sites, sign documents, and store credentials. Optional — anti-phishing works without it.',
      setup: 'Set up identity',
      alreadyHave: 'Already have one?',
      signIn: 'Sign in',
    },
    cards: {
      security: 'Trusted sites, pin behavior, notifications.',
      privacy: 'How Attestto handles sharing and usage data.',
    },
  },

  security: {
    subtitle: 'Control how Attestto handles trusted sites and warnings.',
    saved: 'Saved',
    pinBehavior: {
      title: 'When you trust a site',
      description: 'Choose what happens when you confirm a site as trusted.',
      ask:   { label: 'Ask first',       desc: 'Confirm before adding the site. Prevents accidental trust.' },
      auto:  { label: 'Add right away',  desc: 'No confirmation. Fastest; least guard-rail.' },
      never: { label: 'Disable',         desc: 'Hide the action everywhere. Maximum caution.' },
    },
    notifications: {
      title: 'Notifications',
      description: 'Browser notifications appear outside the page and cannot be faked by a website.',
      onRed:      'Notify me when a site is flagged as dangerous',
      onRotation: 'Notify me when a trusted site\'s certificate changes',
    },
    trustedSites: {
      title: 'Your trusted sites',
      description: 'Sites you have explicitly added to your trusted list. These checks live only on this device.',
      empty: 'You have not added any trusted sites yet.',
      remove: 'Remove',
      addedOn: 'Added {date}',
    },
  },

  privacy: {
    subtitle: 'What Attestto does — and does not — do with your data.',
    sharing: {
      title: 'No always-on sharing',
      body: 'There are no toggles here that share data automatically. By design.',
      reminder: 'Whenever the extension wants to send data anywhere — for a report, a verification, anything — it asks you at that moment. No setting can override that.',
    },
    telemetry: {
      title: 'No usage tracking',
      body: 'Attestto does not collect or send usage data. If this ever changes, you will be asked at each emission, not via a setting.',
    },
    trustSurface: {
      title: 'What you can trust on screen',
      body1: 'A web page can show anything it wants — including a fake security bar. So the only Attestto surfaces you should fully trust are the ones the browser controls: the toolbar icon, the popup that opens when you click it, and browser notifications.',
      body2: 'If a page shows something that looks like Attestto but you have not clicked the toolbar icon, treat it as part of the page — not as us.',
    },
  },

  formats: {
    sdJwt: 'SD-JWT',
    jsonLd: 'JSON-LD',
    spl: 'SPL',
    token2022: 'Token-2022',
  },
}
