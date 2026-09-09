/**
 * BankLogo — renders a bank's logo as a compact branded badge.
 * Falls back to a styled text abbreviation if the bank has no dedicated logo.
 *
 * Usage:
 *   <BankLogo bankKey="gtbank" size={32} />
 *   <BankLogo bankKey="access_bank" size={24} className="rounded" />
 */
/* eslint-disable react-refresh/only-export-components -- BANK_NAMES/getBankName are small, tightly-coupled lookups for this component; splitting them into a separate file only trades a Fast Refresh nicety (dev-only) for extra module indirection. */
import React from "react";
import logoGtco from "./logos/gtco.svg";
import logoAccesscorp from "./logos/accesscorp.svg";
import logoZenithbank from "./logos/zenithbank.svg";
import logoUba from "./logos/uba.svg";
import logoFirstholdco from "./logos/firstholdco.svg";
import logoFidelity from "./logos/fidelity.svg";
import logoStanbic from "./logos/stanbic.svg";
import logoEti from "./logos/eti.svg";
import logoSterlingng from "./logos/sterlingng.svg";
import logoWemabank from "./logos/wemabank.svg";
import logoFcmb from "./logos/fcmb.svg";

interface BankLogoProps {
  bankKey: string;
  size?: number;
  className?: string;
}

// Real logos, sourced from the MIT-licensed nigerianbanklogos.xyz /
// Pariola-droid/Nigerian-Bank-Logos collection (parent-holdco brand marks —
// e.g. GTCO for GTBank, Access Holdings for Access Bank — verified visually
// against each bank's actual public branding before use). Only 11 of our 20
// bank keys are covered by that collection; the rest (fintechs/neobanks —
// moniepoint, palmpay, opay, kuda_bank, carbon — plus polaris_bank,
// keystone_bank, citibank, union_bank) fall through to the initials badge
// below, same as an unrecognized key always has.
const LOGO_SRC: Record<string, string> = {
  gtbank: logoGtco,
  access_bank: logoAccesscorp,
  zenith_bank: logoZenithbank,
  uba: logoUba,
  first_bank: logoFirstholdco,
  fidelity_bank: logoFidelity,
  stanbic_ibtc: logoStanbic,
  ecobank: logoEti,
  sterling_bank: logoSterlingng,
  wema_bank: logoWemabank,
  fcmb: logoFcmb,
};

// Brand colors per bank
const BRAND: Record<string, { bg: string; text: string; label: string }> = {
  gtbank:        { bg: "#f57c00", text: "#fff", label: "GT" },
  access_bank:   { bg: "#e4002b", text: "#fff", label: "AC" },
  zenith_bank:   { bg: "#d42027", text: "#fff", label: "ZB" },
  first_bank:    { bg: "#003087", text: "#fff", label: "FB" },
  uba:           { bg: "#c8102e", text: "#fff", label: "UB" },
  wema_bank:     { bg: "#9b1c9b", text: "#fff", label: "WB" },
  moniepoint:    { bg: "#0a3d62", text: "#fff", label: "MP" },
  palmpay:       { bg: "#00b386", text: "#fff", label: "PP" },
  opay:          { bg: "#1a9b3c", text: "#fff", label: "OP" },
  polaris_bank:  { bg: "#e63027", text: "#fff", label: "PB" },
  keystone_bank: { bg: "#005a9e", text: "#fff", label: "KB" },
  stanbic_ibtc:  { bg: "#1a3c6e", text: "#fff", label: "SI" },
  sterling_bank: { bg: "#e2001a", text: "#fff", label: "SB" },
  fidelity_bank: { bg: "#003d6b", text: "#fff", label: "FD" },
  union_bank:    { bg: "#003366", text: "#fff", label: "UNB" },
  kuda_bank:     { bg: "#521cf2", text: "#fff", label: "KD" },
  carbon:        { bg: "#2d3436", text: "#fff", label: "CB" },
  fcmb:          { bg: "#00843d", text: "#fff", label: "FC" },
  ecobank:       { bg: "#003087", text: "#fff", label: "EC" },
  citibank:      { bg: "#003e7e", text: "#fff", label: "CT" },
};

// Full display names
export const BANK_NAMES: Record<string, string> = {
  gtbank:        "GTBank",
  access_bank:   "Access Bank",
  zenith_bank:   "Zenith Bank",
  first_bank:    "First Bank",
  uba:           "UBA",
  wema_bank:     "Wema Bank",
  moniepoint:    "Moniepoint",
  palmpay:       "PalmPay",
  opay:          "OPay",
  polaris_bank:  "Polaris Bank",
  keystone_bank: "Keystone Bank",
  stanbic_ibtc:  "Stanbic IBTC",
  sterling_bank: "Sterling Bank",
  fidelity_bank: "Fidelity Bank",
  union_bank:    "Union Bank",
  kuda_bank:     "Kuda Bank",
  carbon:        "Carbon",
  fcmb:          "FCMB",
  ecobank:       "Ecobank",
  citibank:      "Citibank",
};

export function getBankName(bankKey: string): string {
  return BANK_NAMES[bankKey] ?? bankKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function BankLogo({ bankKey, size = 32, className }: BankLogoProps) {
  const logoSrc = LOGO_SRC[bankKey];
  const radius = Math.round(size * 0.22);

  if (logoSrc) {
    return (
      <div
        className={className}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: "#fff",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          overflow: "hidden",
        }}
        title={getBankName(bankKey)}
      >
        <img src={logoSrc} alt={getBankName(bankKey)} style={{ width: "78%", height: "78%", objectFit: "contain" }} />
      </div>
    );
  }

  const brand = BRAND[bankKey] ?? { bg: "#6b7280", text: "#fff", label: bankKey.slice(0, 2).toUpperCase() };
  const fontSize = Math.max(9, Math.round(size * 0.34));

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: brand.bg,
        color: brand.text,
        display: "grid",
        placeItems: "center",
        font: `800 ${fontSize}px/1 var(--font, system-ui)`,
        letterSpacing: "-0.02em",
        flexShrink: 0,
        userSelect: "none",
      }}
      title={getBankName(bankKey)}
    >
      {brand.label}
    </div>
  );
}
