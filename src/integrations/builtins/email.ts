import type { IntegrationConfig } from "../types.js";

export const emailIntegration: IntegrationConfig = {
  id: "email",
  name: "Email (SMTP/IMAP)",
  icon: "📧",
  description: "Send and read emails — works with Gmail, Outlook, Yahoo, or any email provider",
  authType: "api_key",
  authInstructions: "Gmail setup (recommended):\n1. Go to myaccount.google.com → Security\n2. Enable 2-Step Verification (required)\n3. Go to myaccount.google.com/apppasswords\n4. Create an App Password (select 'Mail')\n5. Fill in these 5 values below:\n\n• SMTP_HOST = smtp.gmail.com\n• SMTP_PORT = 587\n• SMTP_USER = your.email@gmail.com\n• SMTP_PASS = (the 16-char app password)\n• SMTP_FROM = your.email@gmail.com\n\nFor reading emails, also set:\n• IMAP_HOST = imap.gmail.com\n• IMAP_PORT = 993\n• IMAP_USER = your.email@gmail.com\n• IMAP_PASS = (same app password)\n\nOutlook: use smtp-mail.outlook.com (port 587) and outlook.office365.com (port 993)",
  baseUrl: "",
  docsUrl: "https://support.google.com/accounts/answer/185833",
  secretName: "SMTP_PASS",
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
