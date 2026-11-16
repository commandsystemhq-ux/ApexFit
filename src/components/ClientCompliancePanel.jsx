import { useEffect, useState } from 'react';
import AssessmentSummary from './AssessmentSummary.jsx';
import SignedContractView from './SignedContractView.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getClientAssessment } from '../services/assessmentService.js';
import { getSignature, listContracts, listSignaturesForClient } from '../services/contractService.js';
import { contractStatuses } from '../services/contractUtils.js';

// Inside a client's row on the coach's Clients page: health assessment summary and contract signatures.
export default function ClientCompliancePanel({ clientId }) {
  const { t, locale } = useLocale();
  const [state, setState] = useState({ status: 'loading', assessment: null, contracts: [], error: '' });
  const [viewing, setViewing] = useState(null);
  const [viewError, setViewError] = useState('');

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', assessment: null, contracts: [], error: '' });
    Promise.all([getClientAssessment(clientId), listContracts(), listSignaturesForClient(clientId)])
      .then(([assessment, contracts, signatures]) => {
        if (!active) return;
        const visible = contracts.filter((contract) => !contract.is_archived || signatures.some((item) => item.contract_id === contract.id));
        setState({ status: 'ready', assessment, contracts: contractStatuses(visible, signatures), error: '' });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', assessment: null, contracts: [], error: error.message });
      });
    return () => { active = false; };
  }, [clientId]);

  async function view(contractId) {
    setViewError('');
    try {
      setViewing(await getSignature(contractId, clientId));
    } catch (error) {
      setViewError(`${t('ctrViewError')} ${error.message}`);
    }
  }

  if (state.status === 'loading') return <p className="muted-copy" role="status">{t('loadingProgress')}</p>;
  if (state.status === 'error') return <div className="notice notice-error" role="alert">{state.error}</div>;

  return (
    <div className="compliance-panel">
      <h4>{t('asmSummaryTitle')}</h4>
      <AssessmentSummary assessment={state.assessment} />

      {state.contracts.length > 0 && (
        <>
          <h4>{t('navContracts')}</h4>
          <ul className="compliance-contracts">
            {state.contracts.map((contract) => (
              <li key={contract.id}>
                <span>{contract.title}</span>
                {contract.signed ? (
                  <>
                    <span className="soft-badge badge-green">{t('ctrStatusSigned')}</span>
                    <small>{new Date(contract.signed_at).toLocaleDateString(locale)}</small>
                    <button className="text-action" type="button" onClick={() => view(contract.id)}>{t('ctrViewSigned')}</button>
                  </>
                ) : (
                  <span className={`soft-badge ${contract.is_required_on_onboarding ? 'badge-amber' : 'badge-muted'}`}>{t('ctrStatusPending')}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {viewError && <div className="notice notice-error" role="alert">{viewError}</div>}
      {viewing && <SignedContractView signature={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
