import type { Protocol } from "../types.js";

export const instagramPost: Protocol = {
  name: "instagram_post",
  description: "Post photos/videos to Instagram with a formatted caption. Handles carousel ordering, cropping guidance, caption formatting (line breaks that actually work), and publishing.",
  triggers: [
    "post on instagram", "post to instagram", "instagram post",
    "make an instagram post", "publish on instagram", "share on instagram",
    "post this on ig", "put this on instagram",
  ],
  learnablePreferences: [
    "instagram_username",
    "default_hashtags",
    "caption_style",         // e.g. "emoji-heavy", "clean", "professional"
    "preferred_crop",        // e.g. "4:5", "1:1", "original"
    "signature_line",        // e.g. "📍 Your Store Name" or "🌎 yoursite.com"
    "always_include_cta",    // e.g. true (always end with call-to-action)
  ],
  rules: [
    // Caption formatting — the #1 pain point
    "CRITICAL: Instagram's web composer DESTROYS line breaks if you paste normally. To preserve formatting: use the browser 'evaluate' action to set the caption via JavaScript, NOT the 'fill' action. Use: document.querySelector('textarea, [contenteditable], [role=\"textbox\"]') and set value/textContent with literal \\n characters.",
    "NEVER paste the caption twice. After inserting, use 'snapshot' to verify the caption appears exactly once and is properly formatted.",
    "Keep the final caption in a variable throughout the conversation. If the user asks to use 'the caption from earlier', refer to it — never say you can't see it.",

    // Browser session management
    "Before navigating to Instagram, check if there's already an open Instagram tab using the 'tabs' action. If so, switch to it instead of opening a new one. This preserves the user's login session.",
    "If Instagram shows a login screen, tell the user to log in manually in the browser window. Do NOT attempt to fill credentials.",
    "After login confirmation, take a snapshot to verify you're on the right page before proceeding.",

    // Image/media handling
    "The OS file picker CANNOT be automated. Tell the user to select files manually. Be specific: tell them exactly which files and in what order.",
    "For carousel posts: tell the user the desired image order BEFORE they open the file picker. Once uploaded, reordering is unreliable via automation.",
    "For cropping: guide the user verbally (e.g., 'zoom in slightly on photo 2 so the full body is visible'). Only attempt automated crop if Instagram's UI supports it via accessible controls.",

    // Pre-publish verification
    "Before hitting Share/Publish: take a snapshot and verify: (1) caption is present and not duplicated, (2) correct number of images are shown, (3) no error banners visible.",
    "If anything looks wrong in the pre-publish check, STOP and tell the user what's wrong. Never publish a broken post.",

    // Post-publish
    "After publishing, confirm success by checking for the 'Post shared' confirmation or by navigating to the user's profile.",
  ],
  steps: [
    {
      id: "gather",
      instruction: "Collect from the user: (1) images/videos to post, (2) caption text or topic to write about, (3) post type (Feed/Story/Reel/Carousel). If they provide images, note the file paths. If they want you to write the caption, draft it and get approval before proceeding.",
    },
    {
      id: "draft_caption",
      instruction: "Write the caption. Apply user's preferred style if known. Include hashtags (use user's defaults + topic-specific ones). Format with clear line breaks between sections. Store the FINAL approved caption — you'll need it later.",
    },
    {
      id: "open_instagram",
      instruction: "Check for existing Instagram tabs first (browser 'tabs' action). If found, switch to it. Otherwise navigate to https://www.instagram.com/. Verify you're logged in via snapshot. If not logged in, ask user to log in manually.",
    },
    {
      id: "start_post",
      instruction: "Click the Create/New Post button (usually '+' icon or 'Create' in sidebar). Wait for the upload modal to appear.",
      requiresUserAction: false,
    },
    {
      id: "upload_media",
      instruction: "Tell the user to select their files in the OS file picker. Be specific about the order: 'Select [file1] first (this will be the cover), then [file2], then [file3].' Wait for user to confirm upload is done.",
      requiresUserAction: true,
    },
    {
      id: "review_media",
      instruction: "Take a snapshot. Check: (1) correct number of images, (2) image order matches what was requested, (3) cropping looks good. If anything needs adjustment, guide the user through fixing it. Only proceed when media looks right.",
      validate: "Snapshot shows correct number of media items in correct order",
    },
    {
      id: "advance_to_caption",
      instruction: "Click 'Next' to advance past filters/editing to the caption screen. Take a snapshot to confirm you're on the caption/share screen.",
    },
    {
      id: "insert_caption",
      instruction: "Insert the approved caption using JavaScript evaluation (NOT fill). Use: browser evaluate action with code that finds the textarea/contenteditable and sets the text with proper line breaks. Then take a snapshot to verify: caption appears exactly once, formatting is preserved, no duplication.",
      validate: "Caption appears exactly once in snapshot, with line breaks intact",
    },
    {
      id: "pre_publish_check",
      instruction: "Final verification snapshot. Check: (1) caption is correct and not duplicated, (2) media preview looks right, (3) no error messages. Report status to user and ask for 'go ahead' to publish.",
      requiresUserAction: true,
    },
    {
      id: "publish",
      instruction: "Click Share/Publish. Wait for confirmation. Take a snapshot to verify the post was published successfully.",
    },
    {
      id: "confirm",
      instruction: "Confirm to the user that the post is live. If possible, provide the post URL. Ask if they want to make any edits or post another.",
    },
  ],
};

// ── Caption Formatting Helpers ──
// Hard-won knowledge about Instagram's composer.

export function formatCaptionForInstagram(caption: string): string {
  // Instagram web composer needs actual newlines, not markdown breaks
  // Replace any \r\n or \r with \n for consistency
  let clean = caption.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Collapse 3+ newlines to 2 (Instagram ignores excessive spacing)
  clean = clean.replace(/\n{3,}/g, "\n\n");
  return clean;
}

// JavaScript code to inject caption into Instagram's composer
export function buildCaptionInjector(caption: string): string {
  // Escape for JS string literal using JSON.stringify (handles all special chars)
  const escaped = JSON.stringify(caption).slice(1, -1); // strip outer quotes

  return `
    (function() {
      // Try multiple selectors — Instagram changes these
      const selectors = [
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[aria-label="Write a caption..."]',
        '[aria-label*="caption"]',
        'div[data-lexical-editor="true"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;

        // Focus the element first
        el.focus();
        el.click();

        if (el.tagName === 'TEXTAREA') {
          // Native textarea — set value + dispatch events
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          ).set;
          nativeSetter.call(el, '${escaped}');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Caption inserted via textarea';
        } else {
          // ContentEditable / Lexical editor
          // Clear existing content
          el.innerHTML = '';
          // Insert with line breaks as <br> or paragraphs
          const lines = '${escaped}'.split('\\n');
          // Use execCommand for undo support
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);

          // Type each line with proper breaks
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
              // Insert line break
              document.execCommand('insertParagraph', false, null);
            }
            if (lines[i]) {
              document.execCommand('insertText', false, lines[i]);
            }
          }
          return 'Caption inserted via contenteditable';
        }
      }
      return 'ERROR: Could not find caption input element';
    })()
  `.trim();
}
