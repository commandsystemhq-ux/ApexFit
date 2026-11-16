import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { isValidSignatureDataUrl } from '../services/contractUtils.js';

// Read-only copy of a signed contract: the wording that was signed, the drawn signature, and when/by whom.
export default function SignedContractView({ signature, onClose }) {
  const { t, locale } = useLocale();
  const stamp = new Date(signature.signed_at).toLocaleString(locale);

  return (
    <section className="panel signed-view" aria-label={signature.contract_title}>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{t('ctrSignedWording')}</span>
          <h3>{signature.contract_title}</h3>
        </div>
        <span className="soft-badge badge-green">{t('ctrStatusSigned')}</span>
      </div>
      <div className="contract-text" dir="auto">{signature.content_snapshot}</div>
      <div className="signed-view-meta">
        <div className="signed-view-signature">
          {isValidSignatureDataUrl(signature.signature_data_url) && (
            <img src={signature.signature_data_url} alt={`${t('ctrSignedBy')} ${signature.signer_full_name}`} />
          )}
        </div>
        <dl className="signed-view-details">
          <div><dt>{t('ctrSignedBy')}</dt><dd>{signature.signer_full_name}</dd></div>
          <div><dt>{t('ctrSignedOn')}</dt><dd><time dateTime={signature.signed_at}>{stamp}</time></dd></div>
          {signature.ip_or_user_agent && <div><dt>{t('ctrDevice')}</dt><dd dir="ltr">{signature.ip_or_user_agent}</dd></div>}
        </dl>
      </div>
      {onClose && <Button variant="secondary" size="small" onClick={onClose}>{t('ctrClose')}</Button>}
    </section>
  );
}
