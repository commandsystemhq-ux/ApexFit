import { getAvatarUrl } from '../services/profileService.js';
import { displayNameFor } from '../services/profileUtils.js';

export default function UserAvatar({ user, profile, size = '' }) {
  const url = getAvatarUrl(profile?.avatar_path);
  const initial = displayNameFor(profile, user).slice(0, 1).toUpperCase() || '?';
  return (
    <span className={`avatar avatar-blue ${size ? `avatar-${size}` : ''}`}>
      {url ? <img className="avatar-image" src={url} alt="" /> : initial}
    </span>
  );
}
