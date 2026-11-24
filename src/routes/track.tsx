/** @jsxImportSource hono/jsx */
// ─── Live tracking (SQLite build) ───────────────────────────────
// The Cloudflare build draws WAY's map and its whole dashboard. This container
// hosts Sompitra, so the tracking surface is deliberately small: the devices
// that have reported, their latest fix, and a socket that updates the cards
// without a page refresh. The wire protocol is the one W.A.Y already uses
// (`snapshot` on connect, `position` per accepted ping), so the heavy map can
// be layered on later without changing the server.
import { Hono } from 'hono'
import { Layout } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import type { Env, User } from '../db/schema'

const track = new Hono<{ Bindings: Env; Variables: { user: User } }>()
track.use('*', requireAuth)

track.get('/', (c) => {
  const user = c.get('user')

  return c.html(
    <Layout title="Live tracking" user={user} activeTab="dashboard">
      <div class="flex items-start justify-between gap-3 mb-4">
        <div class="min-w-0">
          <h2 class="section-title">Live tracking</h2>
          <p class="t-micro mt-1">
            Positions from μlogger, as they arrive. This page never refreshes itself.
          </p>
        </div>
        <span id="live-state" class="t-micro shrink-0" aria-live="polite">Connecting…</span>
      </div>

      <div id="live-devices" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"></div>

      <p id="live-empty" class="t-micro text-center py-10" hidden>
        No device has reported yet. Point μlogger at <span class="font-mono">/ulogger</span> with a
        Home username and password.
      </p>

      <noscript>
        <p class="t-micro text-center py-6">
          This page needs JavaScript for the live connection. The positions are still stored, and
          the history is in the database.
        </p>
      </noscript>

      <p class="t-micro mt-6">
        The phone authenticates once at <span class="font-mono">/ulogger</span>, then uploads fixes.
        A fix the server filters (poor accuracy, an impossible jump, a parked-phone speed claim)
        is still acknowledged to the phone, so the device never retries it.
      </p>

      <script src="/shared/track.js" defer />
    </Layout>
  )
})

export default track
