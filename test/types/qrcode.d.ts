// Minimal ambient types for the `qrcode` reference encoder used only by
// test/vendor-qr.test.ts (the package ships no types; we avoid pulling in the
// full @types/qrcode for a single cross-check). Declares just `create`.
declare module "qrcode" {
  interface QrSegment {
    data: Uint8Array | Buffer;
    mode: "byte" | "numeric" | "alphanumeric" | "kanji";
  }
  interface QrCreateOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    maskPattern?: number;
  }
  interface QrCodeResult {
    modules: { size: number; data: ArrayLike<boolean | number> };
  }
  function create(data: string | QrSegment[], opts?: QrCreateOptions): QrCodeResult;
  const QRCode: { create: typeof create };
  export default QRCode;
}
