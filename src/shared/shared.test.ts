import { describe, expect, it } from 'vitest'
import { checkExplanation, renderExplanation } from './markdown-policy.ts'
import { langFromTag, pickText } from './i18n.ts'
import { ipKey } from '../core/ip.ts'
import { normalizeDemoUrl } from '../core/demo-url.ts'
import { lahTeamFormation } from '../types/lah-team-formation/index.ts'

describe('markdown policy', () => {
  const bad: [string, string][] = [
    ['<b>x</b>', 'md_html'],
    ['<!-- c -->', 'md_html'],
    ['<!DOCTYPE html>', 'md_html'],
    ['[a](http://x)', 'md_link'],
    ['[a]: http://x', 'md_link'],
    ['![i](x)', 'md_link'],
    ['<https://x.com>', 'md_link'],
    ['see https://example.com now', 'md_link'],
    ['go to www.example.com', 'md_link'],
  ]
  for (const [src, code] of bad) {
    it(`rejects ${src}`, () => expect(checkExplanation(src).map((e) => e.code)).toContain(code))
  }
  it('allows plain text mentioning example.com and entities, and renders it as text', () => {
    const src = 'Use the trick from example.com &amp; 5 < 6 and a > b'
    expect(checkExplanation(src)).toEqual([])
    const html = renderExplanation(src)
    expect(html).not.toMatch(/<a |<img/)
    expect(html).toContain('example.com')
  })
  it('never renders links/images/html even if policy is bypassed', () => {
    const html = renderExplanation('[a](http://x) ![i](y) <script>alert(1)</script> <b>b</b>')
    expect(html).not.toMatch(/<a |<img|<script|<b>/)
  })
  it('remaps headings to h3+', () => {
    const html = renderExplanation('# one\n\n## two\n\n###### six')
    expect(html).toContain('<h3>one</h3>')
    expect(html).toContain('<h4>two</h4>')
    expect(html).toContain('<h6>six</h6>')
    expect(html).not.toMatch(/<h[12]>/)
  })
  it('renders lists and emphasis', () => {
    expect(renderExplanation('- a\n- b\n\n**bold**')).toMatch(/<ul>[\s\S]*<strong>bold<\/strong>/)
  })
})

describe('demo url', () => {
  const opts = lahTeamFormation.demoUrl
  const ok = (s: string) => {
    const r = normalizeDemoUrl(s, opts)
    return r.ok ? r.value : `ERR:${r.error.code}`
  }
  it('accepts allowed hosts and normalizes', () => {
    expect(ok('https://youtu.be/abc?si=zzz&t=30')).toBe('https://youtu.be/abc?t=30')
    expect(ok('https://www.youtube.com/watch?v=abc&feature=share&utm_source=x&t=5')).toBe('https://www.youtube.com/watch?v=abc&t=5')
    expect(ok('https://x.com/u/status/1?s=20&t=abc')).toBe('https://x.com/u/status/1')
    expect(ok('https://bsky.app/profile/a/post/b')).toBe('https://bsky.app/profile/a/post/b')
  })
  it('allows an empty link when optional', () => {
    expect(ok('')).toBe('')
    expect(ok('   ')).toBe('')
    expect(normalizeDemoUrl('', { ...opts, required: true }).ok).toBe(false)
  })
  it('rejects bad input', () => {
    expect(ok('http://youtu.be/abc')).toBe('ERR:demo_https')
    expect(ok('https://evil.com/abc')).toBe('ERR:demo_host')
    expect(ok('https://youtu.be.evil.com/abc')).toBe('ERR:demo_host')
    expect(ok('https://user:pw@youtu.be/abc')).toBe('ERR:demo_invalid')
    expect(ok('https://youtu.be:8443/abc')).toBe('ERR:demo_invalid')
    expect(ok('not a url')).toBe('ERR:demo_invalid')
    expect(ok('https://youtu.be/' + 'a'.repeat(300))).toBe('ERR:demo_too_long')
  })
})

describe('ipKey', () => {
  it('keeps IPv4 and truncates IPv6 to /64', () => {
    expect(ipKey('203.0.113.5')).toBe('203.0.113.5')
    expect(ipKey('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::')
    expect(ipKey('2001:DB8:abcd:12::1')).toBe('2001:db8:abcd:12::')
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::')
    expect(ipKey('::1')).toBe('0:0:0:0::')
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4')
  })
  it('two addresses in the same /64 collide; different /64 do not', () => {
    expect(ipKey('2001:db8:1:2::1')).toBe(ipKey('2001:db8:1:2:ffff::9'))
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'))
  })
  it('rejects garbage', () => {
    for (const s of ['', 'abc', '1.2.3', '1.2.3.999', '1:2:3', 'g::1', '1::2::3']) expect(ipKey(s), s).toBeNull()
  })
})

describe('i18n helpers', () => {
  it('maps tags to langs', () => {
    expect(langFromTag('ja-JP')).toBe('ja')
    expect(langFromTag('zh-TW')).toBe('zh-Hant')
    expect(langFromTag('zh-Hant-HK')).toBe('zh-Hant')
    expect(langFromTag('zh-CN')).toBe('zh-Hans')
    expect(langFromTag('zh')).toBe('zh-Hans')
    expect(langFromTag('fr')).toBeNull()
  })
  it('pickText falls back to en', () => {
    expect(pickText({ en: 'a', ja: 'b' }, 'ja')).toBe('b')
    expect(pickText({ en: 'a' }, 'zh-Hant')).toBe('a')
  })
})
