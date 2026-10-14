/**
 * A reply as its reader receives it across tool rounds: the model's text, a
 * paragraph break once tools ran, then its next text. The chat reducer draws
 * the same break (public/js/chat-stream-reducer.js); this is the server's
 * copy, shared by every surface that assembles the reply from stream events —
 * the delivery mirror (event-wiring.ts) and the messaging channels
 * (server/inbound-channel-runner.ts). Appending raw deltas ran the rounds
 * together: "…Let me remove it.Fair point — you never said that."
 * (qwen3.6:27b eval, 2026-10-13; the same bytes a Telegram user received).
 */
export class ReplyText {
  private text = "";
  private toolsSinceText = false;

  append(delta: string): void {
    if (this.toolsSinceText && this.text && !this.text.endsWith("\n")) this.text += "\n\n";
    this.text += delta;
    this.toolsSinceText = false;
  }

  /** A tool started or finished: the next text opens a new paragraph. */
  toolBoundary(): void {
    this.toolsSinceText = true;
  }

  /** The whole reply replaced (an adapter's final text, a repair pass). */
  set(text: string): void {
    this.text = text;
    this.toolsSinceText = false;
  }

  get value(): string {
    return this.text;
  }
}
