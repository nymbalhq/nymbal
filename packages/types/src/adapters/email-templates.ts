// The kernel's transactional email templates, shared by every email adapter (the console one and the SMTP package).
export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.')
    let cur: unknown = vars
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p]
      } else {
        return ''
      }
    }
    return cur == null ? '' : String(cur)
  })
}

const TEMPLATES: Record<string, { subject: string; body: string }> = {
  'order-placed': {
    subject: 'Order {{orderNumber}} confirmed',
    // `orderLink` is the whole "View your order" paragraph, absent when the store has no URL to link from.
    body: `Hi {{customerName}},\n\nThank you for your order {{orderNumber}}. Total: {{totalFormatted}}.\n\nWe'll let you know when it ships.{{orderLink}}`,
  },
  'order-shipped': {
    subject: 'Order {{orderNumber}} is on its way',
    body: `Hi {{customerName}},\n\nYour order {{orderNumber}} has shipped via {{carrier}}.\nTracking: {{trackingNumber}}`,
  },
  welcome: {
    subject: 'Welcome to {{storeName}}',
    body: `Welcome {{customerName}}! Your account is ready.`,
  },
  'cart-abandoned': {
    subject: "Don't forget your cart at {{storeName}}",
    body: `Hi,\n\nYou left items in your cart. Pick up where you left off: {{resumeUrl}}`,
  },
  // Each link on a line of its own, so a mail client never runs the next word into it.
  'alert-confirm': {
    subject: 'Confirm your alert for {{productName}}',
    body: `Hi,\n\nYou asked {{storeName}} to email you when {{productName}} is back in stock. Confirm by following this link:\n\n{{confirmUrl}}\n\nIf you did not ask, ignore this email and you will hear nothing more.\n\nStop this alert:\n{{unsubscribeUrl}}`,
  },
  'alert-back-in-stock': {
    subject: '{{productName}} is back in stock',
    body: `Hi,\n\n{{productName}} is back in stock at {{storeName}}:\n\n{{productUrl}}\n\nThis was a one-time alert. Stop it:\n{{unsubscribeUrl}}`,
  },
}

export function renderEmailTemplate(
  template: string,
  vars: Record<string, unknown>,
): RenderedEmail {
  const t = TEMPLATES[template]
  if (!t) {
    return {
      subject: `[nymbal] ${template}`,
      text: JSON.stringify(vars),
      html: `<pre>${JSON.stringify(vars, null, 2)}</pre>`,
    }
  }
  const subject = render(t.subject, vars)
  const text = render(t.body, vars)
  const html = `<pre>${text.replace(/</g, '&lt;')}</pre>`
  return { subject, text, html }
}
