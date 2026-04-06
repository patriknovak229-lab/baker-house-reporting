/**
 * Client-side image compression using Canvas API.
 * Progressively reduces JPEG quality then scale until the file fits under maxBytes.
 *
 * HEIC/HEIF conversion is NOT done here — it's handled server-side by the
 * extract and drive-upload routes using sharp, which has reliable HEIC support
 * in its pre-built binaries. Trying to convert HEIC in the browser with
 * heic2any crashes in Next.js because that library calls `window` at module load.
 *
 * PDFs and non-image files are returned unchanged.
 */
export async function prepareImageFile(
  file: File,
  maxBytes = 4 * 1024 * 1024, // 4 MB — safe margin under Claude's 5 MB limit
): Promise<File> {
  if (file.type === 'application/pdf') return file;
  // HEIC/HEIF: pass through — server will convert via sharp
  if (file.type === 'image/heic' || file.type === 'image/heif') return file;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'heic' || ext === 'heif') return file;

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
              resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
              return;
            }
            if (quality > 0.4) {
              quality = Math.max(0.4, quality - 0.15);
            } else {
              scale = Math.max(0.2, scale - 0.1);
            }
            if (scale <= 0.2 && quality <= 0.4) {
              resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
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

// Legacy alias
export { prepareImageFile as compressImageIfNeeded };
