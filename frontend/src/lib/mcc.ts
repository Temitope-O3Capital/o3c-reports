// ISO-18245 merchant category codes → friendly names.
//
// Weighted to the codes that actually appear in O3's ledger. The set below was
// extended from the 32 codes it started with after counting field 12 across a
// 120-file sample of the retained txn_file drops on E:\ — that sample alone
// carries 76 distinct codes, and the full ledger has 329 across 460,206 rows, so
// anything not listed still falls back to "MCC ####" rather than breaking.
//
// 6011 (ATM cash) dominates at 304,479 rows — over a third of every categorised
// transaction is a cash withdrawal, which is worth remembering before reading a
// "top category" chart as retail spend.
//
// Single source of truth: Customer 360, the portfolio behaviour analytics and the
// contact profile all import from here. There used to be a second, drifting copy
// inline in pages/contacts/ContactProfile.tsx.
export const MCC_NAMES: Record<string, string> = {
  // ── Cash & financial (the bulk of the book) ────────────────────────────────
  '6011': 'ATM Cash', '6010': 'Cash — Manual', '6012': 'Financial Institution',
  '6013': 'Financial — Other', '6014': 'Cash Disbursement',
  '6051': 'Quasi-Cash / Crypto', '4829': 'Money Transfer',

  // ── Fuel & transport ──────────────────────────────────────────────────────
  '5541': 'Fuel', '5542': 'Fuel — Automated', '4111': 'Transport / Commuter',
  '4112': 'Passenger Rail', '4121': 'Taxi / Rideshare', '4511': 'Airlines',
  '7512': 'Car Rental', '7991': 'Tourist Attractions',

  // ── Groceries & general retail ─────────────────────────────────────────────
  '5411': 'Groceries', '5300': 'Wholesale', '5310': 'Discount Stores',
  '5309': 'Duty-Free', '5399': 'General Merchandise', '5999': 'Retail — Misc',
  '5311': 'Department Stores', '5499': 'Food Stores — Specialty',
  '5441': 'Confectionery', '5968': 'Subscription Merchants',

  // ── Clothing & personal ───────────────────────────────────────────────────
  '5651': 'Clothing — Family', '5691': 'Apparel', '5611': "Men's Clothing",
  '5621': "Women's Ready-to-Wear", '5948': 'Leather Goods / Luggage',
  '5977': 'Cosmetics', '5941': 'Sporting Goods',

  // ── Food & drink ──────────────────────────────────────────────────────────
  '5812': 'Restaurants', '5814': 'Fast Food', '5811': 'Caterers',
  '5813': 'Bars & Nightclubs', '7011': 'Hotels', '3401': 'Hotel (Chain Code)',

  // ── Services, telecoms & utilities ────────────────────────────────────────
  '7399': 'Business Services', '7311': 'Advertising Services',
  '8999': 'Professional Services', '4814': 'Telecoms / Airtime',
  '4812': 'Telecom Equipment', '4816': 'Online / Network Services',
  '4900': 'Utilities',

  // ── Health & education ────────────────────────────────────────────────────
  '5912': 'Pharmacy', '8011': 'Doctors', '8062': 'Hospitals',
  '8299': 'Schools & Education', '5942': 'Book Stores',
  '5943': 'Stationery / Office', '5192': 'Books & Newspapers',

  // ── Digital & electronics ─────────────────────────────────────────────────
  '5734': 'Computer Software', '5735': 'Record / Music Stores',
  '5816': 'Digital Goods — Games', '5817': 'Digital Goods — Apps',
  '5964': 'Direct Marketing',

  // ── Gambling (flagged in credit assessment, not just a category) ───────────
  '7995': 'Betting', '7994': 'Gaming Arcades',

  // ── Placeholder the source itself emits ───────────────────────────────────
  '1111': 'Uncategorised',
}

export const mccName = (m: string) => MCC_NAMES[m] ?? `MCC ${m}`
