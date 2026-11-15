import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import ProgressLineChart from './ProgressLineChart.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  deleteClientProgressPhoto,
  listClientBodyMetrics,
  listClientProgressPhotos,
  saveClientBodyMetric,
  uploadClientProgressPhoto,
} from '../services/clientProgressService.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';

export default function ClientProgressTracking({ clientId }) {
  const { locale, t } = useLocale();
  const today = getLocalDateString();
  const [metrics, setMetrics] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [metricLoading, setMetricLoading] = useState(true);
  const [photoLoading, setPhotoLoading] = useState(true);
  const [metricLoadError, setMetricLoadError] = useState('');
  const [photoLoadError, setPhotoLoadError] = useState('');
  const [metricError, setMetricError] = useState('');
  const [metricSuccess, setMetricSuccess] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [photoSuccess, setPhotoSuccess] = useState('');
  const [savingMetric, setSavingMetric] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [deletingPath, setDeletingPath] = useState('');
  const [form, setForm] = useState({ measuredOn: today, weight_kg: '', body_fat_percentage: '', notes: '' });

  async function refreshMetrics() {
    setMetricLoading(true);
    setMetricLoadError('');
    try {
      setMetrics(await listClientBodyMetrics());
    } catch (error) {
      setMetricLoadError(error.message);
    } finally {
      setMetricLoading(false);
    }
  }

  async function refreshPhotos() {
    setPhotoLoading(true);
    setPhotoLoadError('');
    try {
      setPhotos(await listClientProgressPhotos(clientId));
    } catch (error) {
      setPhotoLoadError(error.message);
    } finally {
      setPhotoLoading(false);
    }
  }

  useEffect(() => {
    refreshMetrics();
    refreshPhotos();
  }, [clientId]);

  async function handleSaveMetric(event) {
    event.preventDefault();
    setMetricError('');
    setMetricSuccess('');
    setSavingMetric(true);
    try {
      await saveClientBodyMetric(form);
      setMetricSuccess(t('measurementSaved'));
      setForm((current) => ({ ...current, weight_kg: '', body_fat_percentage: '', notes: '' }));
      await refreshMetrics();
    } catch (error) {
      setMetricError(`${t('measurementSaveError')} ${error.message}`);
    } finally {
      setSavingMetric(false);
    }
  }

  async function handlePhotoSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhotoError('');
    setPhotoSuccess('');
    setUploadingPhoto(true);
    try {
      await uploadClientProgressPhoto(clientId, file);
      setPhotoSuccess(t('photoUploaded'));
      await refreshPhotos();
    } catch (error) {
      setPhotoError(`${t('photoUploadError')} ${error.message}`);
    } finally {
      setUploadingPhoto(false);
      event.target.value = '';
    }
  }

  async function handleDeletePhoto(objectPath) {
    setDeletingPath(objectPath);
    setPhotoError('');
    setPhotoSuccess('');
    try {
      await deleteClientProgressPhoto(objectPath);
      setPhotos((current) => current.filter((photo) => photo.path !== objectPath));
      setPhotoSuccess(t('photoDeleted'));
    } catch (error) {
      setPhotoError(`${t('photoDeleteError')} ${error.message}`);
    } finally {
      setDeletingPath('');
    }
  }

  return (
    <div className="client-progress-layout">
      <section className="panel client-metrics-panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('progressTracking')}</span><h3>{t('bodyMetrics')}</h3></div></div>
        <form className="client-metric-form" onSubmit={handleSaveMetric}>
          <label className="form-label">{t('measurementDate')}<input className="field" type="date" value={form.measuredOn} max={today} onChange={(event) => setForm((current) => ({ ...current, measuredOn: event.target.value }))} required /></label>
          <div className="form-grid">
            <label className="form-label">{t('weightKg')}<input className="field" type="number" min="0.1" max="500" step="0.1" value={form.weight_kg} onChange={(event) => setForm((current) => ({ ...current, weight_kg: event.target.value }))} /></label>
            <label className="form-label">{t('bodyFatPercentage')}<input className="field" type="number" min="0" max="100" step="0.1" value={form.body_fat_percentage} onChange={(event) => setForm((current) => ({ ...current, body_fat_percentage: event.target.value }))} /></label>
          </div>
          <label className="form-label">{t('notes')}<input className="field" maxLength={500} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} /></label>
          {metricError && <div className="notice notice-error" role="alert">{metricError}</div>}
          {metricSuccess && <div className="notice notice-info" role="status">{metricSuccess}</div>}
          <Button variant="primary" type="submit" disabled={savingMetric}>{savingMetric ? t('savingMeasurement') : t('saveMeasurement')}</Button>
        </form>
        {metricLoadError && <div className="notice notice-error" role="alert">{t('measurementLoadError')} {metricLoadError}</div>}
        {metricLoading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!metricLoading && metrics.length === 0 && <div className="empty-state">{t('noMeasurements')}</div>}
        {!metricLoading && metrics.length > 0 && (
          <div className="progress-charts">
            <ProgressLineChart data={metrics} field="weight_kg" title={t('weightProgress')} color="#64a8ff" unit=" kg" />
            <ProgressLineChart data={metrics} field="body_fat_percentage" title={t('bodyFatProgress')} color="#51d2bd" unit="%" />
          </div>
        )}
      </section>

      <section className="panel client-photos-panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('progressTracking')}</span><h3>{t('progressPhotos')}</h3></div></div>
        <p className="muted-copy">{t('photoPrivacy')}</p>
        <label className={`button button-secondary photo-upload-button ${uploadingPhoto ? 'is-disabled' : ''}`}>
          {uploadingPhoto ? t('uploadingPhoto') : t('selectProgressPhoto')}
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploadingPhoto} onChange={handlePhotoSelection} />
        </label>
        {photoError && <div className="notice notice-error" role="alert">{photoError}</div>}
        {photoSuccess && <div className="notice notice-info" role="status">{photoSuccess}</div>}
        {photoLoadError && <div className="notice notice-error" role="alert">{t('photoLoadError')} {photoLoadError}</div>}
        {photoLoading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!photoLoading && photos.length === 0 && <div className="empty-state">{t('noProgressPhotos')}</div>}
        {!photoLoading && photos.length > 0 && (
          <div className="progress-photo-grid">
            {photos.map((photo) => (
              <article className="progress-photo-card" key={photo.path}>
                <a href={photo.signedUrl} target="_blank" rel="noreferrer">
                  <img src={photo.signedUrl} alt={t('progressPhotoAlt')} loading="lazy" />
                </a>
                <div><time dateTime={photo.created_at}>{new Date(photo.created_at).toLocaleDateString(locale)}</time>
                  <button className="text-action" type="button" disabled={deletingPath === photo.path} onClick={() => handleDeletePhoto(photo.path)}>{deletingPath === photo.path ? t('deletingPhoto') : t('deletePhoto')}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
