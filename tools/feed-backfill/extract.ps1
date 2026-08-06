$ErrorActionPreference='Stop'
$OUT = "C:\Users\TBABAT~1\AppData\Local\Temp\3\claude\C--Users-tbabatunde\ff134fbf-99c9-42a4-bec8-7b2586abe8d0\scratchpad"
function Sage($sql){
  $cs="Server=dbsvr01;Database=Production_ED;Integrated Security=True;Encrypt=False;Connection Timeout=10"
  $c=New-Object System.Data.SqlClient.SqlConnection $cs; $c.Open()
  $cmd=$c.CreateCommand(); $cmd.CommandText=$sql; $cmd.CommandTimeout=300
  $rd=$cmd.ExecuteReader(); $rows=New-Object System.Collections.ArrayList
  while($rd.Read()){ $o=[ordered]@{}; for($i=0;$i -lt $rd.FieldCount;$i++){ $o[$rd.GetName($i)] = $(if($rd.IsDBNull($i)){''}else{$rd.GetValue($i)}) }; [void]$rows.Add([pscustomobject]$o) }
  $rd.Close(); $c.Close(); return $rows
}
function Write-PgCsv($rows,$path,$cols){
  $sb=New-Object System.Text.StringBuilder
  [void]$sb.AppendLine(($cols -join ','))
  foreach($r in $rows){
    $vals=foreach($c in $cols){ $v=[string]$r.$c; if($v -match '[",\r\n]'){ '"'+($v -replace '"','""')+'"' } else { $v } }
    [void]$sb.AppendLine(($vals -join ','))
  }
  [System.IO.File]::WriteAllText($path,$sb.ToString(),(New-Object System.Text.UTF8Encoding($false)))
}

# ---- CUSTOMERS ----
$custCols='cif','first_name','middle_name','last_name','full_name','email','phone','phone_raw','address_1','address_2','address_3','city','state','country','gender','nationality','bvn','account_status','source_updated_at'
$cust = Sage @"
WITH ranked AS (
 SELECT LTRIM(RTRIM(CIF)) cif, LTRIM(RTRIM(First_Name)) first_name, LTRIM(RTRIM(Middle_Name)) middle_name,
   LTRIM(RTRIM(Last_Name)) last_name, LTRIM(RTRIM(Full_Name)) full_name, LOWER(LTRIM(RTRIM(Email))) email,
   REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(Phone)),' ',''),'+',''),'(',''),')',''),'-',''),CHAR(9),'') phone,
   LTRIM(RTRIM(Phone)) phone_raw, LTRIM(RTRIM(Address_1)) address_1, LTRIM(RTRIM(Address_2)) address_2, LTRIM(RTRIM(Address_3)) address_3,
   LTRIM(RTRIM(City)) city, LTRIM(RTRIM(State_)) state, LTRIM(RTRIM(Country)) country, LTRIM(RTRIM(Gender)) gender,
   LTRIM(RTRIM(Nationality)) nationality, LTRIM(RTRIM(BVN)) bvn, LTRIM(RTRIM(Account_Status)) account_status,
   CONVERT(varchar(19),Rn_Edit_Date,120) source_updated_at,
   ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(CIF)) ORDER BY Rn_Edit_Date DESC) rn
 FROM dbo.Contact
 WHERE CIF IS NOT NULL AND LTRIM(RTRIM(CIF))<>'' AND ISNUMERIC(LTRIM(RTRIM(CIF)))=1)
SELECT cif,first_name,middle_name,last_name,full_name,email,phone,phone_raw,address_1,address_2,address_3,city,state,country,gender,nationality,bvn,account_status,source_updated_at
FROM ranked WHERE rn=1
"@
Write-PgCsv $cust "$OUT\customers.csv" $custCols
Write-Output ("customers: {0}" -f $cust.Count)

# ---- ACCOUNTS ----
$acctCols='account_no','cif','product_name','product_line','status','card_number_masked','name_on_card','card_limit_kobo','cycle_balance_kobo','current_balance_kobo','card_issue_date','card_expiry_date','payment_due_date','source_updated_at'
$acct = Sage @"
WITH ranked AS (
 SELECT LTRIM(RTRIM(Number_)) account_no,
   CASE WHEN ISNUMERIC(LTRIM(RTRIM(CIF_Number)))=1 THEN LTRIM(RTRIM(CIF_Number)) ELSE '' END cif,
   LTRIM(RTRIM(Product_Name)) product_name,
   CASE WHEN Product_Name='PREP' THEN 'prepaid'
        WHEN Product_Name LIKE 'Amex%' THEN 'credit_card'
        WHEN Product_Name LIKE '%COOP%' OR Product_Name LIKE '%MEMCOS%' OR Product_Name LIKE '%NIMCOS%' OR Product_Name LIKE '%NOHIL%' OR Product_Name LIKE '%Deposit%' THEN 'deposit'
        WHEN Product_Name LIKE '%Classic%' OR Product_Name LIKE '%Prestige%' OR Product_Name LIKE '%Platinum%' OR Product_Name LIKE '%Charge%' OR Product_Name LIKE '%Business%' OR Product_Name LIKE 'BB %' OR Product_Name LIKE '%Financial Inclusion%' THEN 'credit_card'
        WHEN Product_Name IS NULL OR LTRIM(RTRIM(Product_Name))='' THEN 'other' ELSE 'other' END product_line,
   LTRIM(RTRIM(Status)) status, LTRIM(RTRIM(Card_Number_Masked)) card_number_masked, LTRIM(RTRIM(Name_On_Card)) name_on_card,
   CAST(ROUND(ISNULL(Card_Limit,0)*100,0) AS bigint) card_limit_kobo,
   CAST(ROUND(ISNULL(Cycle_Balance,0)*100,0) AS bigint) cycle_balance_kobo,
   CAST(ROUND(ISNULL(Current_DR_Balance,0)*100,0) AS bigint) current_balance_kobo,
   CONVERT(varchar(10),Card_Issue_Date,23) card_issue_date, CONVERT(varchar(10),CreditCard_Expiry_Date,23) card_expiry_date,
   CONVERT(varchar(10),Payment_Due_Date,23) payment_due_date, CONVERT(varchar(19),Rn_Edit_Date,120) source_updated_at,
   ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(Number_)) ORDER BY Rn_Edit_Date DESC) rn
 FROM dbo.Account WHERE Number_ IS NOT NULL AND LTRIM(RTRIM(Number_))<>'')
SELECT account_no,cif,product_name,product_line,status,card_number_masked,name_on_card,card_limit_kobo,cycle_balance_kobo,current_balance_kobo,card_issue_date,card_expiry_date,payment_due_date,source_updated_at
FROM ranked WHERE rn=1
"@
Write-PgCsv $acct "$OUT\accounts.csv" $acctCols
Write-Output ("accounts: {0}" -f $acct.Count)

# ---- TRANSACTIONS (Jan 1 - Sep 30 2025) ----
$txnCols='sage_txn_id','dedup_key','account_no','cif','post_date','txn_date','txn_code','description','channel','amount_kobo','fees_kobo','trace','merchant_name','mcc','city'
$txn = Sage @"
SELECT CONVERT(bigint,Transaction_Listing_Id) sage_txn_id,
  'sage:'+CAST(CONVERT(bigint,Transaction_Listing_Id) AS varchar(20)) dedup_key,
  LTRIM(RTRIM(Account_Number_txt)) account_no, LTRIM(RTRIM(CIF)) cif,
  CONVERT(varchar(10),Post_Date,23) post_date, CONVERT(varchar(10),Transaction_Date,23) txn_date,
  LTRIM(RTRIM(Transaction_Code)) txn_code, LTRIM(RTRIM(Description)) description,
  CASE WHEN Transaction_Code IN ('300','200','423','903','303','202','302','250','252','350','352','353','472','473') THEN 'interswitch'
       WHEN Transaction_Code IN ('402','400','401','403','405','411','412','413','414','415','416','452') THEN 'collection'
       ELSE 'internal' END channel,
  CAST(ROUND(Amount*100,0) AS bigint) amount_kobo,
  CAST(ROUND(ISNULL(Fees_Amount,0)*100,0) AS bigint) fees_kobo,
  LTRIM(RTRIM(Trace)) trace, LTRIM(RTRIM(Merchant_Name)) merchant_name,
  LTRIM(RTRIM(Merchant_Catergory_Code)) mcc, LTRIM(RTRIM(City)) city
FROM dbo.Transaction_Listing
WHERE Transaction_Date >= '2025-01-01' AND Transaction_Date < '2025-10-01'
  AND CIF IS NOT NULL AND LTRIM(RTRIM(CIF))<>'' AND ISNUMERIC(LTRIM(RTRIM(CIF)))=1
  AND Amount IS NOT NULL
"@
Write-PgCsv $txn "$OUT\transactions.csv" $txnCols
Write-Output ("transactions: {0}" -f $txn.Count)
Write-Output "EXTRACT DONE"
