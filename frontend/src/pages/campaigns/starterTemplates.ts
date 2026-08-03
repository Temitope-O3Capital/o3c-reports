import type { EmailBlock } from '../../components/EmailBlockEditor'

// Prebuilt starter templates shown in the Templates gallery. Choosing one opens
// the editor prefilled (as a new, unsaved template) so it can be edited and saved
// like any other. These are client-side seeds — not stored until saved.

export interface StarterTemplate {
  id:            string
  name:          string
  channel:       'email' | 'sms' | 'whatsapp'
  category:      string
  description:   string
  sms_body?:     string
  whatsapp_body?: string
  email_subject?: string
  email_blocks?: EmailBlock[]
}

const NAVY = '#0E2841'
const RED = '#C00000'

// Small helper to keep email starter blocks readable.
const b = (type: string, extra: Record<string, unknown>): EmailBlock => ({ id: `${type}-${Math.random().toString(36).slice(2, 8)}`, type, ...extra })

function emailShell(bodyBlocks: EmailBlock[]): EmailBlock[] {
  return [
    b('header', { logoText: 'O3 Capital', tagline: 'Your Financial Partner', bg: NAVY, textColor: '#ffffff', padding: 32 }),
    ...bodyBlocks,
    b('footer', { text: '© 2026 O3 Capital Financial Services Ltd · Lagos, Nigeria', unsubscribe: true }),
  ]
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  // ── Email ──
  {
    id: 'email-welcome',
    name: 'Welcome / Onboarding',
    channel: 'email',
    category: 'onboarding',
    description: 'Warm welcome for a new customer with a clear first action.',
    email_subject: 'Welcome to O3 Capital, {{first_name}} 🎉',
    email_blocks: emailShell([
      b('text', { html: '<p style="margin:0 0 14px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0 0 14px;">Welcome to O3 Capital! We\'re delighted to have you. Your account is ready and you can now access loans, fixed deposits and card services from one place.</p>' }),
      b('button', { text: 'Get Started', url: '{{cta_url}}', bg: NAVY, textColor: '#ffffff', align: 'center', size: 'md', rounded: true }),
      b('spacer', { height: 20 }),
    ]),
  },
  {
    id: 'email-repayment',
    name: 'Repayment Reminder',
    channel: 'email',
    category: 'repayment_reminder',
    description: 'Reminds a borrower of an upcoming repayment with the amount and due date.',
    email_subject: 'Your repayment of ₦{{amount}} is due on {{due_date}}',
    email_blocks: emailShell([
      b('text', { html: '<p style="margin:0 0 14px;">Hi <strong>{{first_name}}</strong>,</p><p style="margin:0 0 14px;">This is a friendly reminder that your repayment is due soon. Please pay before the due date to keep your account in good standing and avoid late fees.</p>' }),
      b('stats', { cols: [{ value: '₦{{amount}}', label: 'Amount Due', color: RED }, { value: '{{due_date}}', label: 'Due Date', color: '#D97706' }] }),
      b('button', { text: 'Pay Now', url: '{{cta_url}}', bg: RED, textColor: '#ffffff', align: 'center', size: 'md', rounded: true }),
    ]),
  },
  {
    id: 'email-promo',
    name: 'Promotional Offer',
    channel: 'email',
    category: 'marketing',
    description: 'Announce a new product, rate or limited-time offer.',
    email_subject: '{{first_name}}, unlock a better rate this month',
    email_blocks: emailShell([
      b('text', { html: '<p style="margin:0 0 14px;">Hi <strong>{{first_name}}</strong>,</p><p style="margin:0;">For a limited time, enjoy improved rates on our fixed deposits and faster loan approvals. Don\'t miss out.</p>' }),
      b('callout', { theme: 'success', icon: '✨', title: 'Limited-time offer', body: 'Higher returns on new fixed deposits — offer ends soon.' }),
      b('button', { text: 'See the Offer', url: '{{cta_url}}', bg: NAVY, textColor: '#ffffff', align: 'center', size: 'md', rounded: true }),
    ]),
  },
  {
    id: 'email-statement',
    name: 'Statement Ready',
    channel: 'email',
    category: 'general',
    description: 'Notify a customer that their account statement is available.',
    email_subject: 'Your O3 Capital statement is ready',
    email_blocks: emailShell([
      b('text', { html: '<p style="margin:0 0 14px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0;">Your latest account statement is now available. You can view or download it securely from your dashboard.</p>' }),
      b('button', { text: 'View Statement', url: '{{cta_url}}', bg: NAVY, textColor: '#ffffff', align: 'center', size: 'md', rounded: true }),
    ]),
  },

  // ── SMS ──
  {
    id: 'sms-repayment',
    name: 'Repayment Reminder',
    channel: 'sms',
    category: 'repayment_reminder',
    description: 'Concise SMS nudge with amount and due date.',
    sms_body: 'Hi {{first_name}}, your O3 Capital repayment of N{{amount}} is due on {{due_date}}. Pay now to avoid late fees: {{cta_url}}',
  },
  {
    id: 'sms-payment-confirmed',
    name: 'Payment Confirmation',
    channel: 'sms',
    category: 'general',
    description: 'Confirms a received payment.',
    sms_body: 'Hi {{first_name}}, we\'ve received your payment of N{{amount}}. Thank you! Your O3 Capital account is up to date.',
  },
  {
    id: 'sms-promo',
    name: 'Promo Blast',
    channel: 'sms',
    category: 'marketing',
    description: 'Short promotional message with a call to action.',
    sms_body: '{{first_name}}, get faster loans & better FD rates this month with O3 Capital. Apply: {{cta_url}}. Reply STOP to opt out.',
  },

  // ── WhatsApp ──
  {
    id: 'wa-repayment',
    name: 'Repayment Reminder',
    channel: 'whatsapp',
    category: 'repayment_reminder',
    description: 'WhatsApp reminder with a friendly tone and pay link.',
    whatsapp_body: 'Hi {{first_name}} 👋\n\nA quick reminder that your O3 Capital repayment of *₦{{amount}}* is due on *{{due_date}}*.\n\nTap to pay securely: {{cta_url}}',
  },
  {
    id: 'wa-welcome',
    name: 'Welcome Message',
    channel: 'whatsapp',
    category: 'onboarding',
    description: 'Greets a new customer on WhatsApp.',
    whatsapp_body: 'Welcome to O3 Capital, {{first_name}}! 🎉\n\nYour account is ready. Loans, fixed deposits and cards — all in one place.\n\nNeed help? Just reply to this message.',
  },
  {
    id: 'wa-promo',
    name: 'Promo Offer',
    channel: 'whatsapp',
    category: 'marketing',
    description: 'Limited-time promo for WhatsApp.',
    whatsapp_body: 'Hi {{first_name}}! ✨\n\nFor a limited time, enjoy *better FD rates* and *faster loan approvals* with O3 Capital.\n\nLearn more: {{cta_url}}',
  },
]
