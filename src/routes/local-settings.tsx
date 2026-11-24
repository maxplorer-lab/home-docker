/** @jsxImportSource hono/jsx */
// ─── Local settings (SQLite build) ──────────────────────────────
// The Cloudflare build's /settings spans every module (WAY quiet hours, the
// tracking grid, Laoka links). This build hosts Sompitra only, so the page
// keeps what still exists: the account, the password, and the way out.
//
// It lives under src/ on purpose: tsx only applies this project's automatic
// JSX runtime (`jsx: react-jsx` → hono/jsx) to files the tsconfig includes,
// and a .tsx under server/ was compiled as classic JSX (`React is not
// defined`). Keeping it here also puts it inside `npm run check`.
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import type { Env, User } from '../db/schema'

const settings = new Hono<{ Bindings: Env; Variables: { user: User } }>()
settings.use('*', requireAuth)

settings.get('/', (c) => {
  const user = c.get('user')

  return c.html(
    <Layout title="You" user={user} activeTab="settings">
      <h2 class="section-title mb-4">You</h2>

      <Card title="Account" icon="you">
        <div class="ledger">
          <div class="flex items-baseline justify-between gap-3 py-2.5">
            <span class="t-label">Signed in as</span>
            <span class="t-value">{user.username}</span>
          </div>
          <div class="flex items-baseline justify-between gap-3 py-2.5">
            <span class="t-label">Display name</span>
            <span class="t-value">{user.display_name || user.username}</span>
          </div>
          <div class="flex items-baseline justify-between gap-3 py-2.5">
            <span class="t-label">Role</span>
            <span class="t-value">{user.is_admin ? 'Admin' : 'Member'}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-2 mt-4">
          <a href="/change-password" class="px-4 py-2 rounded-xl text-sm font-semibold"
            style={{ backgroundColor: 'var(--accent-ink)', color: '#fff' }}>
            Change password
          </a>
          <a href="/logout" class="px-4 py-2 rounded-xl text-sm font-semibold border"
            style={{ borderColor: 'var(--rule)', color: 'var(--ink)' }}>
            Log out
          </a>
        </div>
      </Card>

      <Card title="This build" icon="house" className="mt-4">
        <p class="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
          This container runs the Sompitra finance suite — Budget, Kiné, Debts,
          Sales and the medicine cupboard — on two SQLite files in its data
          volume. WAY, Laoka and the family chat are not part of this build.
        </p>
      </Card>
    </Layout>
  )
})

export default settings
