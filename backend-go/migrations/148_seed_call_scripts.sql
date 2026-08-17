-- 148_seed_call_scripts.sql
-- Seed the Call Center "Call Scripts" library with ready-to-use, O3 Capital-specific
-- talk-tracks. Scripts are channel='call' so they only appear on the Call Scripts page
-- (Care's Email Templates use channel='email'/'both').
--
-- Idempotent: only inserts a script when no call-channel row of the same name exists,
-- so re-running the migration (or editing a seeded script) never duplicates or overwrites.
--
-- Body markup (rendered by the Call Scripts reader):
--   ## Heading            section header
--   > Spoken line         say this to the customer (highlighted talk-track)
--   [ Note / action ]     agent-only cue (a full line starting with "[")
--   - Bullet              list item
--   {Token}               inline fill-in placeholder (e.g. {Customer Name}, {amount})

INSERT INTO helpdesk_canned_responses (name, channel, category, body_text)
SELECT v.name, 'call', v.category, v.body
FROM (VALUES

('Inbound Call — Standard Greeting', 'Openings', $s$## Open the call
> Thank you for calling O3 Capital. My name is {Agent Name}. How may I help you today?
[ Smile as you speak — it carries in your tone. Let the customer finish before you respond. ]

## Acknowledge the reason
> I understand, {Customer Name}. I'll be happy to help you with that.
[ Restate the request in one sentence so the customer knows you've understood. ]

## Before you proceed
[ If the request touches an account, loan, card or personal data, verify identity first — use the Identity Verification (KYC) script. ]$s$),

('Outbound Call — Introduction & Permission', 'Openings', $s$## Confirm you have the right person
> Good {morning/afternoon}, please may I speak with {Customer Name}?
[ If they are unavailable, ask for a good time to call back and log it. Never discuss account details with anyone else. ]

## Introduce yourself and the purpose
> My name is {Agent Name}, calling from O3 Capital. Is this a good time to talk for two minutes?
> I'm reaching out regarding {reason for call}.
[ If it isn't a good time, agree a specific callback slot and thank them. ]

## Get permission to continue
> Thank you. Before we go on, I'll just confirm a few details to protect your account.$s$),

('Identity Verification (KYC)', 'Verification', $s$## Explain why
> For your security, I need to confirm a few details before I can discuss your account.

## Verify — ask for at least two
- Full name and date of birth
- Registered phone number or email on the account
- Last 4 digits of your BVN
[ Match each answer to the record on screen. Two correct answers = verified. ]

## Never ask for
[ Never ask for the full card number, CVV, card PIN, OTP, or full BVN. O3 Capital will NEVER request these by phone. ]

## If verification fails
> I'm sorry, I'm unable to confirm those details, so I can't discuss the account over the phone. Please visit any O3 Capital branch with a valid ID, or use the O3 app.$s$),

('Loan Eligibility & Enquiry', 'Loans', $s$## Understand the need
> I can help with that. How much are you looking to borrow, and what will it be used for?
> And are you a salary earner, self-employed, or running a business?

## Explain what we offer
> We offer salary loans, personal loans and business loans, with repayment spread over up to {tenor} months.
> Your exact limit and rate depend on your income and repayment history.

## Next step
> I can start your application now, or you can apply in seconds on the O3 app under "Loans".
[ For large or business loans, offer a callback from a loan officer and log it. ]$s$),

('Loan Repayment & Balance', 'Loans', $s$## Verify first
[ Confirm identity before sharing any balance — use the Verification script. ]

## Share the position
> Your current outstanding balance is {amount}, and your next repayment of {amount} is due on {date}.

## How to pay
> You can repay from the O3 app, by transfer to your loan account, or it will be deducted automatically on your salary date.
[ If the customer wants to pay now, guide them, or log a promise-to-pay with the date and amount. ]

## Early repayment
> You're welcome to pay off early — I can confirm the exact settlement figure for you right now.$s$),

('Loan Top-Up / Refinance Offer', 'Loans', $s$## Confirm eligibility
[ Check the customer qualifies for a top-up before making the offer. ]

## Make the offer
> Good news, {Customer Name} — because you've kept up your repayments, you qualify for a top-up of up to {amount}.
> Your new monthly repayment would be about {amount} over {tenor} months.

## Close it
> The funds can be in your account today if you accept. Would you like me to proceed?
[ If yes, start the top-up. If unsure, send the details on the app and schedule a follow-up. ]$s$),

('Card Activation', 'Cards', $s$## Verify first
[ Confirm identity before assisting with any card. ]

## Guide activation
> I can help you activate your new O3 card. Do you have it with you now?
> On the O3 app, tap "Cards", select the new card, then "Activate", and set your PIN.
[ If in-app activation isn't possible, confirm it can be activated at an ATM using the PIN mailer. ]

## Security reminder
> Please never share your PIN or any OTP with anyone — not even an O3 Capital staff member.$s$),

('Report Lost / Stolen Card — Block', 'Cards', $s$## Act fast and reassure
> I'm sorry to hear that. I'll block the card right away so it can't be used, and you won't be liable for any fraudulent transactions after the block.

## Verify and block
[ Verify identity, then place an immediate block on the affected card. ]
> I've placed a block on the card ending {last 4}. It can no longer be used.

## Replacement and disputes
> I'll arrange a replacement card for you. If you noticed any transactions you didn't make, I'll log a dispute now.
[ Raise a dispute ticket for any unauthorised transactions and give the customer the reference. ]$s$),

('Card Transaction Dispute', 'Cards', $s$## Gather the details
> Let's sort this out. Which transaction are you disputing — the date, amount, and merchant?
> Did you make any part of this transaction yourself?

## Set expectations
> Thank you. I'm logging a dispute now. Investigations typically take {timeframe}, and I'll make sure you're kept updated.
[ Raise a dispute ticket, attach the transaction, and give the customer the reference number. ]

## If it's fraud
[ If the customer didn't authorise it at all, block the card immediately — use the Lost / Stolen Card script. ]$s$),

('Fixed Deposit Enquiry & Booking', 'Fixed Deposits', $s$## Understand the goal
> I'd be glad to help. How much would you like to place, and for how long?

## Explain the product
> Our fixed deposit pays {rate}% per annum, with tenors from {min} to {max} months. Interest is paid at maturity.
> The longer the tenor, the higher the rate.

## Book it
> I can book it for you now, or you can do it instantly on the O3 app under "Save / Invest".
[ Confirm the source account and that cleared funds are available before booking. ]$s$),

('Fixed Deposit Maturity / Rollover', 'Fixed Deposits', $s$## Verify first
[ Confirm identity before discussing the deposit. ]

## State the position
> Your fixed deposit of {amount} matures on {date}, with interest of {amount} due at maturity.

## Offer the options
> At maturity you can: roll over both principal and interest, roll over the principal only, or have everything paid to your account.
> Which would you prefer?
[ Note the instruction clearly, or set it up on the app together with the customer. ]$s$),

('Collections — Friendly Pre-Due Reminder', 'Collections', $s$## Keep it warm
> Hello {Customer Name}, this is {Agent Name} from O3 Capital. I'm just calling with a friendly reminder.

## The reminder
> Your repayment of {amount} is due on {date}. I wanted to make sure everything is on track for you.

## Make it easy
> You can pay from the O3 app, by transfer, or it will be deducted on your salary date — whichever is easiest for you.
> Is there anything that might get in the way of paying on time?
[ If they foresee a problem, capture it and offer options early. Thank them and close warmly. ]$s$),

('Collections — Overdue & Promise-to-Pay', 'Collections', $s$## Open respectfully
> Hello {Customer Name}, this is {Agent Name} from O3 Capital regarding your loan account.
> Our records show a repayment of {amount} is now {days} days overdue. Is everything alright?

## Listen, then find a path
[ Let the customer explain. Stay calm and professional — never threaten, shame, or raise your voice. ]
> I understand. Let's find a way forward together.

## Secure a promise-to-pay
> Can you make the payment of {amount} by {date}?
[ Log the promise-to-pay with the exact amount and date, then confirm it back. ]
> Thank you. I've noted that you'll pay {amount} by {date}, and I'll follow up to confirm.

## If they genuinely can't pay
[ Don't pressure. Log the reason and escalate for a restructure / hardship review. ]$s$),

('Failed Transaction / Reversal', 'Failed Transactions', $s$## Reassure
> I'm sorry that happened. Let's check it right away — in most cases a failed transaction is reversed automatically.

## Gather the details
> Please tell me the date, the amount, and where it was attempted — ATM, POS, transfer, or the app.
[ Verify identity, then locate the transaction on screen. ]

## Set expectations
> I can see it. Failed transactions are typically reversed within {timeframe}. If it isn't reversed by then, we'll process it manually.
[ If it's already past the reversal window, raise a reversal ticket and give the customer the reference. ]

## Close the loop
> I've logged this under reference {ticket}. You'll get an update as soon as it's resolved.$s$),

('App Download & Onboarding', 'App Support', $s$## Point them to the app
> The O3 app is the fastest way to manage your account. Do you have an Android phone or an iPhone?
> Search "O3 Capital" on the {Play Store / App Store}, or I can send you the download link by SMS.

## First-time setup
> Once it's installed, tap "Register", enter your phone number and BVN, and follow the prompts to set your password.
[ Reassure them it only takes a couple of minutes and their details are secure. ]

## Confirm success
> Let me know once it's installed and I'll walk you through your first login.$s$),

('App Login / Password Reset', 'App Support', $s$## Verify first
[ Confirm identity before helping with account access. ]

## Reset the password
> No problem. On the login screen, tap "Forgot Password", enter your registered phone number, and you'll receive a reset code.
> Enter the code and set a new password.
[ The reset code is single-use. Never ask the customer to read their OTP out to you. ]

## If still locked out
[ If the account is locked or the phone number has changed, raise a ticket for the digital team and set expectations on timing. ]$s$),

('Complaint Handling & De-escalation', 'Complaints', $s$## Listen and acknowledge
> I'm sorry you've had this experience, {Customer Name}. Thank you for telling me — let me put this right.
[ Let the customer explain fully without interrupting. Take notes as they speak. ]

## Show ownership
> I completely understand why that's frustrating. Here's what I'm going to do…
[ Never argue, and never blame the customer or another department. Own the resolution. ]

## Resolve or escalate
> I'll {action} for you now. If I can't fully resolve it on this call, I'll escalate it and make sure someone follows up by {timeframe}.
[ Log a complaint ticket with a clear summary and the agreed resolution. ]

## Close with reassurance
> Again, I apologise for the inconvenience. Is there anything else I can help you with today?$s$),

('Objection Handling — Not Interested / No Funds', 'Objection Handling', $s$## "I'm not interested"
> I completely understand. May I ask — is it the timing, or would a little more information help?
[ Acknowledge first, never push. One clarifying question often reopens the conversation. ]

## "I don't have money right now"
> That's exactly why this could help — {benefit} — and there's no obligation today.

## "I need to think about it"
> Of course. How about I send you the details and give you a quick call {timeframe} once you've had a look?
[ Always agree a specific follow-up time rather than leaving it open. ]

## "Call me later"
> No problem. What time works best for you?
[ Log the callback with the exact time and thank them. ]$s$),

('Call Closing & Wrap-Up', 'Closings', $s$## Confirm resolution
> Have I fully answered your question today, {Customer Name}?
> Is there anything else I can help you with?

## Recap next steps
> To recap: {summary of what was done, plus any next steps or timelines}.
[ Make sure any promise, callback, or ticket is logged before you end the call. ]

## Close warmly
> Thank you for choosing O3 Capital. Have a great day!
[ Where possible, let the customer hang up first. Then complete your call disposition and notes. ]$s$)

) AS v(name, category, body)
WHERE NOT EXISTS (
  SELECT 1 FROM helpdesk_canned_responses c
  WHERE c.name = v.name AND c.channel = 'call'
);
