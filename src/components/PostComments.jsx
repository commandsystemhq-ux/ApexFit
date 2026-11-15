import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { addComment, deleteComment, listComments } from '../services/communityService.js';
import { formatRelativeTime } from '../services/communityUtils.js';

export default function PostComments({ postId, onCountChange }) {
  const { locale, t } = useLocale();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const rows = await listComments(postId);
      setComments(rows);
      onCountChange(rows.length);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [postId]);

  async function handleSubmit(event) {
    event.preventDefault();
    setSending(true);
    setError('');
    try {
      await addComment(postId, body);
      setBody('');
      await refresh();
    } catch (sendError) {
      setError(`${t('communityCommentError')} ${sendError.message}`);
    } finally {
      setSending(false);
    }
  }

  async function handleDelete(commentId) {
    try {
      await deleteComment(commentId);
      await refresh();
    } catch (deleteError) {
      setError(`${t('communityDeleteError')} ${deleteError.message}`);
    }
  }

  return (
    <div className="post-comments">
      {loading && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
      {!loading && comments.length === 0 && <p className="muted-copy">{t('communityNoComments')}</p>}
      {comments.map((comment) => (
        <div className="comment-row" key={comment.comment_id}>
          <div className="avatar avatar-blue" aria-hidden="true">{comment.author_name.slice(0, 1).toUpperCase()}</div>
          <div className="comment-body">
            <div className="comment-meta">
              <strong>{comment.author_name}</strong>
              {comment.author_is_coach && <span className="soft-badge badge-blue">{t('communityCoachBadge')}</span>}
              <time dateTime={comment.created_at}>{formatRelativeTime(comment.created_at, locale)}</time>
            </div>
            <p>{comment.body}</p>
          </div>
          {comment.can_delete && <button className="text-action" type="button" onClick={() => handleDelete(comment.comment_id)}>{t('communityDeleteComment')}</button>}
        </div>
      ))}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <form className="comment-form" onSubmit={handleSubmit}>
        <input className="field" value={body} maxLength={500} onChange={(event) => setBody(event.target.value)} placeholder={t('communityCommentPlaceholder')} aria-label={t('communityCommentPlaceholder')} />
        <Button variant="secondary" size="small" type="submit" disabled={sending || !body.trim()}>{t('communityAddComment')}</Button>
      </form>
    </div>
  );
}
