import { describe, it, expect } from 'vitest'
import { exportToHtml, SOCIAL_PLATFORMS, type Block } from './EmailBlockEditor'
import { htmlToPlainText } from '../lib/emailText'

const social = (links: Array<{ platform: string; url: string }>, extra: Partial<Block> = {}): Block =>
  ({ id: 's1', type: 'social', align: 'center', iconSize: 24, links, ...extra } as Block)

describe('the social block', () => {
  it('renders one linked icon per filled-in link', () => {
    const html = exportToHtml([social([
      { platform: 'instagram', url: 'https://instagram.com/o3capital' },
      { platform: 'linkedin', url: 'https://linkedin.com/company/o3capital' },
    ])])
    expect(html).toContain('href="https://instagram.com/o3capital"')
    expect(html).toContain('href="https://linkedin.com/company/o3capital"')
    expect(html).toContain('/uploads/social-icons/instagram.png')
    expect(html).toContain('/uploads/social-icons/linkedin.png')
  })

  it('leaves out icons with no URL, so nothing looks clickable that is not', () => {
    const html = exportToHtml([social([
      { platform: 'instagram', url: 'https://instagram.com/o3capital' },
      { platform: 'facebook', url: '' },
      { platform: 'x', url: '   ' },
    ])])
    expect(html).toContain('instagram.png')
    expect(html).not.toContain('facebook.png')
    expect(html).not.toContain('/uploads/social-icons/x.png')
  })

  it('renders nothing at all when no link has a URL', () => {
    const html = exportToHtml([social([{ platform: 'website', url: '' }])])
    expect(html).not.toContain('social-icons')
  })

  it('gives every icon alt text, which is what shows when images are blocked', () => {
    const html = exportToHtml([social([
      { platform: 'appstore', url: 'https://apps.apple.com/app/id123' },
    ])])
    expect(html).toContain('alt="App Store"')
  })

  it('survives into the plain-text alternative as a named, reachable link', () => {
    const text = htmlToPlainText(exportToHtml([social([
      { platform: 'website', url: 'https://o3cards.com' },
    ])]))
    expect(text).toContain('https://o3cards.com')
  })

  it('uses a table rather than inline-block, which Outlook collapses', () => {
    const html = exportToHtml([social([{ platform: 'x', url: 'https://x.com/o3capital' }])])
    expect(html).toMatch(/<table[^>]*>\s*<tr>\s*<td[^>]*>\s*<a/)
  })

  it('honours the icon size on both the attribute and the style', () => {
    const html = exportToHtml([social([{ platform: 'youtube', url: 'https://youtube.com/@o3' }], { iconSize: 28 })])
    expect(html).toContain('width="28"')
    expect(html).toContain('width:28px;height:28px')
  })

  it('sanitises a platform key rather than trusting it into a path', () => {
    const html = exportToHtml([social([
      { platform: '../../etc/passwd', url: 'https://example.com' },
    ])])
    expect(html).not.toContain('..')
    expect(html).toContain('/uploads/social-icons/etcpasswd.png')
  })

  it('every offered platform has an icon file name that matches its key', () => {
    for (const p of SOCIAL_PLATFORMS) {
      const html = exportToHtml([social([{ platform: p.key, url: 'https://example.com' }])])
      expect(html).toContain(`/uploads/social-icons/${p.key}.png`)
      expect(html).toContain(`alt="${p.label}"`)
    }
  })
})
