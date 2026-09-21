-- Canonical merchant names.
--
-- THE FIELD IS NOT A MERCHANT FIELD
--
-- app.transactions.merchant_name is txn_file field 11, the feed's free-text
-- "narrative". What it holds depends on the transaction type. Measured across all
-- 1,033,223 ledger rows (card_txn_codes.category):
--
--   cash_advance  195,101 rows  the ATM's location     "ATM2_29A Admiralty wa"
--   purchase      115,492       an actual merchant     "TEAMAPT LIMITED", "OPAY DIGITAL SERVICES"
--   transfer       64,694       a narrative            "TRANSFERBANK", "03", "03Credit"
--   non_financial  46,211       the ATM's location     (balance enquiries)
--   utility        38,408       the biller
--   payment        19,187       the STAFF member who posted it   "knaibi", "taye", "tfalana"
--
-- Every "top merchants" chart in the app grouped all of it, so a bank-transfer
-- narrative, a code and four staff usernames ranked as O3's biggest vendors.
-- Callers must restrict to category='purchase' (growth.go and customer360.go now
-- do). This migration cleans the names within that population.
--
-- THE FIELD IS TRUNCATED AT ~21 CHARACTERS
--
-- 68,630 of 115,492 purchase rows are exactly 20 or 21 characters long. So one
-- merchant appears under several spellings — PAYCOM NIGERIA LIMITE (2,403),
-- PAYCOM NIGERIA LIMIT (586), PAYCOM NIGERIA LTD (21) — and a ranking splits it.
--
-- TWO TIERS, VALIDATED AGAINST THE LEDGER BEFORE BEING WRITTEN
--
--   Tier 1  app.clean_merchant_basic   row-local, deterministic. Upper-case, & -> AND,
--           collapse whitespace, strip trailing punctuation, and normalise truncated
--           company suffixes (LIMITE/LIMIT/LIM/LI -> LTD) — but ONLY at truncation
--           width, so a short name that genuinely ends in an initial is untouched.
--           27,603 -> 26,406 distinct names, no over-merging in the largest groups.
--
--   Tier 2  app.merchant_alias         a truncated spelling that is a strict prefix of
--           a more frequent spelling maps to it (MEGA CHICKEN RESTAUR -> RESTAURA,
--           TOTAL SERVICE STATIO -> STATION). 597 further merges. These are generated
--           by app.refresh_merchant_aliases() with reviewed=false so a person can veto
--           any of them; manual rows are never overwritten by a refresh.
--
-- Deliberately NOT done: fuzzy matching. At 26,000 names it would silently fuse
-- distinct businesses, and nobody would ever notice.

-- ── Tier 1 ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.clean_merchant_basic(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH s AS (
    SELECT regexp_replace(
             regexp_replace(
               replace(upper(btrim(coalesce(p, ''))), '&', ' AND '),
             '\s+', ' ', 'g'),
           '[\s.,-]+$', '') AS v,
           length(btrim(coalesce(p, ''))) AS raw_len
  ), t AS (
    SELECT CASE
             -- At truncation width, any prefix of LIMITED is a truncated LIMITED.
             WHEN raw_len >= 19
               THEN regexp_replace(v, '\s(L|LI|LIM|LIMI|LIMIT|LIMITE|LIMITED|LT|LTD)$', ' LTD')
             -- Below it, only the full words — so "JOHN L" stays "JOHN L".
             ELSE regexp_replace(v, '\s(LIMITED|LTD)$', ' LTD')
           END AS v
      FROM s
  )
  SELECT CASE
           -- No letters at all: a reference number or filler ("0      0"), not a name.
           WHEN v !~ '[A-Z]' THEN NULL
           ELSE btrim(regexp_replace(v, '\s(PL|PLC)$', ' PLC'))
         END
    FROM t
$$;

COMMENT ON FUNCTION app.clean_merchant_basic(text) IS
  'Tier-1 merchant name cleanup: deterministic and row-local. Returns NULL for strings with no letters (references, filler). Normalises truncated company suffixes only at the ~21-char truncation width. See migration 244.';

-- ── Tier 2 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.merchant_alias (
    clean_name  text PRIMARY KEY,           -- output of app.clean_merchant_basic
    canonical   text NOT NULL,
    source      text NOT NULL DEFAULT 'manual',   -- manual | auto_prefix
    reviewed    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT merchant_alias_not_self CHECK (clean_name <> canonical)
);

COMMENT ON TABLE app.merchant_alias IS
  'Maps a cleaned merchant spelling to its canonical form. auto_prefix rows come from app.refresh_merchant_aliases() (a truncated spelling that is a strict prefix of a more frequent one) and apply immediately; reviewed=false marks them for a person to confirm or delete. manual rows are never overwritten.';

-- The lookup every canonical-name query goes through. STABLE (reads a table).
-- Follows at most two hops, so A -> B -> C resolves to C without a recursive query.
CREATE OR REPLACE FUNCTION app.clean_merchant(p text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
           (SELECT COALESCE(a2.canonical, a1.canonical)
              FROM app.merchant_alias a1
              LEFT JOIN app.merchant_alias a2 ON a2.clean_name = a1.canonical
             WHERE a1.clean_name = b.basic),
           b.basic)
    FROM (SELECT app.clean_merchant_basic(p) AS basic) b
$$;

COMMENT ON FUNCTION app.clean_merchant(text) IS
  'Canonical merchant name: tier-1 cleanup, then any merchant_alias mapping. Only meaningful on PURCHASE rows — on other transaction types merchant_name is a narrative, a staff username or an ATM location. See migration 244.';

-- Regenerates tier-2 aliases. NOT called from this migration: it scans the full
-- ledger, and migrations run at backend boot. handlers/merchant_alias.go runs it
-- daily. Returns the number of aliases added.
CREATE OR REPLACE FUNCTION app.refresh_merchant_aliases()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  added integer;
BEGIN
  WITH m AS (
    SELECT app.clean_merchant_basic(t.merchant_name) AS s, count(*) AS n
      FROM app.transactions t
      JOIN app.card_txn_codes c ON c.code = t.txn_code AND c.category = 'purchase'
     WHERE NULLIF(btrim(t.merchant_name), '') IS NOT NULL
     GROUP BY 1
  ),
  cands AS (
    SELECT DISTINCT ON (a.s) a.s AS short_name, b.s AS long_name
      FROM m a
      -- Bucket on the first 8 characters so this is not a 26k x 26k comparison.
      JOIN m b ON left(b.s, 8) = left(a.s, 8)
              AND b.s <> a.s
              -- An exact prefix test. Not LIKE: a merchant name containing % or _
              -- would turn into a wildcard.
              AND left(b.s, length(a.s)) = a.s
              AND b.n > a.n
     WHERE a.s IS NOT NULL
       AND length(a.s) >= 19          -- only spellings at the truncation width
     ORDER BY a.s, b.n DESC
  )
  INSERT INTO app.merchant_alias (clean_name, canonical, source, reviewed)
  SELECT short_name, long_name, 'auto_prefix', false FROM cands
  ON CONFLICT (clean_name) DO NOTHING;

  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

COMMENT ON FUNCTION app.refresh_merchant_aliases() IS
  'Adds auto_prefix aliases for truncated merchant spellings. Idempotent; never overwrites an existing alias (so a manual correction or a deletion-and-replacement survives). Run daily by the merchant_alias worker, not at migration time.';
