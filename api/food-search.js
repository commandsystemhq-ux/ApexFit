import { authenticate, requireRole } from './_lib/auth.js';
import { createFoodCache, searchFoods } from './_lib/foodSearch.js';
import { HttpError, handler } from './_lib/http.js';
import { createRateLimiter } from './_lib/jackAgent.js';

const allowRequest = createRateLimiter({ limit: 40, windowMs: 60_000 });
const cache = createFoodCache();

// Food lookup for the Food logger: ?q=<name> or ?barcode=<digits>, plus &lang=ar|en. Open Food Facts needs no
// secret; the proxy exists so the browser never calls a third party, results are cached briefly, and a slow
// answer is cut off after 5 seconds. Only signed-in clients can use it.
export default handler(['GET'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  if (!allowRequest(user.id)) throw new HttpError(429, 'Too many requests. Wait a moment.');
  await requireRole(userClient, 'client');

  const { items, cached } = await searchFoods(req.query || {}, { cache });
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.status(200).json({ items, cached });
});
