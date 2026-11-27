import { useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext.jsx';

const QUESTIONS = [1, 2, 3, 4, 5, 6];

// An accordion where one answer is open at a time.
export default function Faq() {
  const { t } = useLocale();
  const [open, setOpen] = useState(1);

  return (
    <div className="mk-faq">
      {QUESTIONS.map((id) => {
        const expanded = open === id;
        return (
          <div className="mk-faq-item" key={id} data-open={expanded}>
            <h3>
              <button type="button" id={`mk-faq-q-${id}`} aria-expanded={expanded} aria-controls={`mk-faq-a-${id}`} onClick={() => setOpen(expanded ? 0 : id)}>
                <span>{t(`mkFaq${id}Q`)}</span><i aria-hidden="true" />
              </button>
            </h3>
            <div id={`mk-faq-a-${id}`} role="region" aria-labelledby={`mk-faq-q-${id}`} hidden={!expanded}><p>{t(`mkFaq${id}A`)}</p></div>
          </div>
        );
      })}
    </div>
  );
}
