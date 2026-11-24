// /shared/track.js — the live cards on the container's /track page.
// The server speaks the same frames the WAY dashboard already understands:
//   { type: 'snapshot', devices: {...}, serverTime }
//   { type: 'position', deviceId, timestamp, latitude, longitude, speed, ... }
// Everything is written with textContent; a device name or a place name is
// data, never markup.
(function () {
  'use strict'

  var stateEl = document.getElementById('live-state')
  var listEl = document.getElementById('live-devices')
  var emptyEl = document.getElementById('live-empty')

  var devices = new Map()
  var cards = new Map()
  var socket = null
  var reconnectTimer = null
  var retryDelay = 1000
  var leaving = false

  function el(tag, className, textValue) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (textValue != null) node.textContent = textValue
    return node
  }

  function setState(label, color) {
    if (!stateEl) return
    stateEl.textContent = label
    stateEl.style.color = color
  }

  function ageSeconds(timestamp) {
    var then = Date.parse(timestamp)
    if (!isFinite(then)) return null
    // A phone's clock can be a second ahead of this machine's. An age is never
    // negative, whatever the skew (the same rule the W.A.Y HUD uses).
    return Math.max(0, (Date.now() - then) / 1000)
  }

  function ageText(timestamp) {
    var s = ageSeconds(timestamp)
    if (s == null) return '—'
    if (s < 60) return Math.floor(s) + 's'
    if (s < 3600) return Math.floor(s / 60) + 'm'
    if (s < 86400) return Math.floor(s / 3600) + 'h'
    return Math.floor(s / 86400) + 'd'
  }

  function speedText(d) {
    if (d.isStationary && (d.speed == null || d.speed < 2)) return 'Parked'
    var value = typeof d.speed === 'number' ? d.speed : d.speedAvg
    return typeof value === 'number' && isFinite(value) ? Math.round(value) + ' km/h' : '—'
  }

  function placeText(d) {
    if (d.isInside) return 'At ' + (d.geofenceName || 'a fence')
    if (d.isStationary) return 'Parked'
    if (d.isDriving) return 'Driving'
    return 'Moving'
  }

  function cardFor(deviceId) {
    var article = el('article', 'card p-4')
    article.dataset.device = deviceId

    var head = el('div', 'flex items-start justify-between gap-3')
    var left = el('div', 'min-w-0')
    left.appendChild(el('p', 't-label', 'Device'))
    var name = el('p', 't-value truncate', deviceId)
    left.appendChild(name)
    var dot = el('span', 'inline-block w-2.5 h-2.5 rounded-full mt-2 shrink-0')
    head.appendChild(left)
    head.appendChild(dot)
    article.appendChild(head)

    var status = el('p', 't-micro mt-1', '')
    article.appendChild(status)

    var grid = el('div', 'grid grid-cols-3 gap-2 mt-3')
    var speed = el('p', 't-value', '—')
    var acc = el('p', 't-value', '—')
    var age = el('p', 't-value', '—')
    ;[
      ['Speed', speed],
      ['Accuracy', acc],
      ['Last fix', age],
    ].forEach(function (pair) {
      var cell = el('div', 'min-w-0')
      cell.appendChild(el('p', 't-label', pair[0]))
      pair[1].classList.add('truncate')
      cell.appendChild(pair[1])
      grid.appendChild(cell)
    })
    article.appendChild(grid)

    var footer = el('div', 'flex items-center justify-between gap-3 mt-3 pt-3')
    footer.style.borderTop = '1px solid var(--rule)'
    var coords = el('span', 't-micro truncate', '')
    var link = el('a', 'text-[12px] font-semibold shrink-0', 'Open map')
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    footer.appendChild(coords)
    footer.appendChild(link)
    article.appendChild(footer)

    return {
      article: article,
      name: name,
      dot: dot,
      status: status,
      speed: speed,
      acc: acc,
      age: age,
      coords: coords,
      link: link,
    }
  }

  function paint(card, d) {
    var age = ageSeconds(d.timestamp)
    var stale = age != null && age > 600
    var place = placeText(d)

    card.name.textContent = d.displayName || d.deviceId
    card.status.textContent = stale ? place + ' · last fix ' + ageText(d.timestamp) : place
    card.speed.textContent = speedText(d)
    card.acc.textContent = typeof d.accuracy === 'number' ? '±' + Math.round(d.accuracy) + ' m' : '—'
    card.age.textContent = ageText(d.timestamp)

    var lat = Number(d.latitude)
    var lon = Number(d.longitude)
    if (isFinite(lat) && isFinite(lon)) {
      card.coords.textContent = lat.toFixed(5) + ', ' + lon.toFixed(5)
      card.link.href =
        'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon +
        '#map=17/' + lat + '/' + lon
      card.link.hidden = false
    } else {
      card.coords.textContent = 'No position'
      card.link.hidden = true
    }

    // Colour ENCODES the state (data, like a user dot), not decoration:
    // green at a place, blue driving, amber moving/walking, grey stale.
    card.dot.style.backgroundColor = stale
      ? '#94a3b8'
      : d.isInside
        ? '#16a34a'
        : d.isDriving
          ? '#0284c7'
          : '#f59e0b'
  }

  function renderSnapshot(devicesObject) {
    devices = new Map(Object.entries(devicesObject || {}))
    listEl.textContent = ''
    cards.clear()

    var ids = Array.from(devices.keys()).sort()
    ids.forEach(function (id) {
      var card = cardFor(id)
      cards.set(id, card)
      listEl.appendChild(card.article)
      paint(card, devices.get(id))
    })
    emptyEl.hidden = ids.length > 0
  }

  function upsert(d) {
    if (!d || !d.deviceId) return
    devices.set(d.deviceId, d)
    var card = cards.get(d.deviceId)
    if (!card) {
      card = cardFor(d.deviceId)
      cards.set(d.deviceId, card)
      listEl.appendChild(card.article)
    }
    paint(card, d)
    emptyEl.hidden = true
  }

  function scheduleReconnect() {
    if (leaving || reconnectTimer) return
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null
      connect()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30000)
  }

  function connect() {
    if (leaving) return
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

    setState('Connecting…', 'var(--ink-3)')
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
    try {
      socket = new WebSocket(scheme + location.host + '/ws')
    } catch (err) {
      scheduleReconnect()
      return
    }

    socket.onopen = function () {
      retryDelay = 1000
      setState('Live', '#16a34a')
    }

    socket.onmessage = function (event) {
      var frame
      try {
        frame = JSON.parse(event.data)
      } catch (err) {
        return
      }
      if (frame.type === 'snapshot') {
        renderSnapshot(frame.devices)
        setState('Live', '#16a34a')
      } else if (frame.type === 'position') {
        upsert(frame)
      }
    }

    socket.onclose = function () {
      if (leaving) return
      setState('Reconnecting…', '#f59e0b')
      scheduleReconnect()
    }

    socket.onerror = function () {
      // onclose follows; closing here just makes it prompt.
      try { socket.close() } catch (err) { /* ignore */ }
    }
  }

  // The age is a WALL-CLOCK reading, so it has to move even when no frame
  // arrives: a device that went silent must stop looking fresh.
  setInterval(function () {
    devices.forEach(function (d, id) {
      var card = cards.get(id)
      if (card) paint(card, d)
    })
  }, 1000)

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' &&
        (!socket || socket.readyState === WebSocket.CLOSED)) {
      retryDelay = 1000
      connect()
    }
  })

  window.addEventListener('beforeunload', function () {
    leaving = true
    if (socket) socket.close()
  })

  connect()
})()
