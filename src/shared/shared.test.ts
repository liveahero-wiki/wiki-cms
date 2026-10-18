import { describe, expect, it } from 'vitest'
import { checkExplanation, renderExplanation } from './markdown-policy.ts'
import { langFromTag, pickText } from './i18n.ts'
import { ipKey } from '../core/ip.ts'
import { normalizeDemoUrl } from '../core/demo-url.ts'
import { checkTitle } from './title-policy.ts'
import { lahTeamFormation } from '../types/lah-team-formation/index.ts'

describe('markdown policy', () => {
  const bad: [string, string][] = [
    ['<b>x</b>', 'md_html'],
    ['<!-- c -->', 'md_html'],
    ['<!DOCTYPE html>', 'md_html'],
    ['[a](http://example.com)', 'md_link_invalid'],
    ['[a]: https://example.com', 'md_link'],
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

describe('markdown policy: external links', () => {
  const codes = (src: string) => checkExplanation(src).map((e) => e.code)

  it('accepts inline https links and renders them with the real host', () => {
    const src = 'Guide: [full **guide**](https://www.notion.so/team/abc?utm_source=x&page=2#top) here'
    expect(checkExplanation(src)).toEqual([])
    expect(renderExplanation(src)).toContain(
      '<a class="cms-ext" href="https://www.notion.so/team/abc?page=2" target="_blank" rel="noopener noreferrer nofollow ugc">' +
        'full <strong>guide</strong> <span class="cms-ext-host">notion.so ↗</span></a>',
    )
  })

  it('accepts up to 3 links and rejects the 4th', () => {
    const l = (n: number) => `[g${n}](https://example.com/${n})`
    expect(checkExplanation([1, 2, 3].map(l).join(' '))).toEqual([])
    expect(codes([1, 2, 3, 4].map(l).join(' '))).toEqual(['md_link_limit'])
    expect(checkExplanation([1, 2, 3, 4].map(l).join(' '))[0]!.params).toEqual({ max: 3 })
  })

  const invalid = [
    '[a](http://example.com)',
    '[a](javascript:alert(1))',
    '[a](//example.com)',
    '[a](/relative)',
    '[a](https://127.0.0.1/x)',
    '[a](https://[::1]/x)',
    '[a](https://2130706433/x)',
    '[a](https://user:pw@example.com/)',
    '[a](https://example.com:8443/)',
    '[a](https://xn--e1awd7f.com/)',
    '[a](https://bit.ly/abc)',
    '[a](https://localhost/)',
    '[a](https://intranet/)',
    '[a](https://' + 'a'.repeat(200) + '.com/)',
  ]
  for (const src of invalid) {
    it(`rejects ${src.slice(0, 40)}`, () => expect(codes(src).length).toBeGreaterThan(0))
  }

  it('rejects link text that impersonates another site or is empty', () => {
    expect(codes('[youtube.com](https://evil.example.org/x)')).toEqual(['md_link_text'])
    expect(codes('[https://youtube.com](https://example.org/x)')).toEqual(['md_link_text'])
    expect(codes('[ ](https://example.org/x)')).toEqual(['md_link_text'])
    expect(codes('[' + 'x'.repeat(81) + '](https://example.org/x)')).toEqual(['md_link_text'])
    expect(codes('[youtube.com](https://www.youtube.com/watch?v=1)')).toEqual([])
  })

  it('still rejects bare URLs, autolinks, images and reference links', () => {
    for (const src of ['see https://example.com', 'www.example.com', '<https://example.com>', '![i](https://example.com/a.png)', '[a][1]\n\n[1]: https://example.com']) {
      expect(codes(src), src).toContain('md_link')
    }
    expect(codes('`https://example.com`')).toContain('md_link')
  })

  it('never emits an unvalidated or surplus <a>, even if the check is bypassed', () => {
    const html = renderExplanation('[a](javascript:alert(1)) [b](http://example.com) [c](https://bit.ly/x) [d](https://1.example.com) [e](https://2.example.com) [f](https://3.example.com) [g](https://4.example.com)')
    expect(html.match(/<a /g)).toHaveLength(3)
    expect(html).not.toMatch(/href="(?!https:\/\/[123]\.example\.com)/)
    expect(html).not.toMatch(/http:\/\/|bit\.ly|4\.example\.com"/)
    expect(html).toContain(' g</p>')
  })

  it('escapes link text and host', () => {
    const html = renderExplanation('[a & <b>](https://example.com/?q=1&r=2)')
    expect(html).toContain('a &amp; &lt;b&gt;')
    expect(html).toContain('href="https://example.com/?q=1&amp;r=2"')
  })
})

describe('demo url', () => {
  const opts = lahTeamFormation.demoUrl!
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

describe('title policy', () => {
  const rules = { required: true, minLength: 4, maxLength: 50 }
  const codesOf = (raw: unknown) => checkTitle(raw, rules).errors.map((e) => e.code)
  it('normalises width, case of spaces and trims', () => {
    expect(checkTitle('  ＳＳＳ \t  team\n ', rules)).toEqual({ value: 'SSS team', errors: [] })
  })
  it('enforces required and length in code points', () => {
    expect(codesOf('')).toEqual(['title_required'])
    expect(codesOf('   ')).toEqual(['title_required'])
    expect(codesOf(undefined)).toEqual(['title_required'])
    expect(codesOf('abc')).toEqual(['title_too_short'])
    expect(codesOf('abcd')).toEqual([])
    expect(codesOf('a'.repeat(50))).toEqual([])
    expect(codesOf('a'.repeat(51))).toEqual(['title_too_long'])
    expect(codesOf('😀'.repeat(50))).toEqual([])
    expect(codesOf('三回合通关')).toEqual([])
    expect(checkTitle('', { ...rules, required: false }).errors).toEqual([])
  })
  it('rejects links, domains and invisible characters, but allows names like Lv.60 and No.1', () => {
    for (const bad of ['see https://x.test now', 'www.example.org team', 'best at example.com', '[a](b) team']) expect(codesOf(bad), bad).toContain('title_link')
    expect(codesOf('Lv.60 auto clear')).toEqual([])
    expect(codesOf('No.1 team v1.2')).toEqual([])
    expect(codesOf('zero​width')).toContain('title_invalid')
  })
})
