-- 210_import_recovery_repayments.sql
-- Repayments unpivoted from LOAN REPAYMENT CRM.xlsx into app.recovery_payments,
-- each keyed to a specific recovery case_id resolved offline (dup loan_refs
-- disambiguated by name; ambiguous + date-less rows excluded). amount in kobo,
-- channel 'crm_import', status 'approved', posted_by=11. Per-payment
-- reference marker makes re-running a no-op. Reversible: DELETE WHERE channel='crm_import'.

INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2134, 758333333, DATE '2026-09-01', 'crm_import', 'LRCRM:c2134:M1:2026-09-01:758333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2134)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2134:M1:2026-09-01:758333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2135, 40000000, DATE '2026-07-09', 'crm_import', 'LRCRM:c2135:M1:2026-07-09:40000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2135)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2135:M1:2026-07-09:40000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2136, 100000000, DATE '2026-06-05', 'crm_import', 'LRCRM:c2136:M1:2026-06-05:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2136)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2136:M1:2026-06-05:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2136, 100000000, DATE '2026-07-04', 'crm_import', 'LRCRM:c2136:M2:2026-07-04:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2136)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2136:M2:2026-07-04:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2136, 100000000, DATE '2026-08-04', 'crm_import', 'LRCRM:c2136:M3:2026-08-04:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2136)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2136:M3:2026-08-04:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2137, 44900000, DATE '2026-08-12', 'crm_import', 'LRCRM:c2137:M1:2026-08-12:44900000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2137)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2137:M1:2026-08-12:44900000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2138, 400000000, DATE '2026-08-06', 'crm_import', 'LRCRM:c2138:M1:2026-08-06:400000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2138)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2138:M1:2026-08-06:400000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2139, 125000000, DATE '2026-08-04', 'crm_import', 'LRCRM:c2139:M1:2026-08-04:125000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2139)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2139:M1:2026-08-04:125000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2140, 560000000, DATE '2026-07-13', 'crm_import', 'LRCRM:c2140:M1:2026-07-13:560000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2140)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2140:M1:2026-07-13:560000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2140, 560000000, DATE '2026-08-12', 'crm_import', 'LRCRM:c2140:M2:2026-08-12:560000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2140)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2140:M2:2026-08-12:560000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2141, 100000000, DATE '2026-08-01', 'crm_import', 'LRCRM:c2141:M1:2026-08-01:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2141)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2141:M1:2026-08-01:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2143, 124000000, DATE '2026-08-08', 'crm_import', 'LRCRM:c2143:M1:2026-08-08:124000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2143)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2143:M1:2026-08-08:124000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2144, 300000000, DATE '2026-07-13', 'crm_import', 'LRCRM:c2144:M1:2026-07-13:300000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2144)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2144:M1:2026-07-13:300000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2145, 1000000000, DATE '2026-06-17', 'crm_import', 'LRCRM:c2145:M1:2026-06-17:1000000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2145)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2145:M1:2026-06-17:1000000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2145, 642000000, DATE '2026-08-17', 'crm_import', 'LRCRM:c2145:M2:2026-08-17:642000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2145)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2145:M2:2026-08-17:642000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2146, 125000000, DATE '2026-07-31', 'crm_import', 'LRCRM:c2146:M1:2026-07-31:125000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2146)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2146:M1:2026-07-31:125000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2147, 246670000, DATE '2026-05-18', 'crm_import', 'LRCRM:c2147:M1:2026-05-18:246670000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2147)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2147:M1:2026-05-18:246670000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2147, 200000000, DATE '2026-06-17', 'crm_import', 'LRCRM:c2147:M2:2026-06-17:200000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2147)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2147:M2:2026-06-17:200000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2147, 100000000, DATE '2026-07-27', 'crm_import', 'LRCRM:c2147:M3:2026-07-27:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2147)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2147:M3:2026-07-27:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2147, 200000000, DATE '2026-09-02', 'crm_import', 'LRCRM:c2147:M4:2026-09-02:200000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2147)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2147:M4:2026-09-02:200000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2148, 226666667, DATE '2026-05-14', 'crm_import', 'LRCRM:c2148:M2:2026-05-14:226666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2148)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2148:M2:2026-05-14:226666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2148, 150000000, DATE '2026-06-26', 'crm_import', 'LRCRM:c2148:M3:2026-06-26:150000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2148)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2148:M3:2026-06-26:150000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2148, 100000000, DATE '2026-09-02', 'crm_import', 'LRCRM:c2148:M4:2026-09-02:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2148)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2148:M4:2026-09-02:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2149, 600000000, DATE '2026-06-17', 'crm_import', 'LRCRM:c2149:M2:2026-06-17:600000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2149)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2149:M2:2026-06-17:600000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2149, 50000000, DATE '2026-07-24', 'crm_import', 'LRCRM:c2149:M3:2026-07-24:50000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2149)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2149:M3:2026-07-24:50000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2149, 20000000, DATE '2026-08-24', 'crm_import', 'LRCRM:c2149:M4:2026-08-24:20000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2149)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2149:M4:2026-08-24:20000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2150, 100000000, DATE '2026-08-24', 'crm_import', 'LRCRM:c2150:M1:2026-08-24:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2150)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2150:M1:2026-08-24:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2151, 86666667, DATE '2026-06-22', 'crm_import', 'LRCRM:c2151:M1:2026-06-22:86666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2151)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2151:M1:2026-06-22:86666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2151, 86666667, DATE '2026-07-23', 'crm_import', 'LRCRM:c2151:M2:2026-07-23:86666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2151)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2151:M2:2026-07-23:86666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2152, 206666667, DATE '2026-08-23', 'crm_import', 'LRCRM:c2152:M1:2026-08-23:206666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2152)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2152:M1:2026-08-23:206666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2153, 50000000, DATE '2026-08-04', 'crm_import', 'LRCRM:c2153:M1:2026-08-04:50000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2153)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2153:M1:2026-08-04:50000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2154, 76666600, DATE '2026-07-30', 'crm_import', 'LRCRM:c2154:M1:2026-07-30:76666600', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2154)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2154:M1:2026-07-30:76666600');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2154, 76666600, DATE '2026-09-01', 'crm_import', 'LRCRM:c2154:M2:2026-09-01:76666600', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2154)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2154:M2:2026-09-01:76666600');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2155, 2600000, DATE '2026-05-11', 'crm_import', 'LRCRM:c2155:M1:2026-05-11:2600000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2155)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2155:M1:2026-05-11:2600000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2155, 30222222, DATE '2026-05-26', 'crm_import', 'LRCRM:c2155:M2:2026-05-26:30222222', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2155)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2155:M2:2026-05-26:30222222');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2155, 30222222, DATE '2026-06-30', 'crm_import', 'LRCRM:c2155:M3:2026-06-30:30222222', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2155)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2155:M3:2026-06-30:30222222');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2155, 30230000, DATE '2026-07-27', 'crm_import', 'LRCRM:c2155:M4:2026-07-27:30230000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2155)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2155:M4:2026-07-27:30230000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2155, 30230000, DATE '2026-08-27', 'crm_import', 'LRCRM:c2155:M5:2026-08-27:30230000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2155)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2155:M5:2026-08-27:30230000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2156, 2016666667, DATE '2026-07-10', 'crm_import', 'LRCRM:c2156:M1:2026-07-10:2016666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2156)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2156:M1:2026-07-10:2016666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2156, 2688888889, DATE '2026-08-12', 'crm_import', 'LRCRM:c2156:M2:2026-08-12:2688888889', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2156)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2156:M2:2026-08-12:2688888889');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2157, 900000000, DATE '2026-06-21', 'crm_import', 'LRCRM:c2157:M1:2026-06-21:900000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2157)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2157:M1:2026-06-21:900000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2159, 108333333, DATE '2026-05-30', 'crm_import', 'LRCRM:c2159:M1:2026-05-30:108333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2159)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2159:M1:2026-05-30:108333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2159, 108333333, DATE '2026-06-30', 'crm_import', 'LRCRM:c2159:M2:2026-06-30:108333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2159)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2159:M2:2026-06-30:108333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2159, 108333333, DATE '2026-08-10', 'crm_import', 'LRCRM:c2159:M3:2026-08-10:108333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2159)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2159:M3:2026-08-10:108333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2160, 50000000, DATE '2026-06-05', 'crm_import', 'LRCRM:c2160:M4:2026-06-05:50000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2160)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2160:M4:2026-06-05:50000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2161, 10000000, DATE '2026-05-08', 'crm_import', 'LRCRM:c2161:M1:2026-05-08:10000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2161)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2161:M1:2026-05-08:10000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2161, 50000000, DATE '2026-05-29', 'crm_import', 'LRCRM:c2161:M2:2026-05-29:50000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2161)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2161:M2:2026-05-29:50000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2161, 50000000, DATE '2026-06-30', 'crm_import', 'LRCRM:c2161:M3:2026-06-30:50000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2161)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2161:M3:2026-06-30:50000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2161, 50000000, DATE '2026-07-28', 'crm_import', 'LRCRM:c2161:M4:2026-07-28:50000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2161)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2161:M4:2026-07-28:50000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2161, 65000000, DATE '2026-08-30', 'crm_import', 'LRCRM:c2161:M5:2026-08-30:65000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2161)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2161:M5:2026-08-30:65000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2162, 24100000, DATE '2026-04-30', 'crm_import', 'LRCRM:c2162:M1:2026-04-30:24100000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2162)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2162:M1:2026-04-30:24100000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2162, 24100000, DATE '2026-05-30', 'crm_import', 'LRCRM:c2162:M2:2026-05-30:24100000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2162)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2162:M2:2026-05-30:24100000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2162, 24100000, DATE '2026-06-29', 'crm_import', 'LRCRM:c2162:M3:2026-06-29:24100000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2162)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2162:M3:2026-06-29:24100000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2162, 24100000, DATE '2026-07-29', 'crm_import', 'LRCRM:c2162:M4:2026-07-29:24100000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2162)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2162:M4:2026-07-29:24100000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2162, 24100000, DATE '2026-08-29', 'crm_import', 'LRCRM:c2162:M5:2026-08-29:24100000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2162)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2162:M5:2026-08-29:24100000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2163, 1343333300, DATE '2026-09-01', 'crm_import', 'LRCRM:c2163:M1:2026-09-01:1343333300', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2163)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2163:M1:2026-09-01:1343333300');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2165, 550000000, DATE '2026-05-20', 'crm_import', 'LRCRM:c2165:M2:2026-05-20:550000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2165)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2165:M2:2026-05-20:550000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2166, 1050000000, DATE '2026-06-01', 'crm_import', 'LRCRM:c2166:M1:2026-06-01:1050000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2166)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2166:M1:2026-06-01:1050000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2167, 525000000, DATE '2026-06-05', 'crm_import', 'LRCRM:c2167:M1:2026-06-05:525000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2167)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2167:M1:2026-06-05:525000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2140, 6420000000, DATE '2026-06-08', 'crm_import', 'LRCRM:c2140:M1:2026-06-08:6420000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2140)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2140:M1:2026-06-08:6420000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2153, 201666767, DATE '2026-06-02', 'crm_import', 'LRCRM:c2153:M1:2026-06-02:201666767', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2153)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2153:M1:2026-06-02:201666767');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2153, 348350000, DATE '2026-06-20', 'crm_import', 'LRCRM:c2153:M2:2026-06-20:348350000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2153)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2153:M2:2026-06-20:348350000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2170, 37500000, DATE '2026-03-29', 'crm_import', 'LRCRM:c2170:M1:2026-03-29:37500000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2170)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2170:M1:2026-03-29:37500000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2170, 77500000, DATE '2026-04-29', 'crm_import', 'LRCRM:c2170:M2:2026-04-29:77500000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2170)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2170:M2:2026-04-29:77500000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2170, 57500000, DATE '2026-05-09', 'crm_import', 'LRCRM:c2170:M3:2026-05-09:57500000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2170)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2170:M3:2026-05-09:57500000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2171, 76666667, DATE '2026-05-13', 'crm_import', 'LRCRM:c2171:M1:2026-05-13:76666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2171)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2171:M1:2026-05-13:76666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2171, 100000000, DATE '2026-06-21', 'crm_import', 'LRCRM:c2171:M2:2026-06-21:100000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2171)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2171:M2:2026-06-21:100000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2171, 53333300, DATE '2026-07-20', 'crm_import', 'LRCRM:c2171:M3:2026-07-20:53333300', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2171)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2171:M3:2026-07-20:53333300');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2172, 38333333, DATE '2026-06-18', 'crm_import', 'LRCRM:c2172:M1:2026-06-18:38333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2172)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2172:M1:2026-06-18:38333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2172, 38333333, DATE '2026-07-14', 'crm_import', 'LRCRM:c2172:M2:2026-07-14:38333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2172)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2172:M2:2026-07-14:38333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2172, 38333333, DATE '2026-07-22', 'crm_import', 'LRCRM:c2172:M3:2026-07-22:38333333', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2172)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2172:M3:2026-07-22:38333333');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2145, 10000000000, DATE '2026-05-29', 'crm_import', 'LRCRM:c2145:M1:2026-05-29:10000000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2145)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2145:M1:2026-05-29:10000000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2145, 1000000000, DATE '2026-06-16', 'crm_import', 'LRCRM:c2145:M2:2026-06-16:1000000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2145)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2145:M2:2026-06-16:1000000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2174, 191666700, DATE '2026-05-30', 'crm_import', 'LRCRM:c2174:M1:2026-05-30:191666700', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2174)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2174:M1:2026-05-30:191666700');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2174, 191666667, DATE '2026-06-30', 'crm_import', 'LRCRM:c2174:M2:2026-06-30:191666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2174)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2174:M2:2026-06-30:191666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2174, 191666700, DATE '2026-07-30', 'crm_import', 'LRCRM:c2174:M3:2026-07-30:191666700', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2174)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2174:M3:2026-07-30:191666700');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2175, 8000000, DATE '2026-03-30', 'crm_import', 'LRCRM:c2175:M1:2026-03-30:8000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2175)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2175:M1:2026-03-30:8000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2175, 12000000, DATE '2026-04-30', 'crm_import', 'LRCRM:c2175:M2:2026-04-30:12000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2175)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2175:M2:2026-04-30:12000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2175, 12000000, DATE '2026-06-01', 'crm_import', 'LRCRM:c2175:M3:2026-06-01:12000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2175)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2175:M3:2026-06-01:12000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2175, 162000000, DATE '2026-07-11', 'crm_import', 'LRCRM:c2175:M4:2026-07-11:162000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2175)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2175:M4:2026-07-11:162000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2175, 162000000, DATE '2026-08-08', 'crm_import', 'LRCRM:c2175:M5:2026-08-08:162000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2175)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2175:M5:2026-08-08:162000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2176, 191666600, DATE '2026-07-31', 'crm_import', 'LRCRM:c2176:M1:2026-07-31:191666600', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2176)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2176:M1:2026-07-31:191666600');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2176, 358340000, DATE '2026-08-13', 'crm_import', 'LRCRM:c2176:M2:2026-08-13:358340000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2176)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2176:M2:2026-08-13:358340000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2177, 76666667, DATE '2026-06-11', 'crm_import', 'LRCRM:c2177:M1:2026-06-11:76666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2177)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2177:M1:2026-06-11:76666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2177, 76666666, DATE '2026-07-08', 'crm_import', 'LRCRM:c2177:M2:2026-07-08:76666666', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2177)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2177:M2:2026-07-08:76666666');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2177, 76666667, DATE '2026-08-12', 'crm_import', 'LRCRM:c2177:M3:2026-08-12:76666667', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2177)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2177:M3:2026-08-12:76666667');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2178, 1872000000, DATE '2026-07-29', 'crm_import', 'LRCRM:c2178:M1:2026-07-29:1872000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2178)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2178:M1:2026-07-29:1872000000');
INSERT INTO app.recovery_payments (case_id, amount_kobo, payment_date, channel, reference, notes, posted_by, status)
SELECT 2179, 42000000000, DATE '2026-08-12', 'crm_import', 'LRCRM:c2179:M1:2026-08-12:42000000000', 'Imported from LOAN REPAYMENT CRM.xlsx', 11, 'approved'
WHERE EXISTS (SELECT 1 FROM app.recovery_cases rc WHERE rc.id=2179)
  AND NOT EXISTS (SELECT 1 FROM app.recovery_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:c2179:M1:2026-08-12:42000000000');
