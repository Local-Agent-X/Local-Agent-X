---
name: Credentialed Integration Setup
description: Set up an integration (SMTP, IMAP, API key, OAuth client) end-to-end by generating credentials on the provider site and storing them in the encrypted vault
allowed-tools: [browser, browser_capture_to_secret, email_setup, secret_list, sidebar_pin]
when-to-use: When the user asks to set up, configure, or connect an email/SMTP/IMAP service, an API integration that needs an app password or API key, or any credential-generating flow where the provider shows the secret value once
---

End-to-end pattern for any service that issues a one-shot credential (app password, API key, OAuth token).

## Protocol

1. **Navigate** to the provider's credential-generation page. Common paths:
   - Fastmail: `https://app.fastmail.com/settings/security/integrations`
   - Gmail: `https://myaccount.google.com/apppasswords` (requires 2FA on)
   - GitHub: `https://github.com/settings/tokens`
   - Twilio / Stripe / etc.: provider's API keys / credentials page
   If you don't know the exact URL, `web_search` for "<provider> app password" or "<provider> api keys settings".

2. **Generate** the credential. Click the create/generate/new-app-password button, set the scope appropriate to the task (SMTP-only for email send, smallest scope for API keys), give it a memorable name like "Local Agent X — SMTP".

3. **Capture immediately** with `browser_capture_to_secret` BEFORE the user dismisses the reveal dialog. Providers only show the value once.
   - Use `text_selector` for `<code>`/`<pre>`/`<span>` elements displaying the value as text.
   - Use `selector` for `<input readonly>` that holds the value in `.value`.
   - Always pass `name`, `service`, `account`, `url`, `notes` — this is what makes the Secrets UI useful for manual recovery later.
   - Example: `browser_capture_to_secret({name: "SMTP_PASS", service: "Fastmail", account: "peter@pmajlabs.com", url: "https://app.fastmail.com", notes: "SMTP-only scope, generated via agent"})`.

4. **Configure the integration** (non-secret fields only). Passwords stay in the vault; host/port/user/from-address go to config.
   - Email: call `email_setup({smtp_host, smtp_port, smtp_user, smtp_from, verify: true})`. The tool pulls SMTP_PASS from the vault; refuses if it's not there.
   - Other APIs: agent config goes via `http_request` POST to `http://127.0.0.1:7007/api/settings` or a dedicated setup tool if one exists.

5. **Verify** by running a low-risk operation against the integration (send a test email to the user's own address, hit a read-only API endpoint). Report success/failure with specifics.

## Rules

- Never use `browser.extract` or `browser.evaluate` to read a secret value — those leak to the LLM provider.
- Never call `secret_save` with the value as a tool arg — same leak.
- Always use `browser_capture_to_secret` for secrets visible on a page.
- If the capture selector fails (element not found, empty), SNAPSHOT the page, identify the actual element, and retry. Don't ask the user to paste the value — that defeats the whole point.
- If the provider requires 2FA/CAPTCHA to reach the credentials page, stop and tell the user: "Fastmail needs 2FA to reach app passwords — do it in the browser and tell me when you're on the Integrations page."
