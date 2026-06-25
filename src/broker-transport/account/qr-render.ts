// Render a pairing QR as a PNG data URL the desktop's account page <img>-displays.
// The input is the qr-payload.ts JSON string the broker returned (challenge code +
// the phone's redeem URL) — non-secret (single-use, TTL'd). Uses the `qrcode` dep
// already in the app (same as src/whatsapp-bridge). Networkless + deterministic, so it
// unit-tests offline (the output is a `data:image/png;base64,…` string).

// @ts-ignore — no types for qrcode
import QRCode from "qrcode";

/** Encode `text` as a QR and return a PNG data URL (e.g. for an <img src>). */
export async function renderQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { width: 320, margin: 1 });
}
