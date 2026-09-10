-- 216: fold the Udara-officer placeholder accounts into proper staff records.
--
-- These synthetic '@officer.o3c.local' accounts were confusing to see in the staff list.
-- Give the genuinely-distinct officers the standard staff email convention
-- (first-initial + lastname @o3cards.com), and merge the one that is actually an existing
-- employee.
--
-- Okoro: the stub "Ikechuckwu Okoro" is the SAME PERSON as existing staff id 41
-- "Ikechukwu Okoro" (sales_officer, iokoro@o3cards.com) — one-letter spelling difference,
-- confirmed by Temitope. Repoint his Udara attribution to the real account, then drop the
-- duplicate stub.
UPDATE app.cbs_officer_map SET officer_user_id = 41 WHERE udara_name = 'Okoro Ikechuckwu';
-- Reassign his card-customer officer assignments to the real account too (id 47's only
-- other references). Guard against creating a duplicate (cif already assigned to 41).
DELETE FROM app.customer_officers c47
 WHERE c47.officer_id = 47
   AND EXISTS (SELECT 1 FROM app.customer_officers c41 WHERE c41.officer_id = 41 AND c41.cif = c47.cif);
UPDATE app.customer_officers SET officer_id = 41 WHERE officer_id = 47;
DELETE FROM o3c_users WHERE email = 'cbs.ikechuckwu.okoro@officer.o3c.local';

-- The remaining five are distinct people. Convention is first-initial+lastname@o3cards.com;
-- Isah uses 'maisah' (per Temitope) because 'misah' belongs to Mariam Isah. Make them all
-- uniform active Sales staff (Erinfolami was an inactive account_officer stub).
UPDATE o3c_users SET email='aerinfolami@o3cards.com', role='sales_officer', department='Sales', is_active=true
 WHERE email='cbs.ayodeji.erinfolami@officer.o3c.local';
UPDATE o3c_users SET email='maisah@o3cards.com'   WHERE email='cbs.maminetu.isah@officer.o3c.local';
UPDATE o3c_users SET email='pobioha@o3cards.com'  WHERE email='cbs.precious.obioha@officer.o3c.local';
UPDATE o3c_users SET email='oodometa@o3cards.com' WHERE email='cbs.oghenefejiro.odometa@officer.o3c.local';
UPDATE o3c_users SET email='doluwole@o3cards.com' WHERE email='cbs.dorcas.oluwole@officer.o3c.local';
