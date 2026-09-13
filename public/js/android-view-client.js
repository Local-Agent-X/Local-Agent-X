// Android device mirror — draws frames pushed from the desktop main process
// (desktop/src/android-view.ts) into a <canvas>. Frames are plain PNG bytes
// polled server-side via adb screencap (src/android/frame-stream.ts); there
// is no live view to attach here, just images to blit.

function attachAndroidView(canvas, viewId) {
  if (!window.desktop || !window.desktop.android) return () => {};
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    if (canvas.width !== img.width) canvas.width = img.width;
    if (canvas.height !== img.height) canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
  };
  window.desktop.android.onFrame((frame) => {
    if (viewId && frame.viewId !== viewId) return;
    img.src = 'data:image/png;base64,' + frame.pngBase64;
  });
  return () => { img.onload = null; };
}
