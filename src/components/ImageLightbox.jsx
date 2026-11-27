import { useEffect, useRef } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';

// A photo shown large over the page. Closes with Escape, the close button or a click on the dark area.
export default function ImageLightbox({ src, alt = '', onClose }) {
  const { t } = useLocale();
  const closeRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="lightbox-backdrop" role="dialog" aria-modal="true" aria-label={t('chatImageEnlarged')} onClick={onClose}>
      <button ref={closeRef} className="lightbox-close" type="button" onClick={onClose} aria-label={t('hbClose')}>{'\u2715'}</button>
      <img className="lightbox-image" src={src} alt={alt} onClick={(event) => event.stopPropagation()} />
    </div>
  );
}
