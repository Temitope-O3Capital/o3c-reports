# Two conversions with no customer behind them

**Traced 2026-10-06.** Both were logged as *Converted* on the CRC July Campaign
(Lagos Individuals) 2 and 3. Neither is a customer in any system O3C holds.

| | Lead | Phone | Converted | Logged by |
|---|---|---|---|---|
| **Chukwuka Orodu** | 5060 | 0803 641 4357 | 10 Sep 2026, 14:20 | Joy Adejoh |
| **Oluwatomisin Oluwafemi Owolabi** | 6297 | 0814 034 1105 | 11 Sep 2026, 15:54 | Elizabeth Nwamiro |

---

## What each agent should be asked

**Did this customer actually take a card, and under what name or number?**

If yes, we need the CIF or the number the card was opened with — the conversion is
real and simply cannot be matched. If no, the lead should go back to a working
status so the floor stops counting a sale that did not happen.

Neither question can be answered from the data, which is why it is coming to them
rather than being corrected automatically.

---

## Why we cannot find them

Searched every customer source, by exact phone, by partial phone (last 7 digits),
and by name fragments:

| Source | Rows | Result |
|---|---|---|
| `app.customers` — the card book | 22,227 | **Nothing.** Only unrelated people: a TITILOPE OWOLABI, and 60+ holders of "Oluwafemi" as a middle name |
| `app.parties` — canonical person registry | — | Only their own synthetic prospect records, holding **0 cards** |
| `app.customer_acquisition` | 20,698 | Matches are all 2019–2021 baseline customers, different people |
| `app.cbs_customers` | 300 | Nothing |
| `app.loan_applications` | — | Nothing |

### The absence is real, not a thin book

This is the part that makes it answerable. The card book is current to today, and
**605 new CIFs landed on 14–15 September** — immediately after both conversions.
Those rows are well filled in: **605 of 605 carry a name, 602 carry a usable
phone.** If either person had been carded, there would be a row to find.

For contrast, the six conversions that *are* real matched on the first attempt,
and every one of their CIFs already existed on the day of the call:

| Customer | CIF | Converted | CIF created |
|---|---|---|---|
| Albert Umerah | 00041214 | 3 Sep | 3 Sep |
| Banji Oyewole Ojo | 00041228 | 10 Sep | 7 Sep |
| Solomon Robert Ozakpo | 00041226 | 11 Sep | 7 Sep |
| Ayodeji Abiodun Amos | 00041969 | 17 Sep | 17 Sep |
| Ismail Adewumi Okunade | 00042037 | 24 Sep | 24 Sep |
| Damilare Wasiu Oshin | 00042036 | 28 Sep | 24 Sep |

Note Banji Ojo and Solomon Ozakpo converted on 10 and 11 September — the same two
days as Orodu and Owolabi — and both resolve cleanly. So the matching was working
on exactly those dates.

---

## What has changed in the system

- **A conversion now records which customer it became.** `customer_cif` had existed
  all along and was blank on all 20,587 leads — never filled once. Six real
  conversions with cards issued were invisible as revenue; three claimed ones with
  nothing behind them looked identical. All six are now filled.
- **Matching requires exactly one match on a 10-digit number.** The card book holds
  8,739 customers on a shared phone — 4,113 of them on `08012345678` alone — so a
  first-match-wins lookup would have attached a conversion, and a person's
  identity, to whichever of four thousand people sorted first.
- **It retries hourly.** The card book arrives in batches: no CIFs at all between 8
  and 13 September, then 605 over two days. A conversion logged inside a gap would
  otherwise stay unverified for ever. It now clears itself the moment the card is
  issued.
- **Unverified conversions are visible on the Leads page** — an amber count that
  filters straight to them. Not an alert: it is a backlog for the agent who logged
  it, and backlogs belong on a page.

Nothing was altered for these two. They stay flagged until someone who was on the
call says what happened.
