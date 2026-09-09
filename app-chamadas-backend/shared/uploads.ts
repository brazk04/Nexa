// Keep multipart requests below the Vercel Function payload ceiling (4.5 MB).
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const UPLOAD_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.mp4,.webm';
export function uploadSizeError(file: { name: string; type: string }) {
  const label = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(file.name) ? 'A imagem'
    : file.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/i.test(file.name) ? 'O vídeo' : 'O arquivo';
  return `${label} excede o limite permitido de 4 MB. Escolha um arquivo menor.`;
}
export function validateUpload(file: { name: string; type: string; size: number }) {
  if (file.size > MAX_UPLOAD_BYTES) return uploadSizeError(file);
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!UPLOAD_ACCEPT.split(',').includes(extension)) return 'Formato não permitido. Use JPG, PNG, WEBP, GIF, documento, MP4 ou WebM.';
  if (!file.size) return 'O arquivo está vazio.';
  return '';
}
