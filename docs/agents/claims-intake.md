# Claim intake and email conversations

Future direction only: read when planning email forwarding, customer replies, form intake, or Admin-created cases.

[Back to root instructions](../../AGENTS.md). Related: [Shared Case model](claims-returns.md); [privacy and authentication](data-security.md); [AI validation](claim-automation.md); [workers](operations.md).

## Claims Intake

Different intake mechanisms should be adapters into shared claim creation.

### Email (first intake channel)

Email forwarding is the first product. The pilot merchant handles all customer requests by email and does not want that process changed, only automated. Customers keep emailing the store as they do today.

Flow:

```text
Customer emails the store
    ->
Merchant forwards it (manually or with an inbox rule) to the store's app address
    ->
Inbound email provider webhook -> web route (store raw message, return quickly)
    ->
Worker: parse, extract, resolve order -> Case
    ->
Merchant reviews in Admin -> resolution, label, customer update
```

Requirements:

- Give each store its own unguessable forwarding address. Establish the tenant from the receiving address, never from the email's content.
- For new forwarded cases, accept mail only from senders the merchant has registered, and check sender authentication (SPF/DKIM/DMARC results), so no one can inject cases into another store.
- For replies to an existing case, allow the case’s verified customer to reply using that case’s token. Verify the customer/case association and tenant ownership before appending the reply; a reply token must not authorize creating a new case for another store.
- Keep the original customer email address and thread so later updates reach the right person in the same conversation.
- Resolve the order from references in the email (order number, customer email) and verify it belongs to the tenant. If no order matches, the case goes to review.
- Store only the forwarded message and the extracted fields; never pull or retain other inbox content.
- Make processing idempotent on the message ID, so a double-forwarded email creates one case.

Extraction is AI-assisted and untrusted:

- validate extracted fields against Shopify data before use
- record a short summary and the structured result, not raw model reasoning
- email parsing must not decide whether a claim is valid

Customer updates (decided):

- **Sent from the store's own address** (for example `support@store.com`) through a transactional email provider that the merchant authorizes with DNS records (SPF, DKIM, DMARC alignment). The customer sees an email from the store.
- **Reply-To is the store's app address with a case token** (for example `store-token+case-123@<app domain>`). Customer replies thread back into the case automatically.
- **Every customer reply is also copied to the merchant's inbox,** so their team never loses sight of a conversation.
- **Never connect to the merchant's mailbox** (Gmail/Microsoft OAuth or IMAP credentials). Reading a mailbox through Google's API requires restricted scopes and a paid third-party security assessment; forwarding in and DNS-authorized sending out avoid that entirely.
- **Treat send authority as a credential.** The app can send as the store's domain, so keep provider keys server-side, send only case-related templates to that case's customer, and log every send.

### Small customer form (later, for merchants who want it)

The form should collect only what is necessary.

Authenticate or validate order/customer context appropriately.

Do not trust order IDs supplied without ownership/tenant validation.

### Shopify Admin

Merchant users should eventually be able to:

- create claims
- see claims associated with an order
- review claims
- approve
- reject
- request additional review/information
- trigger allowed resolutions

All paths should use shared claim services.
