-- Clean up outbound-queue contacts where a phone number was stored as the
-- customer's name (legacy seeding stored COALESCE(name, phone)). customer_name is
-- NOT NULL, so blank them out; the UI falls back to "Unknown Lead" for empty names.
-- Idempotent.

UPDATE telemarketing_contacts
   SET customer_name = ''
 WHERE customer_name <> ''
   AND (
     customer_name = phone
     OR customer_name ~ '^[+0-9()\-.\s]+$'   -- name is only phone-ish characters
   );
