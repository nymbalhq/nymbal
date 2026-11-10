---
title: The assistant and customer data
description: Which customer details the admin's assistant sends to your AI provider, and how to keep them back.
---

The admin's assistant (**Ask** in the admin) answers by calling the store's tools and sending each result to the AI
provider in `commerce.ai`. A result can hold customer details: by default their emails, phones, street lines and
postcodes reach the provider as placeholders (see [Masking](#masking)). The assistant is told to use a customer's
details only when your question needs them, and each call's log line counts the emails, phones and addresses the
result held, never their values.

## The tools that send customer details

| Tool                              | What it answers                                  | Customer fields       |
| --------------------------------- | ------------------------------------------------ | --------------------- |
| `admin_dashboard`                 | Today's figures and the recent orders            | email, phone, address |
| `admin_search`                    | Orders, products and customers matching a search | email, phone, address |
| `admin_orders_list`               | Orders, filtered                                 | email, phone, address |
| `admin_orders_get`                | One order with its status history                | email, phone, address |
| `admin_customers_list`            | Customers, filtered and sorted                   | email, phone, address |
| `admin_customers_get`             | One customer with their order statistics         | email, phone, address |
| `admin_customers_orders`          | One customer's orders                            | email, phone, address |
| `admin_customers_history`         | One customer's changes                           | phone, address        |
| `admin_proposals_list`            | Agents' proposals and their arguments            | email, phone, address |
| `admin_proposals_get`             | One proposal and its arguments                   | email, phone, address |
| `admin_orders_confirm`            | The order, confirmed                             | email, phone, address |
| `admin_orders_process`            | The order, processing                            | email, phone, address |
| `admin_orders_cancel`             | The order, cancelled                             | email, phone, address |
| `admin_orders_markPaid`           | The order, paid                                  | email, phone, address |
| `admin_orders_markDelivered`      | The order, delivered                             | email, phone, address |
| `admin_orders_ship`               | The order, shipped                               | email, phone, address |
| `admin_orders_refund`             | The refund and the order                         | email, phone, address |
| `admin_orders_resendConfirmation` | The order number and where the confirmation went | email                 |
| `admin_customers_markVerified`    | The customer, their email confirmed              | email, phone, address |

## Keeping them back

```ts
agents: {
  assistant: { customerData: false },
},
```

With `agents.assistant.customerData: false` the assistant is not offered any tool in the table, so none of their
results reaches the provider. It still reads products, stock and categories; a question that needs a customer, an
order list or the inbox, or a change to an order, is one it cannot answer. The default is `true`.

## Masking

`agents.assistant.mask` lists the customer fields the provider reads as placeholders: any of `email`, `phone`,
`address` (street lines), `postcode` and `name` (first and last names).

```ts
agents: {
  assistant: { mask: ['email', 'phone', 'address', 'postcode', 'name'] },
},
```

The default is `['email', 'phone', 'address', 'postcode']`: names are sent. City, region, country, company and
everything else a tool answers are always sent, so the assistant can still count orders by city or country.

Within one question, each value becomes a placeholder such as `[email-1]` or `[postcode-2]`, the same value always the
same placeholder. When the model copies a placeholder into a tool call, the store receives the real value, so a search
by a customer's email still works; when it copies one into its answer, you see the real value. Placeholders live only
in that question's memory: no log line, stored record or proposal holds one.

Details you type in a question are caught in free text by pattern: emails, and phone numbers starting with `+`, `(` or
`0` (`+44 7700 900123`, `(555) 123-4567`). A US-style `555-123-4567` without one of those is a miss and is sent as
typed. A spaced product code of 10 to 15 digits starting with 0, such as `012345 678905`, is a false positive: it is
masked as a phone and restored in calls and the answer. Postcodes, street lines and names in free text (a question, a
note, a review) are masked only once a field has shown them in the turn.

On a follow-up, the admin sends each earlier answer back with the places where it showed a customer's value, so the
details an earlier answer showed are masked again rather than sent as you see them. Text written like a placeholder,
in a question or anywhere in the store's data, reaches the model as `[email 1]`, so it can never be revealed as a
customer's value.

Masking has an accuracy cost: the model cannot reason over what it cannot read (a phone number's country, which
postcodes share an area), and a model that rewrites a placeholder shows it as text. Set `mask: []` to send every field
as the tool answered it, for example with a model on your own server.

`nymbal doctor` prints an `ai host` line naming the host the assistant sends to, whether it is this machine, your
network or remote, and which customer fields are masked there.

## List summaries and record cards

The orders lists (`admin_orders_list`, `admin_customers_orders`) and the products list (`admin_products_list`) reach
the provider as summaries: each order as its number, status, date, email, shipping first and last name, city,
postcode and country, its totals and its number of items; each product as its id, slug, name, status, type and its
variants' names, SKUs, prices, stock and options. Street lines, phones, notes and descriptions are left out. A summary keeps
the order's own field names, so the mask applies to it as to the whole order: by default the email and postcode are
placeholders and the names are sent. A page of 50 orders fits one result, and `total` tells the model how many orders
matched.

Under an answer, the admin shows a card for each order or customer the question read, at most five: the order's
shipping name, email, phone, address, status and total, or the customer's details and order count. The admin reads
each card from the store with your own session; the answer's stream names only the order number or customer id, and
none of a card's content is sent to the provider.

## Agents over MCP

An AI agent an admin connects over `POST /api/mcp` or `nymbal mcp` (Claude Desktop, ChatGPT, Cursor) is not masked
and revealed: the fields in `agents.mcp.withhold` are taken out of every admin tool result it receives. The default is
`['email', 'phone', 'address', 'postcode']`, the same fields as the assistant's default mask.

A result that lost a value names its kind in `withheld`. Emails and phones typed into text (an order note, a proposal's
reason) are replaced with `[email withheld]` and `[phone withheld]`; a street line or postcode in a note only where it
repeats a value the result withheld. Set `withhold: []` to send every field.

A shopper's agent reading its own orders and account is not withheld, and the assistant is not affected: it still
reads each value and masks it as above. See [Agents](../agents/#customer-details-agents-are-not-sent).

## Your provider's terms

What the provider keeps, for how long, and whether it trains on it are the provider's terms, not Nymbal's:

- Anthropic: [commercial terms](https://www.anthropic.com/legal/commercial-terms),
  [privacy center](https://privacy.anthropic.com/) (retention and training) and
  [zero data retention](https://docs.anthropic.com/en/docs/build-with-claude/zero-data-retention).
- OpenAI: [your data](https://platform.openai.com/docs/guides/your-data) (retention, training, zero data retention,
  and data residency in Europe).

## For your privacy policy

A paragraph you can adapt:

> We use an AI service, [provider], to help our staff manage the store. When a member of staff asks it about an order
> or a customer, the order or customer details it needs are sent to [provider] to answer that question. Email
> addresses, phone numbers, street addresses and postcodes are replaced with placeholders before they are sent; a
> name, a city and a country may be sent as they are. [Provider] processes them under its terms for business
> customers: [link].

If your staff connect AI agents to the store over MCP, a second one:

> Our staff may also use AI agents, such as [agent], that read orders and customers through the store. Email
> addresses, phone numbers, street addresses and postcodes are withheld from what those agents receive. Email
> addresses and phone numbers typed into text, such as an order note, are replaced; a street address or postcode
> typed into a note is replaced only where it repeats one withheld from the same answer, such as the order's own
> address shown with the note. Other addresses typed into notes are not detected and may reach the agent.

## A model on your own server

`@nymbalhq/ai-openai` speaks to any OpenAI-compatible server through `baseUrl`, so the assistant can run on a model
you host (Ollama, vLLM) and no customer detail leaves your network:

```ts
commerce: {
  ai: { provider: 'openai', config: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
},
```

The model must support tool calls.
