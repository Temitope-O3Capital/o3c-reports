// ISO-18245 merchant category codes → friendly names, weighted to the codes that
// actually appear in O3's ledger (6011 = ATM cash dominates). Unknown codes fall back to
// "MCC ####". Shared by Customer 360 and the portfolio behaviour analytics.
export const MCC_NAMES: Record<string, string> = {
  '6011': 'ATM cash', '6010': 'Cash — manual', '6012': 'Financial institution', '6013': 'Financial — other', '6014': 'Cash disbursement',
  '6051': 'Quasi-cash / crypto', '4829': 'Money transfer',
  '5541': 'Fuel', '5542': 'Fuel — automated', '5411': 'Groceries', '5300': 'Wholesale', '5310': 'Discount stores',
  '5399': 'General merchandise', '5999': 'Retail — misc', '5311': 'Department stores', '5651': 'Clothing', '5691': 'Apparel',
  '5812': 'Restaurants', '5814': 'Fast food', '5811': 'Caterers', '7011': 'Hotels', '7399': 'Business services',
  '4814': 'Telecoms / airtime', '4900': 'Utilities', '5912': 'Pharmacy', '8011': 'Doctors', '8062': 'Hospitals',
  '4111': 'Transport', '4121': 'Taxi / rideshare', '7995': 'Betting', '7994': 'Gaming', '5964': 'Direct marketing',
  '1111': 'Uncategorised',
}
export const mccName = (m: string) => MCC_NAMES[m] ?? `MCC ${m}`
