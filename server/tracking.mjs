// ─── Tracking on SQLite ─────────────────────────────────────────
// The Worker's FleetDO keeps MotionState, pending_sync and chat scrollback in
// its own SQLite and flushes to D1 nightly. The container has no DO, so this
// module keeps the SAME state machine and the SAME intake gates and writes
// straight through: an accepted ping is broadcast live, and becomes a
// `gps_pings` row only when the state machine says it is history (outside
// every fence and not stationary). There is no pending_sync buffer and no
// nightly flush.
//
// What is deliberately identical to src/way/do/FleetDO.ts:
//   * accuracy -> isGlitch -> reported-speed correction -> processPing, in
//     that order (a nonexistent measurement cannot be asked about speed);
//   * a drop still answers success to μlogger;
//   * an unwitnessed crossing moves the live dot but writes no history row;
//   * the persistence throttle: only a point that is outside every fence and
//     NOT stationary becomes history (`!isInside && !isStationary`). A parked
//     phone inside the house still moves the live dot, but writes nothing --
//     which is what stops two-second uploads from filling the file with a
//     desk's worth of fixes;
//   * device_state updates on every accepted ping, even one not persisted.
//
// What is container-only:
//   * `device_state` lives in the WAY database as a table (the DO keeps it in
//     its private storage; production D1 has no such table);
//   * no chat, notifications or approach pulses. Those belong to the full
//     Cloudflare build; this container reports positions.

import {
  accuracyIsAcceptable,
  initialMotionState,
  isGlitch,
  processPing,
  reportedSpeedIsCredible,
  speedFromPositions,
} from '../src/way/lib/state-machine'
import { WAY_CONFIG } from '../src/way/config'

const STATE_TABLE = `
  CREATE TABLE IF NOT EXISTS device_state (
    device_id  TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

/** Rows from `geofences` (snake_case) in the shape processPing expects. */
function toGeofence(row) {
  return {
    name: row.name,
    displayName: row.display_name,
    category: row.category,
    lat: row.lat,
    lon: row.lon,
    radiusM: row.radius_m,
    exitRadiusM: row.exit_radius_m,
  }
}

function emptyState() {
  return {
    motion: initialMotionState(),
    forcedMode: null,
    recordingPaused: false,
    lastStatus: null,
    exitBuffer: [],
  }
}

function parseState(row) {
  if (!row?.state_json) return emptyState()
  try {
    const parsed = JSON.parse(row.state_json)
    return {
      motion: { ...initialMotionState(), ...(parsed.motion || {}) },
      forcedMode: parsed.forcedMode === 'driving' || parsed.forcedMode === 'walking' ? parsed.forcedMode : null,
      recordingPaused: parsed.recordingPaused === true,
      lastStatus: parsed.lastStatus || null,
      exitBuffer: Array.isArray(parsed.exitBuffer) ? parsed.exitBuffer : [],
    }
  } catch {
    // A corrupt state row must not stop the phone: start fresh at this ping.
    return emptyState()
  }
}

export async function createTracking(env) {
  const db = env.WAY_DB
  let broadcast = () => {}

  await db.prepare(STATE_TABLE).run()

  async function loadState(deviceId) {
    const row = await db
      .prepare('SELECT state_json FROM device_state WHERE device_id = ?1')
      .bind(deviceId)
      .first()
    return parseState(row)
  }

  async function saveState(deviceId, state) {
    await db
      .prepare(
        `INSERT INTO device_state (device_id, state_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(device_id) DO UPDATE SET state_json = ?2, updated_at = ?3`
      )
      .bind(deviceId, JSON.stringify(state), new Date().toISOString())
      .run()
  }

  async function loadGeofences() {
    try {
      const { results } = await db
        .prepare('SELECT * FROM geofences ORDER BY category, display_name')
        .all()
      return (results || []).map(toGeofence)
    } catch {
      // A database built without WAY's geofences still tracks; every point is
      // simply outside every fence.
      return []
    }
  }

  async function insertPing(deviceId, point) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO gps_pings
          (device_id, timestamp, latitude, longitude, altitude, speed, speed_avg_30s,
           is_inside_geofence, geofence_name, is_driving, distance_km, is_stationary,
           is_keep_alive, battery, accuracy, leg_id, sync_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
      )
      .bind(
        deviceId,
        point.timestamp,
        point.latitude,
        point.longitude,
        point.altitude ?? null,
        point.speed ?? null,
        point.speedAvg ?? null,
        point.isInside ? 1 : 0,
        point.geofenceName ?? null,
        point.isDriving ? 1 : 0,
        point.distance ?? 0,
        point.isStationary ? 1 : 0,
        0,
        null,
        point.accuracy ?? null,
        point.legId ?? null,
        crypto.randomUUID()
      )
      .run()
  }

  async function ingest(body) {
    try {
      const { ping, accuracy, altitude } = body

      // Same order as FleetDO.handleIngest: accuracy, then the reported-speed
      // corrections, then the position glitch gate, then the state machine.
      if (!accuracyIsAcceptable(accuracy)) {
        return { ok: true, accepted: false, reason: 'accuracy' }
      }

      const stored = await loadState(ping.deviceId)
      const prev = stored.motion

      const reportedVel = ping.vel
      if (
        reportedVel !== null && reportedVel !== undefined &&
        (!Number.isFinite(reportedVel) || reportedVel > WAY_CONFIG.PRE_FILTER_SPEED_LIMIT)
      ) {
        ping.vel = null
      }

      if (
        ping.vel !== null && ping.vel !== undefined &&
        prev.lastLat !== null && prev.lastLon !== null && prev.lastTs !== null &&
        !reportedSpeedIsCredible(
          prev.lastLat, prev.lastLon, prev.lastTs,
          ping.latitude, ping.longitude, ping.timestamp
        )
      ) {
        // Replaced, never nulled: the device is real and merely parked, and a
        // null would read as "no signal" in every speed readout.
        ping.vel = speedFromPositions(
          prev.lastLat, prev.lastLon, prev.lastTs,
          ping.latitude, ping.longitude, ping.timestamp
        )
      }

      if (
        prev.lastLat !== null && prev.lastLon !== null && prev.lastTs !== null &&
        isGlitch(
          prev.lastLat, prev.lastLon, prev.lastTs,
          ping.latitude, ping.longitude, ping.timestamp
        )
      ) {
        return { ok: true, accepted: false, reason: 'glitch' }
      }

      const geofences = await loadGeofences()
      const { state: newMotion, result } = processPing(
        stored.motion, ping, geofences, stored.forcedMode
      )

      const unwitnessed = result.unwitnessed === true
      // Same rule as FleetDO.shouldPersistTrackPoint. The live frame below is
      // separate: it fires for every accepted ping, so the dot moves even when
      // there is no history point.
      const shouldPersist = !unwitnessed && !stored.recordingPaused &&
        !result.isInside && !result.isStationary

      // The fence-edge point is a real point on the outgoing track. Write it
      // first, exactly as the DO does, so a departure starts at the boundary
      // rather than at the first ping past it.
      if (result.edgePoint && shouldPersist) {
        await insertPing(ping.deviceId, {
          timestamp: result.edgePoint.timestamp,
          latitude: result.edgePoint.latitude,
          longitude: result.edgePoint.longitude,
          altitude,
          speed: ping.vel ?? null,
          speedAvg: result.speedAvg,
          isInside: false,
          geofenceName: null,
          isDriving: result.edgePoint.isDriving,
          distance: 0,
          isStationary: false,
          legId: result.legId ?? null,
          accuracy,
        })
      }

      if (shouldPersist) {
        await insertPing(ping.deviceId, {
          timestamp: ping.timestamp,
          latitude: ping.latitude,
          longitude: ping.longitude,
          altitude,
          speed: ping.vel ?? null,
          speedAvg: result.speedAvg,
          isInside: result.isInside,
          geofenceName: result.geofenceName,
          isDriving: result.isDriving,
          distance: result.distance,
          isStationary: result.isStationary,
          legId: result.legId ?? null,
          accuracy,
        })
      }

      const lastStatus = {
        ...result,
        timestamp: ping.timestamp,
        latitude: ping.latitude,
        longitude: ping.longitude,
        // The raw instantaneous speed, distinct from the smoothed speedAvg.
        speed: ping.vel ?? null,
        accuracy,
      }

      // device_state moves on every accepted ping, persisted or not: pause and
      // the throttle hide HISTORY, never the live dot.
      await saveState(ping.deviceId, {
        motion: newMotion,
        forcedMode: stored.forcedMode,
        recordingPaused: stored.recordingPaused,
        lastStatus,
        exitBuffer: [],
      })

      broadcast({
        type: 'position',
        deviceId: ping.deviceId,
        ...lastStatus,
        guarding: newMotion.geoState === 'EXITING',
        stored: shouldPersist,
      })

      return { ok: true, accepted: true, stored: shouldPersist }
    } catch (err) {
      // A real failure (as opposed to a filter drop) must be visible to the
      // caller; μlogger's contract is only that FILTERED pings answer success.
      console.error('[tracking] ingest failed:', err)
      return { ok: false, message: 'The position could not be stored' }
    }
  }

  async function snapshot() {
    let rows = []
    try {
      const result = await db
        .prepare('SELECT device_id, state_json FROM device_state ORDER BY device_id')
        .all()
      rows = result.results || []
    } catch {
      rows = []
    }

    let users = []
    try {
      const result = await db
        .prepare('SELECT username, emoji, color FROM way_users ORDER BY username')
        .all()
      users = result.results || []
    } catch {
      users = []
    }
    const byName = new Map(users.map((u) => [u.username, u]))

    const devices = {}
    for (const row of rows) {
      const state = parseState(row)
      if (!state.lastStatus) continue
      const user = byName.get(row.device_id) || {}
      devices[row.device_id] = {
        deviceId: row.device_id,
        displayName: user.displayName || row.device_id,
        emoji: user.emoji || null,
        color: user.color || null,
        ...state.lastStatus,
      }
    }

    return {
      type: 'snapshot',
      devices,
      serverTime: new Date().toISOString(),
    }
  }

  return {
    setBroadcast(fn) {
      broadcast = typeof fn === 'function' ? fn : () => {}
    },
    ingest,
    snapshot,
  }
}
