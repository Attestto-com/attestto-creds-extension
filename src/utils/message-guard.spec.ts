import { describe, it, expect, vi } from 'vitest'
import { isExtensionSender, getSenderOrigin } from './message-guard'

// Extension id "testid" → base URL "chrome-extension://testid/".
vi.stubGlobal('chrome', {
  runtime: {
    id: 'testid',
    getURL: (path: string) => `chrome-extension://testid/${path}`,
  },
})

type Sender = chrome.runtime.MessageSender

const extensionPage: Sender = {
  id: 'testid',
  url: 'chrome-extension://testid/options.html',
  // no `tab` → came from the extension's own page context
}

const webTab: Sender = {
  id: 'testid',
  tab: { id: 7 } as chrome.tabs.Tab,
  origin: 'https://app.attestto.com',
  url: 'https://app.attestto.com/onboarding',
}

describe('isExtensionSender', () => {
  it('is true for an extension-page sender (no tab, chrome-extension url)', () => {
    expect(isExtensionSender(extensionPage)).toBe(true)
  })

  it('is false for a web tab sender (has tab)', () => {
    expect(isExtensionSender(webTab)).toBe(false)
  })

  it('is false when a tab is present even if the url is chrome-extension (defensive)', () => {
    const spoofish: Sender = {
      id: 'testid',
      tab: { id: 9 } as chrome.tabs.Tab,
      url: 'chrome-extension://testid/x.html',
    }
    expect(isExtensionSender(spoofish)).toBe(false)
  })

  it('is false for a foreign chrome-extension url (different id)', () => {
    const other: Sender = { id: 'other', url: 'chrome-extension://other/options.html' }
    expect(isExtensionSender(other)).toBe(false)
  })

  it('is false for undefined / empty senders', () => {
    expect(isExtensionSender(undefined as unknown as Sender)).toBe(false)
    expect(isExtensionSender({})).toBe(false)
  })
})

describe('getSenderOrigin', () => {
  it('returns the extension origin for an extension-page sender', () => {
    expect(getSenderOrigin(extensionPage)).toBe('chrome-extension://testid')
  })

  it('returns sender.origin for a web tab sender', () => {
    expect(getSenderOrigin(webTab)).toBe('https://app.attestto.com')
  })

  it('derives the origin from sender.url when sender.origin is absent', () => {
    const noOrigin: Sender = {
      id: 'testid',
      tab: { id: 3 } as chrome.tabs.Tab,
      url: 'https://example.com/some/path?q=1',
    }
    expect(getSenderOrigin(noOrigin)).toBe('https://example.com')
  })

  it('ignores a page-controlled origin field on the message body (only reads sender)', () => {
    // The function signature takes only `sender`; there is no way to pass payload
    // origin. This test documents the contract: a malicious payload.origin cannot
    // reach the trust decision because callers pass `sender`, resolved by Chrome.
    expect(getSenderOrigin(webTab)).toBe('https://app.attestto.com')
  })

  it('returns null when neither origin nor a valid url is present', () => {
    expect(getSenderOrigin({ id: 'testid', tab: { id: 1 } as chrome.tabs.Tab })).toBeNull()
    expect(getSenderOrigin({})).toBeNull()
    expect(getSenderOrigin(undefined as unknown as Sender)).toBeNull()
  })
})
