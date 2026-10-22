import { describe, expect, it } from 'vitest'
import { baseIsStale, changedFields, ownerAccountLabel, ownerAccountUrl, providerLabel, stableStringify } from './revisions.ts'

const base = {
  title: 'Team A',
  payload: { heroes: [{ id: 1, s: 'x' }], note: null },
  tags: { mode: 'pve', diff: 'hard' },
  lang: 'en' as const,
  demoUrl: 'https://youtu.be/abc',
  explanation: 'Hello',
}

describe('revisions', () => {
  it('stringifies independent of key order', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: [1, { f: 1, e: 2 }] } })).toBe(stableStringify({ b: { d: [1, { e: 2, f: 1 }], c: 2 }, a: 1 }))
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it('reports no change for equal content with different key order', () => {
    const same = { ...base, payload: { note: null, heroes: [{ s: 'x', id: 1 }] }, tags: { diff: 'hard', mode: 'pve' } }
    expect(changedFields(base, same)).toEqual([])
  })

  it('lists exactly the fields that differ', () => {
    const next = { ...base, title: 'Team B', payload: { heroes: [{ id: 2, s: 'x' }], note: null }, tags: { mode: 'pvp', diff: 'hard' }, lang: 'ja' as const, demoUrl: 'https://youtu.be/def', explanation: 'Hi' }
    expect(changedFields(base, next)).toEqual(['title', 'payload', 'tags', 'lang', 'demoUrl', 'explanation'])
    expect(changedFields(base, { ...base, explanation: 'Hi' })).toEqual(['explanation'])
    expect(changedFields(base, { ...base, tags: { mode: 'pve' } })).toEqual(['tags'])
  })

  it('flags a revision whose base is older than the submission', () => {
    const sub = { version: 3 } as never
    expect(baseIsStale({ baseVersion: 2, submission: sub })).toBe(true)
    expect(baseIsStale({ baseVersion: 3, submission: sub })).toBe(false)
  })

  it('labels owner accounts', () => {
    expect(providerLabel('discord')).toBe('Discord')
    expect(providerLabel('foo')).toBe('Foo')
    expect(providerLabel(null)).toBe('Account')
    expect(ownerAccountLabel({ provider: 'discord', accountId: '123456789012345678', handle: null })).toBe('Discord 123456…')
    expect(ownerAccountLabel({ provider: 'discord', accountId: '1234', handle: null })).toBe('Discord 1234')
    expect(ownerAccountLabel({ provider: null, accountId: null, handle: null })).toBeNull()
  })

  it('labels Bluesky owners by handle, falling back to the DID, and links by DID', () => {
    const did = 'did:plc:abcdefghijklmnopqrstuvwx'
    expect(providerLabel('bluesky')).toBe('Bluesky')
    expect(ownerAccountLabel({ provider: 'bluesky', accountId: did, handle: 'alice.bsky.social' })).toBe('Bluesky @alice.bsky.social')
    expect(ownerAccountLabel({ provider: 'bluesky', accountId: did, handle: null })).toBe('Bluesky did:plc:abcd…')
    expect(ownerAccountUrl({ provider: 'bluesky', accountId: did })).toBe(`https://bsky.app/profile/${did}`)
    expect(ownerAccountUrl({ provider: 'discord', accountId: '123456789012345678' })).toBeNull()
    expect(ownerAccountUrl({ provider: 'bluesky', accountId: null })).toBeNull()
  })
})
