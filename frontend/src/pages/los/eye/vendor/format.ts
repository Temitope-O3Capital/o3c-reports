export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/** Time elapsed since an ISO timestamp, as "4d 6h" — used to flag mandates
 * that have been waiting too long for a customer to complete activation. */
export function elapsedSince(iso: string): { label: string; hours: number } {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.max(0, Math.floor(ms / (1000 * 60 * 60)));
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return { label: days > 0 ? `${days}d ${remHours}h` : `${remHours}h`, hours };
}

/**
 * Sums minor-unit amounts grouped by their own currency.
 *
 * The pattern this replaces was `items.reduce(sum of amount_minor)` formatted
 * with `items[0].currency`. On a single-currency tenant that is correct by
 * accident; the moment a tenant holds two currencies it prints the sum of
 * unlike units under whichever symbol happened to sort first — a number that
 * is not wrong by a rounding error but is not a quantity at all.
 */
export function sumByCurrency<T>(
  items: readonly T[],
  amountOf: (item: T) => number | null | undefined,
  currencyOf: (item: T) => string | null | undefined,
  fallbackCurrency = "NGN",
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    const amount = amountOf(item);
    if (amount == null) continue;
    const currency = currencyOf(item) || fallbackCurrency;
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }
  return totals;
}

/**
 * Renders the output of `sumByCurrency` for a KPI surface.
 *
 * One currency reads exactly as before. Several are joined rather than
 * collapsed, because there is no honest single number: the alternative would
 * be either a silent lie or an FX conversion this app has no rate source for.
 * An empty map means "nothing to total", which is a real zero in the fallback
 * currency, not missing data — callers still gate on their query's isLoading
 * before rendering it.
 */
export function formatMoneyTotals(totals: Map<string, number>, fallbackCurrency = "NGN"): string {
  if (totals.size === 0) return formatMoney(0, fallbackCurrency);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([currency, minor]) => formatMoney(minor, currency))
    .join(" · ");
}
