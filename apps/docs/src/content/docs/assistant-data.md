---
title: The assistant and customer data
description: Which customer details the admin's assistant sends to your AI provider, and how to keep them back.
---

The admin's assistant (**Ask** in the admin) answers by calling the store's tools and sending each result to the AI
provider in `commerce.ai`, as the tool answered it. A result can hold customer details. The assistant is told to use a
customer's details only when your question needs them, and each call's log line counts the emails, phones and
addresses it sent, never their values.

## The tools that send customer details

| Tool                      | What it answers                                  | Customer fields       |
| ------------------------- | ------------------------------------------------ | --------------------- |
| `admin_dashboard`         | Today's figures and the recent orders            | email, phone, address |
| `admin_search`            | Orders, products and customers matching a search | email, phone, address |
| `admin_orders_list`       | Orders, filtered                                 | email, phone, address |
| `admin_orders_get`        | One order with its status history                | email, phone, address |
| `admin_customers_list`    | Customers, filtered and sorted                   | email, phone, address |
| `admin_customers_get`     | One customer with their order statistics         | email, phone, address |
| `admin_customers_orders`  | One customer's orders                            | email, phone, address |
| `admin_customers_history` | One customer's changes                           | phone, address        |
| `admin_proposals_list`    | Agents' proposals and their arguments            | email, phone, address |
| `admin_proposals_get`     | One proposal and its arguments                   | email, phone, address |

## Keeping them back

```ts
agents: {
  assistant: { customerData: false },
},
```

With `agents.assistant.customerData: false` the assistant is not offered any tool in the table, so none of their
results reaches the provider. It still reads products, stock and categories; a question that needs a customer, an
order list or the inbox is one it cannot answer. The default is `true`.

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
> or a customer, the order or customer details it needs (such as a name, email address, phone number or delivery
> address) are sent to [provider] to answer that question. [Provider] processes them under its terms for business
> customers: [link].

## A model on your own server

`@nymbalhq/ai-openai` speaks to any OpenAI-compatible server through `baseUrl`, so the assistant can run on a model
you host (Ollama, vLLM) and no customer detail leaves your network:

```ts
commerce: {
  ai: { provider: 'openai', config: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } },
},
```

The model must support tool calls.
