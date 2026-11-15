import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import PostComments from './PostComments.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { FEED_PAGE_SIZE, createPost, deletePost, listFeed, setReaction } from '../services/communityService.js';
import { BADGES, REACTIONS, applyReaction, formatRelativeTime, mergeFeedPage } from '../services/communityUtils.js';

export default function CommunityFeed({ communityId, isCoach, refreshKey }) {
  const { locale, t } = useLocale();
  const [posts, setPosts] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('update');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [openComments, setOpenComments] = useState(() => new Set());

  async function loadFirstPage() {
    try {
      const page = await listFeed(communityId);
      setPosts(page);
      setHasMore(page.length === FEED_PAGE_SIZE);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    loadFirstPage();
  }, [communityId, refreshKey]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await listFeed(communityId, posts[posts.length - 1].created_at);
      setPosts((current) => mergeFeedPage(current, page));
      setHasMore(page.length === FEED_PAGE_SIZE);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handlePost(event) {
    event.preventDefault();
    setPostError('');
    setPosting(true);
    try {
      await createPost(communityId, { kind, body });
      setBody('');
      await loadFirstPage();
    } catch (createError) {
      setPostError(`${t('communityPostError')} ${createError.message}`);
    } finally {
      setPosting(false);
    }
  }

  async function handleReaction(post, reaction) {
    const updated = applyReaction(post, reaction);
    setPosts((current) => current.map((item) => (item.post_id === post.post_id ? updated : item)));
    try {
      await setReaction(post.post_id, updated.my_reaction);
    } catch {
      setPosts((current) => current.map((item) => (item.post_id === post.post_id ? post : item)));
    }
  }

  async function handleDelete(postId) {
    try {
      await deletePost(postId);
      setPosts((current) => current.filter((post) => post.post_id !== postId));
    } catch (deleteError) {
      setError(`${t('communityDeleteError')} ${deleteError.message}`);
    }
  }

  function toggleComments(postId) {
    setOpenComments((current) => {
      const next = new Set(current);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
  }

  const setCommentCount = (postId, count) => setPosts((current) => current.map((post) => (
    post.post_id === postId && post.comment_count !== count ? { ...post, comment_count: count } : post
  )));

  return (
    <div className="community-feed">
      <form className="panel post-composer" onSubmit={handlePost}>
        <textarea className="field intake-textarea" maxLength={1000} value={body} onChange={(event) => setBody(event.target.value)} placeholder={t('communityComposerPlaceholder')} aria-label={t('communityComposerPlaceholder')} />
        {postError && <div className="notice notice-error" role="alert">{postError}</div>}
        <div className="post-composer-actions">
          {isCoach && (
            <select className="field" value={kind} onChange={(event) => setKind(event.target.value)} aria-label={t('communityPostKind')}>
              <option value="update">{t('communityPostUpdate')}</option>
              <option value="announcement">{t('communityPostAnnouncement')}</option>
            </select>
          )}
          <Button variant="primary" size="small" type="submit" disabled={posting || !body.trim()}>{posting ? t('communityPosting') : t('communityPost')}</Button>
        </div>
      </form>

      {error && <div className="notice notice-error" role="alert">{t('communityLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && posts.length === 0 && <div className="empty-state">{t('communityEmptyFeed')}</div>}

      {posts.map((post) => {
        const badge = BADGES.find((item) => item.code === post.achievement_code);
        return (
          <article className={`panel post-card post-${post.kind}`} key={post.post_id}>
            <header className="post-header">
              <div className="avatar avatar-blue" aria-hidden="true">{post.author_name.slice(0, 1).toUpperCase()}</div>
              <div className="post-author">
                <strong>{post.author_name}</strong>
                <time dateTime={post.created_at}>{formatRelativeTime(post.created_at, locale)}</time>
              </div>
              {post.author_is_coach && <span className="soft-badge badge-blue">{t('communityCoachBadge')}</span>}
              {post.kind === 'announcement' && <span className="soft-badge">{t('communityAnnouncement')}</span>}
              {post.can_delete && <button className="text-action" type="button" onClick={() => handleDelete(post.post_id)}>{t('communityDeletePost')}</button>}
            </header>
            {badge && (
              <div className="post-achievement">
                <span className="post-achievement-icon" aria-hidden="true">{badge.icon}</span>
                <div><strong>{t(`badge_${badge.code}`)}</strong><small>{t('communityAchievementEarned')}</small></div>
              </div>
            )}
            {post.body && <p className="post-body">{post.body}</p>}
            <footer className="post-actions">
              <div className="reaction-bar" role="group" aria-label={t('communityReact')}>
                {REACTIONS.map((reaction) => (
                  <button
                    key={reaction.id}
                    type="button"
                    className={`reaction-button ${post.my_reaction === reaction.id ? 'is-active' : ''}`}
                    aria-pressed={post.my_reaction === reaction.id}
                    aria-label={t(reaction.labelKey)}
                    onClick={() => handleReaction(post, reaction.id)}
                  >
                    <span aria-hidden="true">{reaction.emoji}</span>
                    <span>{post.reactions?.[reaction.id] || 0}</span>
                  </button>
                ))}
              </div>
              <button className="text-action" type="button" aria-expanded={openComments.has(post.post_id)} onClick={() => toggleComments(post.post_id)}>
                {t('communityComments')} ({post.comment_count})
              </button>
            </footer>
            {openComments.has(post.post_id) && <PostComments postId={post.post_id} onCountChange={(count) => setCommentCount(post.post_id, count)} />}
          </article>
        );
      })}

      {hasMore && <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>{loadingMore ? t('loadingProgress') : t('communityLoadMore')}</Button>}
    </div>
  );
}
