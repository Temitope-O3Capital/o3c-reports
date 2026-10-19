import { describe, it, expect } from 'vitest'
import { htmlToPlainText, plainTextIsUseless } from './emailText'

// The exact opening of every campaign template on the book. The old conversion
// (strip tags, collapse whitespace) kept the CONTENTS of <style>, which is why all
// nine campaigns shipped their stylesheet as the plain-text alternative.
const REAL_TEMPLATE_HEAD =
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>` +
  `<style>body{margin:0;padding:0;background:#E8ECF2;}a{color:inherit;}` +
  `img{border:0;max-width:100%;height:auto;}@media(max-width:600px)` +
  `{.ec{width:100%!important;border-radius:0!important;}}</style></head><body>`

describe('htmlToPlainText', () => {
  it('drops stylesheet CONTENTS, not just the tags', () => {
    const out = htmlToPlainText(REAL_TEMPLATE_HEAD + '<p>Dear Cardholder,</p></body></html>')
    expect(out).toBe('Dear Cardholder,')
    expect(out).not.toMatch(/margin|background|#E8ECF2|max-width/)
  })

  it('drops script and comment contents too', () => {
    const out = htmlToPlainText('<script>var a={b:1};</script><!-- hidden --><p>Visible</p>')
    expect(out).toBe('Visible')
  })

  it('keeps link destinations, because the text part is all some recipients get', () => {
    const out = htmlToPlainText('<a href="https://o3cards.com/app">Download the app</a>')
    expect(out).toBe('Download the app (https://o3cards.com/app)')
  })

  it('does not print a URL twice when the label is the URL', () => {
    expect(htmlToPlainText('<a href="https://o3cards.com">https://o3cards.com</a>'))
      .toBe('https://o3cards.com')
  })

  it('ignores anchors and javascript hrefs but keeps their text', () => {
    expect(htmlToPlainText('<a href="#top">Back to top</a>')).toBe('Back to top')
    expect(htmlToPlainText('<a href="javascript:void(0)">Click</a>')).toBe('Click')
  })

  it('surfaces image alt text, which is authored for exactly this case', () => {
    expect(htmlToPlainText('<img src="/uploads/x.jpg" alt="A Better O3 Cards Experience"/>'))
      .toBe('[A Better O3 Cards Experience]')
  })

  it('breaks lines on block boundaries instead of flattening to one line', () => {
    const out = htmlToPlainText('<p>One</p><p>Two</p><br/>Three')
    expect(out.split('\n').filter(Boolean)).toEqual(['One', 'Two', 'Three'])
  })

  it('collapses runaway blank lines to at most one', () => {
    expect(htmlToPlainText('<p>A</p><div></div><div></div><div></div><p>B</p>')).toBe('A\n\nB')
  })

  it('decodes the entities our templates actually emit', () => {
    expect(htmlToPlainText('<p>Terms &amp; conditions &mdash; O3&nbsp;Capital</p>'))
      .toBe('Terms & conditions — O3 Capital')
  })

  it('returns empty for empty input rather than throwing', () => {
    expect(htmlToPlainText('')).toBe('')
    expect(htmlToPlainText(undefined as unknown as string)).toBe('')
  })
})

describe('plainTextIsUseless', () => {
  it('flags the stylesheet the old conversion produced', () => {
    const old = REAL_TEMPLATE_HEAD.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(plainTextIsUseless(old)).toBe(true)
  })

  it('flags an image-only email, which is what campaign 10 was', () => {
    expect(plainTextIsUseless(htmlToPlainText('<img src="/uploads/x.jpg" alt=""/>'))).toBe(true)
  })

  it('accepts a real message', () => {
    const body = htmlToPlainText(
      REAL_TEMPLATE_HEAD +
      '<p>Dear Cardholder,</p><p>A new version of the O3 Cards Mobile App is now ' +
      'available. Please visit your app store and update to the latest version.</p>',
    )
    expect(plainTextIsUseless(body)).toBe(false)
  })
})
