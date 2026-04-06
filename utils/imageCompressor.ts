/**
 * Client-side image processing utility.
 *
 * 1. convertHeicIfNeeded — converts HEIC/HEIF → JPEG using heic2any (WebAssembly).
 *    Claude's API and the Canvas API don't understand HEIC, so this must run first.
 *
 * 2. compressImageIfNeeded — progressively reduces JPEG quality then scale until
 *    the file fits under maxBytes (default 4 MB — safe margin under Claude's 5 MB limit).
 *    PDFs and non-image files are returned unchanged.
 *
 * Usage: always call prepareImageFile() which chains both steps.
 */

function isHeic(file: File): boolean {
  // type may be 'image/heic', 'image/heif', or empty string (Safari sometimes omits it)
  if (file.type === 'image/heic' || file.type === 'image/heif') return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext === 'heic' || ext === 'heif';
}

async function convertHeicIfNeeded(file: File): Promise<File> {
  if (!isHeic(file)) return file;
  try {
    // Dynamic import keeps heic2any out of the initial bundle
    const heic2any = (await import('heic2any')).default;
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    const blob = Array.isArray(result) ? result[0] : result;
    const outName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], outName, { type: 'image/jpeg' });
  } catch (err) {
    console.warn('HEIC conversion failed, sending original:', err);
    return file; // let the server deal with it
  }
}

async function compressImageIfNeeded(
  file: File,
  maxBytes = 4 * 1024 * 1024,
): Promise<File> {
  if (file.type === 'application/pdf') return file;
  if (!file.type.startsWith('image/')) return file;
  if (file.size <= maxBytes) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;

      let quality = 0.85;
      let scale = 1.0;

      const attempt = () => {
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return; }

            if (blob.size <= maxBytes) {
              const outName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
              resolve(new File([blob], outName, { type: 'image/jpeg' }));
              return;
            }

            if (quality > 0.4) {
              quality = Math.max(0.4, quality - 0.15);
            } else {
              scale = Math.max(0.2, scale - 0.1);
            }

            if (scale <= 0.2 && quality <= 0.4) {
              const outName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
              resolve(new File([blob], outName, { type: 'image/jpeg' }));
              return;
            }

            attempt();
          },
          'image/jpeg',
          quality,
        );
      };

      attempt();
    };

    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/** Run HEIC conversion → compression in sequence. Use this everywhere. */
export async function prepareImageFile(file: File): Promise<File> {
  const converted = await convertHeicIfNeeded(file);
  return compressImageIfNeeded(converted);
}

// Keep old export name working for any direct callers
export { compressImageIfNeeded };
