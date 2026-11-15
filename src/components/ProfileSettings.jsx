import { useEffect, useRef, useState } from 'react';
import Button from './Button.jsx';
import UserAvatar from './UserAvatar.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { removeAvatar, updateAccountDetails, updateMyProfile, uploadAvatar } from '../services/profileService.js';
import { NAME_MAX_LENGTH, normalizeProfileForm, validateAvatarFile } from '../services/profileUtils.js';

function formFromAccount(user, profile) {
  return {
    fullName: profile?.full_name || user?.user_metadata?.full_name || '',
    brandName: profile?.brand_name || '',
    email: user?.email || '',
  };
}

export default function ProfileSettings() {
  const { t } = useLocale();
  const showToast = useToast();
  const { user, profile, setProfile } = useAuth();
  const isCoach = profile?.role === 'coach';
  const fileInput = useRef(null);
  const [form, setForm] = useState(() => formFromAccount(user, profile));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm(formFromAccount(user, profile));
  }, [user?.email, profile?.full_name, profile?.brand_name]);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const fieldError = (field) => errors[field] && <span className="field-error" role="alert">{t(errors[field])}</span>;

  async function handleAvatarChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = validateAvatarFile(file);
    if (problem) {
      setError(t(problem));
      return;
    }
    setAvatarBusy(true);
    setError('');
    try {
      setProfile(await uploadAvatar({ userId: user.id, file, profile }));
      showToast(t('avatarUpdated'));
    } catch (uploadError) {
      setError(`${t('avatarUploadError')} ${uploadError.message}`);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleAvatarRemove() {
    setAvatarBusy(true);
    setError('');
    try {
      setProfile(await removeAvatar({ profile }));
      showToast(t('avatarRemoved'));
    } catch (removeError) {
      setError(`${t('avatarUploadError')} ${removeError.message}`);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const { values, errors: nextErrors, valid } = normalizeProfileForm(form, profile.role);
    setErrors(nextErrors);
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      const updated = await updateMyProfile({
        fullName: values.fullName,
        brandName: values.brandName,
        avatarPath: profile.avatar_path,
      });
      setProfile(updated);
      const { emailChanged } = await updateAccountDetails({
        email: values.email,
        fullName: values.fullName,
        currentEmail: user.email,
      });
      showToast(emailChanged ? t('profileEmailConfirmation') : t('profileSaved'));
    } catch (saveError) {
      setError(`${t('profileSaveError')} ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-panel" aria-labelledby="profile-settings-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{isCoach ? t('coach') : t('account')}</span>
          <h3 id="profile-settings-title">{isCoach ? t('coachProfileTitle') : t('profileTitle')}</h3>
        </div>
      </div>
      <p className="settings-help">{isCoach ? t('coachProfileHelp') : t('profileHelp')}</p>
      <div className="avatar-editor">
        <UserAvatar user={user} profile={profile} size="large" />
        <div className="avatar-editor-actions">
          <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleAvatarChange} tabIndex={-1} aria-hidden="true" />
          <Button variant="secondary" size="small" type="button" disabled={avatarBusy} onClick={() => fileInput.current?.click()}>
            {avatarBusy ? t('avatarUploading') : profile?.avatar_path ? t('avatarChange') : t('avatarChoose')}
          </Button>
          {profile?.avatar_path && !avatarBusy && (
            <button className="text-action" type="button" onClick={handleAvatarRemove}>{t('avatarRemove')}</button>
          )}
          <span className="settings-help">{t('avatarHelp')}</span>
        </div>
      </div>
      <form className="profile-form" onSubmit={handleSubmit} noValidate>
        <label className="form-label">{t('authFullName')}
          <input className="field" autoComplete="name" maxLength={NAME_MAX_LENGTH} value={form.fullName} onChange={update('fullName')} />
          {fieldError('fullName')}
        </label>
        {isCoach && (
          <label className="form-label">{t('brandName')}
            <input className="field" maxLength={NAME_MAX_LENGTH} value={form.brandName} onChange={update('brandName')} placeholder={t('brandNamePlaceholder')} />
            {fieldError('brandName')}
          </label>
        )}
        <label className="form-label">{t('authEmail')}
          <input className="field" type="email" autoComplete="email" value={form.email} onChange={update('email')} />
          {fieldError('email')}
        </label>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div><Button variant="primary" type="submit" disabled={saving || avatarBusy}>{saving ? t('profileSaving') : t('profileSave')}</Button></div>
      </form>
    </section>
  );
}
