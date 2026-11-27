import { useCallback, useEffect, useState } from 'react';
import ImageLightbox from './ImageLightbox.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getChatImageUrl } from '../services/chatImageService.js';

const REFRESH_MS = 240_000;

// One photo of a conversation. The private file is shown through a short-lived link that is requested when the message
// appears and renewed before it expires; a photo still being sent shows the local copy. Pressing it opens it large.
export default function ChatImage({ path, localUrl = '', alt = '' }) {
  const { t } = useLocale();
  const [url, setUrl] = useState(localUrl);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!path) return null;
    try {
      const next = await getChatImageUrl(path);
      setUrl(next);
      setFailed(false);
      return next;
    } catch {
      setFailed(true);
      return null;
    }
  }, [path]);

  useEffect(() => {
    if (!path) {
      setUrl(localUrl);
      return undefined;
    }
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [path, localUrl, load]);

  if (failed && !url) {
    return <button className="chat-image-missing text-action" type="button" onClick={load}>{t('chatImageRetry')}</button>;
  }
  if (!url) return <span className="chat-image-skeleton" role="status" aria-label={t('loadingProgress')} />;

  return (
    <>
      <button className="chat-image-button" type="button" onClick={() => setOpen(true)} aria-label={t('chatImageEnlarge')}>
        <img className="chat-image" src={url} alt={alt || t('chatImageMessage')} loading="lazy" />
      </button>
      {open && <ImageLightbox src={url} alt={alt || t('chatImageMessage')} onClose={() => setOpen(false)} />}
    </>
  );
}
