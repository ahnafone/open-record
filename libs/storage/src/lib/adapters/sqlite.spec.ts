import { SqlConnection, SqliteBackend } from './sqlite';

/**
 * Models one shared connection: only one transaction may be open at a time,
 * and a statement that opens its own transaction fails while another is open.
 */
function sharedConnection() {
  let open = false;
  const rows = new Map<string, string>();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const conn = {
    rows,
    async query() {
      await tick();
      return { values: [] };
    },
    async run(_sql: string, values?: unknown[], transaction?: boolean) {
      if (transaction !== false && open) throw new Error('nested transaction');
      await tick();
      rows.set(String(values?.[0]), String(values?.[1]));
      return {};
    },
    async execute() {
      await tick();
      return {};
    },
    async beginTransaction() {
      if (open) throw new Error('transaction already open');
      open = true;
      await tick();
    },
    async commitTransaction() {
      await tick();
      open = false;
    },
    async rollbackTransaction() {
      await tick();
      open = false;
    },
    async close() {
      await tick();
    },
  };
  return conn as typeof conn & SqlConnection;
}

describe('SQLite storage', () => {
  it('keeps every write when putMany and put overlap on one connection', async () => {
    const conn = sharedConnection();
    const backend = new SqliteBackend(conn);
    const results = await Promise.allSettled([
      backend.putMany('settings', [
        ['a', 1],
        ['b', 2],
      ]),
      backend.putMany('settings', [['c', 3]]),
      backend.put('settings', 'solo', 4),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect([...conn.rows.keys()].sort()).toEqual(['a', 'b', 'c', 'solo']);
  });
});
