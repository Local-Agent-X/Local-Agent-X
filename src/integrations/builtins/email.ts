import type { IntegrationDeclaration } from "../types.js";

export const emailIntegration: IntegrationDeclaration = {
  id: "email",
  name: "Email (SMTP/IMAP)",
  icon: "📧",
  description: "Send and read emails — works with Gmail, Outlook, Yahoo, or any email provider",
  authType: "api_key",
  authInstructions: "Gmail setup (recommended):\n1. Go to myaccount.google.com → Security\n2. Enable 2-Step Verification (required)\n3. Go to myaccount.google.com/apppasswords\n4. Create an App Password (select 'Mail')\n5. Fill in these 5 values below:\n\n• SMTP_HOST = smtp.gmail.com\n• SMTP_PORT = 587\n• SMTP_USER = your.email@gmail.com\n• SMTP_PASS = (the 16-char app password)\n• SMTP_FROM = your.email@gmail.com\n\nFor reading emails, also set:\n• IMAP_HOST = imap.gmail.com\n• IMAP_PORT = 993\n• IMAP_USER = your.email@gmail.com\n• IMAP_PASS = (same app password)\n\nOutlook: use smtp-mail.outlook.com (port 587) and outlook.office365.com (port 993)",
  baseUrl: "",
  // Not an HTTP API: the paths below are smtp/imap pseudo-paths and there is no
  // base URL to join them to. The email_* tools are the runtime path.
  transport: "smtp_imap",
  docsUrl: "https://support.google.com/accounts/answer/185833",
  // The full set the runtime actually resolves (src/tools/email-config.ts
  // getSmtpConfig()/getImapConfig()) and that authInstructions already asks the
  // user for — the same nine facts, now DECLARED so the install path can act on
  // them instead of silently dropping eight.
  //
  // Order is load-bearing: `secretName` is derived from credentials[0] and the
  // single-entry install/uninstall/test path still acts on it, so SMTP_PASS must
  // stay first. Only the two passwords belong in the encrypted vault; the rest
  // are non-secret config (`secret: false`) that must NOT be encrypted at rest.
  //
  // The IMAP half is `required: false` because authInstructions has always said
  // so — "For reading emails, ALSO set:" — and it is the truth: sending needs
  // the SMTP five, reading needs the IMAP four, and a send-only mailbox is a
  // real, working configuration. Mandatory IMAP made Set Up uncompletable for
  // that user (the modal refuses a blank field), and the junk IMAP_PASS they
  // would have to invent to get past it lands in the vault, where it satisfies
  // the agent-context gate with a credential guaranteed to fail at runtime.
  credentials: [
    { name: "SMTP_PASS", description: "SMTP password — for Gmail, the 16-character app password" },
    { name: "IMAP_PASS", required: false, description: "IMAP password — for Gmail, the same app password" },
    { name: "SMTP_HOST", secret: false, description: "Outgoing mail server, e.g. smtp.gmail.com" },
    { name: "SMTP_PORT", secret: false, description: "Outgoing mail port, e.g. 587" },
    { name: "SMTP_USER", secret: false, description: "Outgoing mail username — usually your full email address" },
    { name: "SMTP_FROM", secret: false, description: "Address outgoing mail is sent from" },
    { name: "IMAP_HOST", secret: false, required: false, description: "Incoming mail server, e.g. imap.gmail.com" },
    { name: "IMAP_PORT", secret: false, required: false, description: "Incoming mail port, e.g. 993" },
    { name: "IMAP_USER", secret: false, required: false, description: "Incoming mail username — usually your full email address" },
  ],
  endpoints: [
    { name: "Send Email", method: "POST", path: "smtp", description: "Send an email via SMTP" },
    { name: "Read Inbox", method: "GET", path: "imap", description: "Read emails from IMAP inbox" },
    { name: "Search Email", method: "GET", path: "imap/search", description: "Search emails by subject/sender" },
  ],
  headers: {},
  enabled: true,
  installed: false,
  builtin: true,
};
