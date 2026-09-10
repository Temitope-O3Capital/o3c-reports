// Payment-channel logo badges. Real bank marks are served as static assets from
// /banks (public/banks/*, sourced from github.com/Pariola-droid/Nigerian-Bank-Logos;
// Polaris from seeklogo). The in-app channel gets a phone glyph. Each mark is square
// with a white ground, shown in a rounded tile so the set reads uniformly on either
// theme.
const BANK: Record<string, { name: string; src?: string; icon?: string; bg?: string }> = {
  GTB:      { name: 'GTBank',   src: '/banks/gtco.svg' },
  POLARIS:  { name: 'Polaris',  src: '/banks/polaris.png' },
  FIDELITY: { name: 'Fidelity', src: '/banks/fidelity.svg' },
  ZENITH:   { name: 'Zenith',   src: '/banks/zenith.svg' },
  FCMB:     { name: 'FCMB',     src: '/banks/fcmb.svg' },
  APP:      { name: 'App',      icon: 'smartphone', bg: '#0E2841' },
}

export function bankName(code: string): string {
  return BANK[code]?.name ?? code
}

export function BankLogo({ code, size = 22 }: { code: string; size?: number }) {
  const b = BANK[code]
  const radius = Math.round(size * 0.27)

  if (b?.src) {
    return (
      <img
        src={b.src}
        alt={b.name}
        width={size}
        height={size}
        loading="lazy"
        style={{ width: size, height: size, borderRadius: radius, objectFit: 'contain', background: '#fff', border: '1px solid rgba(0,0,0,0.10)', flexShrink: 0, display: 'block' }}
      />
    )
  }

  if (b?.icon) {
    return (
      <span style={{ width: size, height: size, borderRadius: radius, background: b.bg ?? '#0E2841', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#fff', lineHeight: 1 }}>
        <span className="material-symbols-rounded" style={{ fontSize: Math.round(size * 0.6), color: '#fff' }}>{b.icon}</span>
      </span>
    )
  }

  // Fallback: brand-neutral monogram tile for any unmapped channel.
  return (
    <span style={{ width: size, height: size, borderRadius: radius, background: '#64748B', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#fff', fontWeight: 800, fontSize: Math.round(size * 0.42), fontFamily: 'var(--font-sans)' }}>
      {code.slice(0, 2).toUpperCase()}
    </span>
  )
}
