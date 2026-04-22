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
    body: `Hi {{customerName}},\n\nThank you for your order {{orderNumber}}. Total: {{totalFormatted}}.\n\nWe'll let you know when it ships.`,
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
}

export function renderTemplate(template: string, vars: Record<string, unknown>): RenderedEmail {
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
