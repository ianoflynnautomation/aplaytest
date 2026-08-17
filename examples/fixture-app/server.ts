/**
 * A deliberately tiny app for testing atest itself.
 *
 * It exists because the gate cannot be tested without one. `examples/smoke`
 * uses `page.setContent` and never touches the network, so every mutant is a
 * no-op there — which is why CI could only prove the gate RESTORES the spec,
 * never that it KILLS anything. `examples/bjjeire-live` has a real API but
 * needs a running minikube, so it cannot run in CI or on a fresh clone.
 *
 * Two properties are deliberate:
 *
 *   FILTERING IS SERVER-SIDE. The `unfiltered` mutant works by stripping the
 *   query string and re-requesting, so a client that fetches everything and
 *   filters in the browser survives it untouched. Measured against the real
 *   BjjEire app, that is exactly what happened — a correct search test
 *   survived `unfiltered` because the narrowing never depended on the server.
 *   Here the server does the filtering, so the mutant has something to break.
 *
 *   THE DATASET IS FIXED. Gate outcomes become reproducible: "did `unfiltered`
 *   kill this?" has one answer on every machine, rather than depending on
 *   whatever the live environment currently holds.
 *
 * Zero dependencies, no build step, no container. It must stay dumb — a
 * fixture that grows toward being a replica of the real app becomes a second
 * thing to maintain, and drifts, and then a green run here stops meaning
 * anything about there.
 */

import { createServer, type Server } from 'node:http';

export interface Gym {
  readonly name: string;
  readonly county: string;
}

/** Fixed on purpose. Changing it changes gate outcomes — treat as a contract. */
export const GYMS: readonly Gym[] = [
  { name: '011 Grappling', county: 'Cork' },
  { name: 'Blackwater Valley BJJ', county: 'Cork' },
  { name: 'Harbour City Jiu-Jitsu', county: 'Cork' },
  { name: 'Liffey Grappling Club', county: 'Dublin' },
  { name: 'Northside Mat Room', county: 'Dublin' },
  { name: 'Shannon Submission Academy', county: 'Limerick' },
];

export function filterGyms(query: URLSearchParams): Gym[] {
  const q = (query.get('q') ?? '').trim().toLowerCase();
  const county = (query.get('county') ?? '').trim().toLowerCase();

  return GYMS.filter(gym => {
    if (q !== '' && !gym.name.toLowerCase().includes(q)) return false;
    if (county !== '' && gym.county.toLowerCase() !== county) return false;
    return true;
  });
}

/**
 * The page fetches and renders; it does not filter.
 *
 * Keeping the browser dumb is what makes `unfiltered` meaningful: the only
 * thing that narrows the list is the request, so breaking the request breaks
 * the list.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Gyms</title></head>
<body>
<main>
  <h1 data-testid="gyms-page-header">Gyms</h1>
  <div data-testid="gyms-page-search">
    <input data-testid="search-input" placeholder="Search gyms" />
  </div>
  <select data-testid="county-filter">
    <option value="">All counties</option>
    <option value="Cork">Cork</option>
    <option value="Dublin">Dublin</option>
    <option value="Limerick">Limerick</option>
  </select>
  <ul data-testid="gyms-list"></ul>
  <p data-testid="gyms-empty-state" hidden>No gyms match your search.</p>
  <p data-testid="gyms-error-state" hidden>Something went wrong.</p>
</main>
<script>
  const list = document.querySelector('[data-testid="gyms-list"]');
  const empty = document.querySelector('[data-testid="gyms-empty-state"]');
  const errored = document.querySelector('[data-testid="gyms-error-state"]');
  const search = document.querySelector('[data-testid="search-input"]');
  const county = document.querySelector('[data-testid="county-filter"]');

  async function load() {
    const params = new URLSearchParams();
    if (search.value) params.set('q', search.value);
    if (county.value) params.set('county', county.value);

    list.replaceChildren();
    empty.hidden = true;
    errored.hidden = true;

    let payload;
    try {
      const response = await fetch('/api/gyms?' + params.toString());
      if (!response.ok) throw new Error('http ' + response.status);
      payload = await response.json();
    } catch {
      errored.hidden = false;
      return;
    }

    const items = payload.items ?? [];
    if (items.length === 0) { empty.hidden = false; return; }

    for (const gym of items) {
      const li = document.createElement('li');
      li.dataset.testid = 'gyms-list-item';

      const name = document.createElement('h2');
      name.dataset.testid = 'gym-card-name';
      name.textContent = gym.name;

      const where = document.createElement('span');
      where.dataset.testid = 'gym-card-county';
      where.textContent = gym.county;

      li.append(name, where);
      list.append(li);
    }
  }

  // Read the initial query off the URL so a test can deep-link to a filtered
  // view, the same shape a real single-page app uses.
  const initial = new URLSearchParams(location.search);
  search.value = initial.get('q') ?? '';
  county.value = initial.get('county') ?? '';

  search.addEventListener('input', load);
  county.addEventListener('change', load);
  load();
</script>
</body>
</html>`;

export function createFixtureApp(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/gyms') {
      const items = filterGyms(url.searchParams);
      res.writeHead(200, {
        'content-type': 'application/json',
        // No caching: a mutant re-requests the same path with the query
        // stripped, and a cached response would mask the difference.
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ items, total: items.length }));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/gyms') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

export async function startFixtureApp(port: number): Promise<Server> {
  const server = createFixtureApp();
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  // Do not hold the process open. Playwright starts this from globalSetup and
  // expects to exit when the run ends; a referenced handle hangs the runner.
  server.unref();
  return server;
}
