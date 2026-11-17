import { getAvatarUrl } from '../services/profileService.js';
import { initialOf } from '../services/chatUtils.js';

export default function ChatAvatar({ name, avatarPath }) {
  const url = getAvatarUrl(avatarPath);
  return (
    <span className="avatar avatar-blue chat-avatar" aria-hidden="true">
      {url ? <img className="avatar-image" src={url} alt="" /> : initialOf(name)}
    </span>
  );
}
