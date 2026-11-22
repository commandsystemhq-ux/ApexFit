import { createFoodCache, searchFoods } from '../api/_lib/foodSearch.js';

// `npm run dev` only serves the web app, so /api/food-search would answer with the index page and the food search
// would say "not available". This plugin answers that one address from the same code the Vercel function uses.
// It exists only in the dev server (`apply: 'serve'`): it is not part of the build and is not a deployed endpoint.
// There is no sign-in check here because it never runs in production; USDA_API_KEY (optional) is read from `.env`.
export function devFoodSearch({ usdaKey = '', fetchImpl } = {}) {
  const cache = createFoodCache();
  return {
    name: 'apexfit-dev-food-search',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/food-search', async (req, res) => {
        const send = (status, body) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'GET') return send(405, { error: 'Method not allowed.' });
        try {
          const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
          const { items, cached } = await searchFoods(query, { cache, usdaKey, ...(fetchImpl ? { fetchImpl } : {}) });
          return send(200, { items, cached });
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 500;
          return send(status, { error: status === 500 ? 'Unexpected server error.' : error.message });
        }
      });
    },
  };
}
