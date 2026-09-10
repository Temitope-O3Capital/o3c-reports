-- 212_import_collection_repayments.sql
-- Repayments from LOAN REPAYMENT CRM.xlsx into app.collection_payments (CIF-keyed).
-- CIF resolved via canonical recovery case; assignment_id from the CIF's active
-- assignment if any. channel='crm_import', received_by=11 (Christian Ojo), status='approved',
-- reconciled=false, no GL entries (historical backfill). Reversible:
--   DELETE FROM app.collection_payments WHERE channel='crm_import';
-- Guarded per-payment by reference marker (idempotent).

INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000013' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000013', 758333333, DATE '2026-09-01', 'crm_import', 'LRCRM:W000000000000013:M1:2026-09-01:758333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000013:M1:2026-09-01:758333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000016' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000016', 40000000, DATE '2026-07-09', 'crm_import', 'LRCRM:W000000000000016:M1:2026-07-09:40000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000016:M1:2026-07-09:40000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00034189' AND status='active' ORDER BY id DESC LIMIT 1),
       '00034189', 100000000, DATE '2026-06-05', 'crm_import', 'LRCRM:00034189:M1:2026-06-05:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00034189:M1:2026-06-05:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00034189' AND status='active' ORDER BY id DESC LIMIT 1),
       '00034189', 100000000, DATE '2026-07-04', 'crm_import', 'LRCRM:00034189:M2:2026-07-04:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00034189:M2:2026-07-04:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00034189' AND status='active' ORDER BY id DESC LIMIT 1),
       '00034189', 100000000, DATE '2026-08-04', 'crm_import', 'LRCRM:00034189:M3:2026-08-04:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00034189:M3:2026-08-04:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000015' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000015', 44900000, DATE '2026-08-12', 'crm_import', 'LRCRM:W000000000000015:M1:2026-08-12:44900000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000015:M1:2026-08-12:44900000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000006' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000006', 400000000, DATE '2026-08-06', 'crm_import', 'LRCRM:W000000000000006:M1:2026-08-06:400000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000006:M1:2026-08-06:400000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000001' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000001', 125000000, DATE '2026-08-04', 'crm_import', 'LRCRM:W000000000000001:M1:2026-08-04:125000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000001:M1:2026-08-04:125000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000022' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000022', 560000000, DATE '2026-07-13', 'crm_import', 'LRCRM:W000000000000022:M1:2026-07-13:560000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000022:M1:2026-07-13:560000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000022' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000022', 560000000, DATE '2026-08-12', 'crm_import', 'LRCRM:W000000000000022:M2:2026-08-12:560000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000022:M2:2026-08-12:560000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000033' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000033', 100000000, DATE '2026-08-01', 'crm_import', 'LRCRM:W000000000000033:M1:2026-08-01:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000033:M1:2026-08-01:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000035' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000035', 124000000, DATE '2026-08-08', 'crm_import', 'LRCRM:W000000000000035:M1:2026-08-08:124000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000035:M1:2026-08-08:124000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000041' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000041', 300000000, DATE '2026-07-13', 'crm_import', 'LRCRM:W000000000000041:M1:2026-07-13:300000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000041:M1:2026-07-13:300000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000023' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000023', 1000000000, DATE '2026-06-17', 'crm_import', 'LRCRM:W000000000000023:M1:2026-06-17:1000000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000023:M1:2026-06-17:1000000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000023' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000023', 642000000, DATE '2026-08-17', 'crm_import', 'LRCRM:W000000000000023:M2:2026-08-17:642000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000023:M2:2026-08-17:642000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000031' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000031', 125000000, DATE '2026-07-31', 'crm_import', 'LRCRM:W000000000000031:M1:2026-07-31:125000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000031:M1:2026-07-31:125000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000018' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000018', 246670000, DATE '2026-05-18', 'crm_import', 'LRCRM:W000000000000018:M1:2026-05-18:246670000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000018:M1:2026-05-18:246670000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000018' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000018', 200000000, DATE '2026-06-17', 'crm_import', 'LRCRM:W000000000000018:M2:2026-06-17:200000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000018:M2:2026-06-17:200000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000018' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000018', 100000000, DATE '2026-07-27', 'crm_import', 'LRCRM:W000000000000018:M3:2026-07-27:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000018:M3:2026-07-27:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000018' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000018', 200000000, DATE '2026-09-02', 'crm_import', 'LRCRM:W000000000000018:M4:2026-09-02:200000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000018:M4:2026-09-02:200000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000017' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000017', 226666667, DATE '2026-05-14', 'crm_import', 'LRCRM:W000000000000017:M2:2026-05-14:226666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000017:M2:2026-05-14:226666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000017' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000017', 150000000, DATE '2026-06-26', 'crm_import', 'LRCRM:W000000000000017:M3:2026-06-26:150000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000017:M3:2026-06-26:150000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000017' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000017', 100000000, DATE '2026-09-02', 'crm_import', 'LRCRM:W000000000000017:M4:2026-09-02:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000017:M4:2026-09-02:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00012059' AND status='active' ORDER BY id DESC LIMIT 1),
       '00012059', 600000000, DATE '2026-06-17', 'crm_import', 'LRCRM:00012059:M2:2026-06-17:600000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00012059:M2:2026-06-17:600000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00012059' AND status='active' ORDER BY id DESC LIMIT 1),
       '00012059', 50000000, DATE '2026-07-24', 'crm_import', 'LRCRM:00012059:M3:2026-07-24:50000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00012059:M3:2026-07-24:50000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00012059' AND status='active' ORDER BY id DESC LIMIT 1),
       '00012059', 20000000, DATE '2026-08-24', 'crm_import', 'LRCRM:00012059:M4:2026-08-24:20000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00012059:M4:2026-08-24:20000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000020' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000020', 100000000, DATE '2026-08-24', 'crm_import', 'LRCRM:W000000000000020:M1:2026-08-24:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000020:M1:2026-08-24:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000007' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000007', 86666667, DATE '2026-06-22', 'crm_import', 'LRCRM:W000000000000007:M1:2026-06-22:86666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000007:M1:2026-06-22:86666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000007' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000007', 86666667, DATE '2026-07-23', 'crm_import', 'LRCRM:W000000000000007:M2:2026-07-23:86666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000007:M2:2026-07-23:86666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00000637' AND status='active' ORDER BY id DESC LIMIT 1),
       '00000637', 206666667, DATE '2026-08-23', 'crm_import', 'LRCRM:00000637:M1:2026-08-23:206666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00000637:M1:2026-08-23:206666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000019' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000019', 50000000, DATE '2026-08-04', 'crm_import', 'LRCRM:W000000000000019:M1:2026-08-04:50000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000019:M1:2026-08-04:50000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000014' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000014', 76666600, DATE '2026-07-30', 'crm_import', 'LRCRM:W000000000000014:M1:2026-07-30:76666600', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000014:M1:2026-07-30:76666600');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000014' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000014', 76666600, DATE '2026-09-01', 'crm_import', 'LRCRM:W000000000000014:M2:2026-09-01:76666600', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000014:M2:2026-09-01:76666600');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000039' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000039', 2600000, DATE '2026-05-11', 'crm_import', 'LRCRM:W000000000000039:M1:2026-05-11:2600000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000039:M1:2026-05-11:2600000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000039' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000039', 30222222, DATE '2026-05-26', 'crm_import', 'LRCRM:W000000000000039:M2:2026-05-26:30222222', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000039:M2:2026-05-26:30222222');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000039' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000039', 30222222, DATE '2026-06-30', 'crm_import', 'LRCRM:W000000000000039:M3:2026-06-30:30222222', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000039:M3:2026-06-30:30222222');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000039' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000039', 30230000, DATE '2026-07-27', 'crm_import', 'LRCRM:W000000000000039:M4:2026-07-27:30230000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000039:M4:2026-07-27:30230000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000039' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000039', 30230000, DATE '2026-08-27', 'crm_import', 'LRCRM:W000000000000039:M5:2026-08-27:30230000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000039:M5:2026-08-27:30230000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000037' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000037', 2016666667, DATE '2026-07-10', 'crm_import', 'LRCRM:W000000000000037:M1:2026-07-10:2016666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000037:M1:2026-07-10:2016666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000037' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000037', 2688888889, DATE '2026-08-12', 'crm_import', 'LRCRM:W000000000000037:M2:2026-08-12:2688888889', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000037:M2:2026-08-12:2688888889');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000009' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000009', 900000000, DATE '2026-06-21', 'crm_import', 'LRCRM:W000000000000009:M1:2026-06-21:900000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000009:M1:2026-06-21:900000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000005' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000005', 108333333, DATE '2026-05-30', 'crm_import', 'LRCRM:W000000000000005:M1:2026-05-30:108333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000005:M1:2026-05-30:108333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000005' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000005', 108333333, DATE '2026-06-30', 'crm_import', 'LRCRM:W000000000000005:M2:2026-06-30:108333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000005:M2:2026-06-30:108333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000005' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000005', 108333333, DATE '2026-08-10', 'crm_import', 'LRCRM:W000000000000005:M3:2026-08-10:108333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000005:M3:2026-08-10:108333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000025' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000025', 50000000, DATE '2026-06-05', 'crm_import', 'LRCRM:W000000000000025:M4:2026-06-05:50000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000025:M4:2026-06-05:50000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000030' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000030', 10000000, DATE '2026-05-08', 'crm_import', 'LRCRM:W000000000000030:M1:2026-05-08:10000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000030:M1:2026-05-08:10000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000030' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000030', 50000000, DATE '2026-05-29', 'crm_import', 'LRCRM:W000000000000030:M2:2026-05-29:50000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000030:M2:2026-05-29:50000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000030' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000030', 50000000, DATE '2026-06-30', 'crm_import', 'LRCRM:W000000000000030:M3:2026-06-30:50000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000030:M3:2026-06-30:50000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000030' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000030', 50000000, DATE '2026-07-28', 'crm_import', 'LRCRM:W000000000000030:M4:2026-07-28:50000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000030:M4:2026-07-28:50000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000030' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000030', 65000000, DATE '2026-08-30', 'crm_import', 'LRCRM:W000000000000030:M5:2026-08-30:65000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000030:M5:2026-08-30:65000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000008' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000008', 24100000, DATE '2026-04-30', 'crm_import', 'LRCRM:W000000000000008:M1:2026-04-30:24100000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000008:M1:2026-04-30:24100000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000008' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000008', 24100000, DATE '2026-05-30', 'crm_import', 'LRCRM:W000000000000008:M2:2026-05-30:24100000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000008:M2:2026-05-30:24100000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000008' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000008', 24100000, DATE '2026-06-29', 'crm_import', 'LRCRM:W000000000000008:M3:2026-06-29:24100000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000008:M3:2026-06-29:24100000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000008' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000008', 24100000, DATE '2026-07-29', 'crm_import', 'LRCRM:W000000000000008:M4:2026-07-29:24100000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000008:M4:2026-07-29:24100000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000008' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000008', 24100000, DATE '2026-08-29', 'crm_import', 'LRCRM:W000000000000008:M5:2026-08-29:24100000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000008:M5:2026-08-29:24100000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00000654' AND status='active' ORDER BY id DESC LIMIT 1),
       '00000654', 1343333300, DATE '2026-09-01', 'crm_import', 'LRCRM:00000654:M1:2026-09-01:1343333300', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00000654:M1:2026-09-01:1343333300');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000038' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000038', 550000000, DATE '2026-05-20', 'crm_import', 'LRCRM:W000000000000038:M2:2026-05-20:550000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000038:M2:2026-05-20:550000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000044' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000044', 1050000000, DATE '2026-06-01', 'crm_import', 'LRCRM:W000000000000044:M1:2026-06-01:1050000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000044:M1:2026-06-01:1050000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000002' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000002', 525000000, DATE '2026-06-05', 'crm_import', 'LRCRM:W000000000000002:M1:2026-06-05:525000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000002:M1:2026-06-05:525000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000022' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000022', 6420000000, DATE '2026-06-08', 'crm_import', 'LRCRM:W000000000000022:M1:2026-06-08:6420000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000022:M1:2026-06-08:6420000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000019' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000019', 201666767, DATE '2026-06-02', 'crm_import', 'LRCRM:W000000000000019:M1:2026-06-02:201666767', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000019:M1:2026-06-02:201666767');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000019' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000019', 348350000, DATE '2026-06-20', 'crm_import', 'LRCRM:W000000000000019:M2:2026-06-20:348350000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000019:M2:2026-06-20:348350000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000021' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000021', 76666667, DATE '2026-05-13', 'crm_import', 'LRCRM:W000000000000021:M1:2026-05-13:76666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000021:M1:2026-05-13:76666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000021' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000021', 100000000, DATE '2026-06-21', 'crm_import', 'LRCRM:W000000000000021:M2:2026-06-21:100000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000021:M2:2026-06-21:100000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000021' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000021', 53333300, DATE '2026-07-20', 'crm_import', 'LRCRM:W000000000000021:M3:2026-07-20:53333300', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000021:M3:2026-07-20:53333300');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000036' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000036', 38333333, DATE '2026-06-18', 'crm_import', 'LRCRM:W000000000000036:M1:2026-06-18:38333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000036:M1:2026-06-18:38333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000036' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000036', 38333333, DATE '2026-07-14', 'crm_import', 'LRCRM:W000000000000036:M2:2026-07-14:38333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000036:M2:2026-07-14:38333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000036' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000036', 38333333, DATE '2026-07-22', 'crm_import', 'LRCRM:W000000000000036:M3:2026-07-22:38333333', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000036:M3:2026-07-22:38333333');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000023' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000023', 10000000000, DATE '2026-05-29', 'crm_import', 'LRCRM:W000000000000023:M1:2026-05-29:10000000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000023:M1:2026-05-29:10000000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000023' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000023', 1000000000, DATE '2026-06-16', 'crm_import', 'LRCRM:W000000000000023:M2:2026-06-16:1000000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000023:M2:2026-06-16:1000000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000012' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000012', 191666700, DATE '2026-05-30', 'crm_import', 'LRCRM:W000000000000012:M1:2026-05-30:191666700', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000012:M1:2026-05-30:191666700');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000012' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000012', 191666667, DATE '2026-06-30', 'crm_import', 'LRCRM:W000000000000012:M2:2026-06-30:191666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000012:M2:2026-06-30:191666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000012' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000012', 191666700, DATE '2026-07-30', 'crm_import', 'LRCRM:W000000000000012:M3:2026-07-30:191666700', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000012:M3:2026-07-30:191666700');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000042' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000042', 8000000, DATE '2026-03-30', 'crm_import', 'LRCRM:W000000000000042:M1:2026-03-30:8000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000042:M1:2026-03-30:8000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000042' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000042', 12000000, DATE '2026-04-30', 'crm_import', 'LRCRM:W000000000000042:M2:2026-04-30:12000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000042:M2:2026-04-30:12000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000042' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000042', 12000000, DATE '2026-06-01', 'crm_import', 'LRCRM:W000000000000042:M3:2026-06-01:12000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000042:M3:2026-06-01:12000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000042' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000042', 162000000, DATE '2026-07-11', 'crm_import', 'LRCRM:W000000000000042:M4:2026-07-11:162000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000042:M4:2026-07-11:162000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000042' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000042', 162000000, DATE '2026-08-08', 'crm_import', 'LRCRM:W000000000000042:M5:2026-08-08:162000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000042:M5:2026-08-08:162000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000043' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000043', 191666600, DATE '2026-07-31', 'crm_import', 'LRCRM:W000000000000043:M1:2026-07-31:191666600', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000043:M1:2026-07-31:191666600');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000043' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000043', 358340000, DATE '2026-08-13', 'crm_import', 'LRCRM:W000000000000043:M2:2026-08-13:358340000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000043:M2:2026-08-13:358340000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000011' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000011', 76666667, DATE '2026-06-11', 'crm_import', 'LRCRM:W000000000000011:M1:2026-06-11:76666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000011:M1:2026-06-11:76666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000011' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000011', 76666666, DATE '2026-07-08', 'crm_import', 'LRCRM:W000000000000011:M2:2026-07-08:76666666', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000011:M2:2026-07-08:76666666');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000011' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000011', 76666667, DATE '2026-08-12', 'crm_import', 'LRCRM:W000000000000011:M3:2026-08-12:76666667', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000011:M3:2026-08-12:76666667');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='00000632' AND status='active' ORDER BY id DESC LIMIT 1),
       '00000632', 1872000000, DATE '2026-07-29', 'crm_import', 'LRCRM:00000632:M1:2026-07-29:1872000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:00000632:M1:2026-07-29:1872000000');
INSERT INTO app.collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by, status, reconciled)
SELECT (SELECT id FROM app.collection_assignments WHERE account_cif='W000000000000010' AND status='active' ORDER BY id DESC LIMIT 1),
       'W000000000000010', 42000000000, DATE '2026-08-12', 'crm_import', 'LRCRM:W000000000000010:M1:2026-08-12:42000000000', 11, 'approved', false
WHERE NOT EXISTS (SELECT 1 FROM app.collection_payments p WHERE p.channel='crm_import' AND p.reference='LRCRM:W000000000000010:M1:2026-08-12:42000000000');
