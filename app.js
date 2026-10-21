'use strict';

// ---------- constants ----------

const MADRID = [40.4168, -3.7038];
const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const TILTS = [-1.5, 1, -0.5, 1.6, -1.1, 0.6];
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const PLAY_STEP_MS = 900;

// ---------- helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);
const canHover = matchMedia('(hover: hover) and (pointer: fine)');
const isMobile = matchMedia('(max-width: 720px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function yearOf(p) {
  return p.takenAt ? +p.takenAt.slice(0, 4) : null;
}

// '2019-06-14T17:42:00' -> '14 JUN 2019 · 17:42'. Local camera time, no timezone maths.
// Dates only known to the month (dateApprox: 'month') read '~ OCT 2025'.
function fmtDate(p, { year = true, time = true } = {}) {
  if (!p.takenAt) return 'Sin fecha';
  const [, y, m, d, hh, mm] = p.takenAt.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/) || [];
  if (!y) return 'Sin fecha';
  if (p.dateApprox === 'month') return year ? `~ ${MONTHS[+m - 1]} ${y}` : `~ ${MONTHS[+m - 1]}`;
  let out = `${d} ${MONTHS[+m - 1]}`;
  if (year) out += ` ${y}`;
  if (time && hh) out += ` · ${hh}:${mm}`;
  return out;
}

function km(a, b) {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function precLabel(p, short) {
  if (p.precision === 'gps') return short ? 'GPS' : 'Lugar exacto (GPS)';
  return short ? 'Centro ciudad' : 'Centro de la ciudad';
}

function precHtml(p, short) {
  const hollow = p.precision === 'gps' ? '' : ' hollow';
  return `<span class="prec"><span class="prec-dot${hollow}"></span>${precLabel(p, short)}</span>`;
}

const chevron = dir => dir < 0
  ? '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  : '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- state ----------

const state = {
  photos: [],
  stacks: [],              // one per city, all photos
  stackByKey: new Map(),
  minYear: null,
  maxYear: null,
  year: null,              // timeline position; maxYear means "everything", including undated
  route: false,
  playTimer: null,
  selected: null,          // { stack, photos, index }
  groupBy: 'year',
};

let map = null;
let markers = new Map();
let hideTimer = null;

function stackKey(p) {
  return `${p.city}|${p.countryCode}`;
}

function buildStacks(photos) {
  const byKey = new Map();
  for (const p of photos) {
    const k = stackKey(p);
    if (!byKey.has(k)) byKey.set(k, { key: k, city: p.city, country: p.country, countryCode: p.countryCode, photos: [] });
    byKey.get(k).photos.push(p);
  }
  for (const s of byKey.values()) {
    // photos.json is already sorted by date with undated last
    const gps = s.photos.filter(p => p.precision === 'gps');
    const src = gps.length ? gps : s.photos;
    s.lat = src.reduce((a, p) => a + p.lat, 0) / src.length;
    s.lon = src.reduce((a, p) => a + p.lon, 0) / src.length;
    s.precision = gps.length ? 'gps' : 'city';
  }
  return byKey;
}

function inTimeline(p) {
  if (state.year === null || state.year >= state.maxYear) return true;
  const y = yearOf(p);
  return y !== null && y <= state.year;
}

function visiblePhotos(stack) {
  return stack.photos.filter(inTimeline);
}

// ---------- stats ----------

function renderStats() {
  const photos = state.photos;
  const countries = new Set(photos.map(p => p.countryCode));
  const cities = new Set(photos.map(stackKey));
  const far = photos.reduce((best, p) => {
    const d = km(MADRID, [p.lat, p.lon]);
    return d > best.d ? { d, p } : best;
  }, { d: -1, p: null });
  const span = state.minYear ? (state.minYear === state.maxYear ? `${state.minYear}` : `${state.minYear}–${state.maxYear}`) : '—';

  const tiles = [
    [photos.length, 'fotos'],
    [countries.size, 'países'],
    [cities.size, 'ciudades'],
    [span, 'de la primera a la última'],
    [far.p ? far.p.city : '—', far.p ? `la más lejos de Madrid · ${Math.round(far.d).toLocaleString('es-ES')} km` : 'la más lejos de Madrid'],
  ];
  $('#stats').innerHTML = tiles.map(([n, l]) =>
    `<div class="stat"><span class="stat-n">${esc(n)}</span><span class="stat-l">${esc(l)}</span></div>`).join('');
  $('#miniStats').textContent = `${plural(photos.length, 'foto', 'fotos')} · ${plural(countries.size, 'país', 'países')}`;
  $('[data-lede-gallery]').textContent = `Las ${photos.length} fotos, ordenadas por fecha.`;
}

// ---------- map ----------

function tintStyle() {
  const c = {
    land: '#E4D9C3', land2: '#DDD1B9', land3: '#E8DECB', water: '#F8F3EA',
    road: '#EDE4D3', roadCase: '#DCCFB7', border: '#CDBFA6', label: '#6A5F57', halo: '#F5EFE4', waterLabel: '#A3957F',
  };
  const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch { /* layer differs */ } };
  for (const layer of map.getStyle().layers) {
    const id = layer.id;
    if (layer.type === 'background') set(id, 'background-color', c.land);
    else if (layer.type === 'fill') {
      if (/water/.test(id)) set(id, 'fill-color', c.water);
      else if (/wood|park/.test(id)) set(id, 'fill-color', c.land2);
      else if (/ice|glacier/.test(id)) set(id, 'fill-color', c.land3);
      else { set(id, 'fill-color', c.land3); set(id, 'fill-outline-color', c.land2); }
    } else if (layer.type === 'line') {
      if (/waterway/.test(id)) set(id, 'line-color', c.water);
      else if (/boundary/.test(id)) set(id, 'line-color', c.border);
      else if (/casing/.test(id)) set(id, 'line-color', c.roadCase);
      else set(id, 'line-color', c.road);
    } else if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      const isWater = /water/.test(id);
      set(id, 'text-color', isWater ? c.waterLabel : c.label);
      set(id, 'text-halo-color', c.halo);
      if (/^label_|water_name/.test(id)) {
        try {
          map.setLayoutProperty(id, 'text-field', ['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']]);
        } catch { /* keep default labels */ }
      }
    }
  }
}

function stacksGeoJSON() {
  const features = [];
  for (const s of state.stacks) {
    const n = visiblePhotos(s).length;
    if (!n) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { key: s.key, count: n, gps: s.precision === 'gps' ? 1 : 0 },
    });
  }
  return { type: 'FeatureCollection', features };
}

// Gentle arcs between consecutive photos, computed in Mercator space.
function routeGeoJSON() {
  const pts = state.photos.filter(p => p.takenAt && inTimeline(p));
  const lines = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (stackKey(a) === stackKey(b)) continue;
    let bLon = b.lon;
    if (bLon - a.lon > 180) bLon -= 360;
    else if (a.lon - bLon > 180) bLon += 360;
    const A = maplibregl.MercatorCoordinate.fromLngLat([a.lon, a.lat]);
    const B = maplibregl.MercatorCoordinate.fromLngLat([bLon, b.lat]);
    const dx = B.x - A.x, dy = B.y - A.y;
    const cx = (A.x + B.x) / 2 - dy * 0.18, cy = (A.y + B.y) / 2 + dx * 0.18;
    const coords = [];
    for (let t = 0; t <= 1.0001; t += 1 / 24) {
      const u = 1 - t;
      const x = u * u * A.x + 2 * u * t * cx + t * t * B.x;
      const y = u * u * A.y + 2 * u * t * cy + t * t * B.y;
      const ll = new maplibregl.MercatorCoordinate(x, y).toLngLat();
      coords.push([ll.lng, ll.lat]);
    }
    lines.push(coords);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
}

function initialView() {
  if (isMobile.matches) return { center: [9, 47], zoom: 3.2 };
  if (!state.stacks.length) return { center: [10, 30], zoom: 1.2 };
  const b = new maplibregl.LngLatBounds();
  for (const s of state.stacks) b.extend([s.lon, s.lat]);
  return { bounds: b, fitBoundsOptions: { padding: { top: 70, bottom: 70, left: 60, right: 60 }, maxZoom: 5 } };
}

function initMap() {
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: STYLE_URL,
      ...initialView(),
      minZoom: 0.8,
      maxZoom: 16,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      cooperativeGestures: false,
    });
  } catch (err) {
    $('#map').innerHTML = '<div class="map-error">No se pudo cargar el mapa en este navegador. Prueba la galería.</div>';
    console.error(err);
    return;
  }
  map.touchZoomRotate.disableRotation();

  map.on('load', () => {
    tintStyle();
    map.addSource('route', { type: 'geojson', data: routeGeoJSON() });
    map.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.route ? 'visible' : 'none' },
      paint: { 'line-color': '#C8102E', 'line-opacity': 0.55, 'line-width': 2, 'line-dasharray': [1, 3.5] },
    });
    map.addSource('stacks', {
      type: 'geojson',
      data: stacksGeoJSON(),
      cluster: true,
      clusterRadius: 44,
      clusterMaxZoom: 11,
      clusterProperties: { photos: ['+', ['get', 'count']], gps: ['max', ['get', 'gps']] },
    });
    // Invisible layer so the source gets tiled; the visible pins are HTML markers.
    map.addLayer({ id: 'stacks-hit', type: 'circle', source: 'stacks', paint: { 'circle-radius': 0, 'circle-opacity': 0 } });
  });

  map.on('data', e => { if (e.sourceId === 'stacks' && e.isSourceLoaded) updateMarkers(); });
  map.on('move', () => { updateMarkers(); positionCard(); });
  map.on('click', () => closeCard());

  $('#zoomIn').addEventListener('click', () => map.zoomIn());
  $('#zoomOut').addEventListener('click', () => map.zoomOut());
}

function refreshMapData() {
  if (!map || !map.getSource('stacks')) return;
  map.getSource('stacks').setData(stacksGeoJSON());
  map.getSource('route').setData(routeGeoJSON());
  if (state.selected) {
    const photos = visiblePhotos(state.selected.stack);
    if (!photos.length) closeCard();
  }
}

function clusterSize(n) {
  return n >= 10 ? 'big' : n >= 4 ? 'mid' : '';
}

function makeMarker(f) {
  const p = f.properties;
  const el = document.createElement('button');
  el.type = 'button';
  if (p.cluster) {
    const n = p.photos;
    el.className = `cluster ${clusterSize(n)}`;
    el.textContent = n;
    el.setAttribute('aria-label', `${plural(n, 'foto', 'fotos')} en varias ciudades, acercar`);
    el.addEventListener('click', async ev => {
      ev.stopPropagation();
      const zoom = await map.getSource('stacks').getClusterExpansionZoom(p.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom + 0.3, 14), duration: reducedMotion.matches ? 0 : 500 });
    });
  } else {
    const stack = state.stackByKey.get(p.key);
    const n = p.count;
    const hollow = p.gps ? '' : ' hollow';
    el.className = n > 1 ? `cluster${hollow}` : `pin${hollow}`;
    if (n > 1) el.textContent = n;
    el.dataset.key = p.key;
    el.setAttribute('aria-label', `${stack.city}, ${plural(n, 'foto', 'fotos')}${p.gps ? '' : ', centro de ciudad'}`);
    el.addEventListener('mouseenter', () => { if (canHover.matches) openStack(stack); });
    el.addEventListener('mouseleave', () => { if (canHover.matches) scheduleHide(); });
    el.addEventListener('focus', () => { if (canHover.matches) openStack(stack); });
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      if (canHover.matches) {
        if (state.selected?.stack !== stack) openStack(stack);
        openLightbox(state.selected.photos, state.selected.index, el);
      } else {
        openStack(stack);
      }
    });
  }
  return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(f.geometry.coordinates);
}

function updateMarkers() {
  if (!map || !map.getSource('stacks') || !map.isSourceLoaded('stacks')) return;
  const next = new Map();
  for (const f of map.querySourceFeatures('stacks')) {
    const p = f.properties;
    const id = p.cluster ? `c${p.cluster_id}:${p.photos}` : `s${p.key}:${p.count}`;
    if (next.has(id)) continue;
    const m = markers.get(id) || makeMarker(f).addTo(map);
    next.set(id, m);
  }
  for (const [id, m] of markers) if (!next.has(id)) m.remove();
  markers = next;
  markSelected();
}

function markSelected() {
  const key = state.selected?.stack.key;
  for (const m of markers.values()) {
    const el = m.getElement();
    el.classList.toggle('selected', !!key && el.dataset.key === key);
  }
}

// ---------- card (desktop hover) and sheet (mobile tap) ----------

function openStack(stack, index = 0) {
  clearTimeout(hideTimer);
  const photos = visiblePhotos(stack);
  if (!photos.length) return;
  state.selected = { stack, photos, index: Math.min(index, photos.length - 1) };
  markSelected();
  if (canHover.matches && !isMobile.matches) renderCard();
  else renderSheet();
}

function stepSelected(dir) {
  const s = state.selected;
  if (!s) return;
  s.index = (s.index + dir + s.photos.length) % s.photos.length;
  if (!$('#card').hidden) renderCard();
  if (!$('#sheet').hidden) renderSheet();
}

function infoBlock(p) {
  return `
    <div class="card-title"><span class="city">${esc(p.city)}</span><span class="stamp" title="${esc(p.country)}">${esc(p.countryCode)}</span></div>
    <span class="country">${esc(p.country)}</span>`;
}

function stackNav(s) {
  if (s.photos.length < 2) return '';
  return `<div class="stack-nav">
    <button class="round-btn" data-step="-1" aria-label="Foto anterior">${chevron(-1)}</button>
    <span>${s.index + 1} de ${s.photos.length} en esta ciudad</span>
    <button class="round-btn" data-step="1" aria-label="Foto siguiente">${chevron(1)}</button>
  </div>`;
}

function renderCard() {
  const s = state.selected;
  const p = s.photos[s.index];
  const card = $('#card');
  card.setAttribute('aria-label', p.city);
  card.innerHTML = `
    <div class="tape" aria-hidden="true"></div>
    <button class="photo-btn" data-open aria-label="Ver foto en grande"><img src="${esc(p.thumb)}" alt="Foto en H&amp;M ${esc(p.city)}"></button>
    ${infoBlock(p)}
    ${p.people?.length ? `<span class="people">Con ${esc(p.people.join(', '))}</span>` : ''}
    <div class="card-meta"><span class="date">${fmtDate(p)}</span>${precHtml(p, true)}</div>
    ${stackNav(s)}`;
  card.hidden = false;
  positionCard();
}

function positionCard() {
  const card = $('#card');
  const s = state.selected;
  if (!s || card.hidden || !map) return;
  const wrap = $('#mapWrap');
  const pt = map.project([s.stack.lon, s.stack.lat]);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const w = card.offsetWidth, h = card.offsetHeight;
  let left = pt.x + 24;
  if (left + w > W - 12) left = pt.x - 24 - w;
  let top = pt.y - 44;
  top = Math.max(16, Math.min(top, H - h - 16));
  left = Math.max(12, left);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function renderSheet() {
  const s = state.selected;
  const p = s.photos[s.index];
  const sheet = $('#sheet');
  sheet.setAttribute('aria-label', `${p.city}, ${plural(s.photos.length, 'foto', 'fotos')}`);
  sheet.innerHTML = `
    <button class="sheet-handle" data-close aria-label="Cerrar"></button>
    ${stackNav(s)}
    <div class="sheet-body">
      <div class="polaroid"><button class="photo-btn" data-open aria-label="Ver foto a pantalla completa"><img src="${esc(p.thumb)}" alt="Foto en H&amp;M ${esc(p.city)}"></button></div>
      <div class="sheet-info">
        ${infoBlock(p)}
        <span class="date" style="margin-top:6px">${fmtDate(p, { time: false })}</span>
        ${p.takenAt?.length > 10 && !p.dateApprox ? `<span class="date">${p.takenAt.slice(11, 16)}</span>` : ''}
        ${p.people?.length ? `<span class="people">Con ${esc(p.people.join(', '))}</span>` : ''}
        ${precHtml(p, false)}
      </div>
    </div>
    <p class="sheet-hint">Toca la foto para verla en grande.</p>`;
  sheet.hidden = false;
}

function closeCard() {
  clearTimeout(hideTimer);
  state.selected = null;
  $('#card').hidden = true;
  $('#sheet').hidden = true;
  markSelected();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(closeCard, 260);
}

function wireCardEvents(el) {
  el.addEventListener('click', ev => {
    ev.stopPropagation();
    const step = ev.target.closest('[data-step]');
    if (step) return stepSelected(+step.dataset.step);
    if (ev.target.closest('[data-open]') && state.selected) {
      return openLightbox(state.selected.photos, state.selected.index, ev.target.closest('[data-open]'));
    }
    if (ev.target.closest('[data-close]')) closeCard();
  });
}

// ---------- lightbox ----------

const lb = { photos: [], index: 0, returnFocus: null };

function openLightbox(photos, index, returnFocus) {
  stopPlay();
  lb.photos = photos;
  lb.index = index;
  lb.returnFocus = returnFocus || document.activeElement;
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  renderLightbox();
  $('#lbClose').focus();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
  $('#lbImg').removeAttribute('src');
  if (lb.returnFocus?.isConnected) lb.returnFocus.focus({ preventScroll: true });
}

function stepLightbox(dir) {
  const n = lb.photos.length;
  if (n < 2) return;
  lb.index = (lb.index + dir + n) % n;
  renderLightbox();
}

function renderLightbox() {
  const p = lb.photos[lb.index];
  const n = lb.photos.length;
  const img = $('#lbImg');
  img.src = p.thumb;            // instant, then swap in the full image
  const full = new Image();
  full.onload = () => { if (lb.photos[lb.index] === p) img.src = p.image; };
  full.src = p.image;
  img.width = p.w;
  img.height = p.h;
  img.alt = `Foto de la familia en H&M ${p.city}`;
  $('#lightbox').setAttribute('aria-label', n > 1 ? `${p.city}, foto ${lb.index + 1} de ${n}` : p.city);
  $('#lbCount').textContent = n > 1 ? `${lb.index + 1} de ${n} en esta ciudad` : '';
  $('#lbCaption').innerHTML = `
    <div class="lb-left">
      <span class="city">${esc(p.city)}</span>
      <span class="country">${esc(p.country)} · ${esc(p.countryCode)}</span>
      ${p.people?.length ? `<span class="people">Con ${esc(p.people.join(', '))}</span>` : ''}
      ${p.caption ? `<span class="country">${esc(p.caption)}</span>` : ''}
    </div>
    <div class="lb-right">
      <span class="date">${fmtDate(p)}</span>
      ${precHtml(p, false)}
    </div>`;
  $('#lbPrev').disabled = $('#lbNext').disabled = n < 2;
  const strip = $('#lbStrip');
  strip.hidden = n < 2;
  strip.innerHTML = n < 2 ? '' : lb.photos.map((q, i) =>
    `<button data-i="${i}" aria-label="Foto ${i + 1}${i === lb.index ? ', actual' : ''}"${i === lb.index ? ' aria-current="true"' : ''}><img src="${esc(q.thumb)}" alt="" loading="lazy"></button>`).join('');
  strip.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function wireLightbox() {
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('#lbNext').addEventListener('click', () => stepLightbox(1));
  $('#lbStrip').addEventListener('click', ev => {
    const b = ev.target.closest('[data-i]');
    if (b) { lb.index = +b.dataset.i; renderLightbox(); }
  });
  $('#lightbox').addEventListener('click', ev => { if (ev.target.classList.contains('lb-stage')) closeLightbox(); });

  let x0 = null;
  const stage = $('.lb-stage');
  stage.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    x0 = null;
  });

  document.addEventListener('keydown', ev => {
    if (!$('#lightbox').hidden) {
      if (ev.key === 'Escape') closeLightbox();
      else if (ev.key === 'ArrowLeft') stepLightbox(-1);
      else if (ev.key === 'ArrowRight') stepLightbox(1);
      else if (ev.key === 'Tab') {
        // keep focus inside the lightbox
        const f = [...$('#lightbox').querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent);
        const i = f.indexOf(document.activeElement);
        if (ev.shiftKey && i <= 0) { f[f.length - 1].focus(); ev.preventDefault(); }
        else if (!ev.shiftKey && i === f.length - 1) { f[0].focus(); ev.preventDefault(); }
      }
      return;
    }
    if (ev.key === 'Escape') {
      if (!$('#menu').hidden) toggleMenu(false);
      else closeCard();
    }
  });
}

// ---------- timeline + route ----------

function setYear(y) {
  state.year = y;
  const input = $('#years');
  input.value = y;
  const all = y >= state.maxYear;
  $('#yearLabel').textContent = all ? 'todos los años' : `hasta ${y}`;
  input.setAttribute('aria-valuetext', all ? 'Todos los años' : `Hasta ${y}`);
  refreshMapData();
}

function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  $('#play').classList.remove('playing');
  $('#play').setAttribute('aria-label', 'Reproducir los años');
}

function togglePlay() {
  if (state.playTimer) return stopPlay();
  if (state.year >= state.maxYear) setYear(state.minYear);
  $('#play').classList.add('playing');
  $('#play').setAttribute('aria-label', 'Pausar');
  state.playTimer = setInterval(() => {
    if (state.year >= state.maxYear) return stopPlay();
    setYear(state.year + 1);
  }, PLAY_STEP_MS);
}

function setupTimeline() {
  const input = $('#years');
  if (state.minYear === null) {
    $('#timeline').hidden = true;
    return;
  }
  input.min = state.minYear;
  input.max = state.maxYear;
  $('#yearMin').textContent = state.minYear;
  $('#yearMax').textContent = state.maxYear;
  setYear(state.maxYear);
  input.addEventListener('input', () => { stopPlay(); setYear(+input.value); });
  $('#play').addEventListener('click', togglePlay);
  $('#allYears').addEventListener('click', () => { stopPlay(); setYear(state.maxYear); });
}

function setRoute(on) {
  state.route = on;
  $('#routeToggle').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('hms.route', on ? '1' : '0'); } catch { /* private mode */ }
  if (map?.getLayer('route')) map.setLayoutProperty('route', 'visibility', on ? 'visible' : 'none');
}

function setupRoute() {
  let saved = null;
  try { saved = localStorage.getItem('hms.route'); } catch { /* private mode */ }
  state.route = saved === '1';
  setRoute(state.route);
  $('#routeToggle').addEventListener('click', () => setRoute(!state.route));
}

// ---------- gallery ----------

function renderGallery() {
  const by = state.groupBy;
  const groups = new Map();
  const add = (k, p) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); };
  const newestFirst = [...state.photos].sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''));

  if (by === 'year') {
    for (const p of newestFirst) add(yearOf(p) ?? 'Sin fecha', p);
  } else {
    for (const p of newestFirst) add(p.country || 'Sin país', p);
  }
  let entries = [...groups.entries()];
  if (by === 'country') entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'es'));
  else entries.sort((a, b) => (a[0] === 'Sin fecha') - (b[0] === 'Sin fecha') || b[0] - a[0]);

  $('#gallery').innerHTML = entries.map(([title, photos]) => `
    <section class="g-section">
      <div class="g-head"><h2>${esc(title)}</h2><span>${plural(photos.length, 'foto', 'fotos')}</span></div>
      <div class="g-grid">
        ${photos.map((p, i) => `
          <button class="g-card" data-id="${esc(p.id)}" style="--tilt:${TILTS[i % TILTS.length]}deg"
            aria-label="${esc(p.city)}, ${p.takenAt ? fmtDate(p, { time: false }) : 'sin fecha'}">
            <img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async">
            <span class="g-cap"><span class="city">${esc(p.city)}</span><span class="date">${p.takenAt ? fmtDate(p, { year: by !== 'year', time: false }) : '—'}</span></span>
          </button>`).join('')}
      </div>
    </section>`).join('');
}

function setupGallery() {
  const byId = new Map(state.photos.map(p => [p.id, p]));
  $('#gallery').addEventListener('click', ev => {
    const card = ev.target.closest('.g-card');
    if (!card) return;
    const p = byId.get(card.dataset.id);
    const stack = state.stackByKey.get(stackKey(p));
    openLightbox(stack.photos, stack.photos.indexOf(p), card);
  });
  for (const chip of document.querySelectorAll('[data-group]')) {
    chip.addEventListener('click', () => {
      state.groupBy = chip.dataset.group;
      for (const c of document.querySelectorAll('[data-group]')) c.setAttribute('aria-pressed', String(c === chip));
      renderGallery();
    });
  }
}

// ---------- views, menu, responsive moves ----------

function route() {
  const view = location.hash === '#galeria' ? 'gallery' : 'map';
  $('#app').dataset.view = view;
  $('#viewMap').hidden = view !== 'map';
  $('#viewGallery').hidden = view !== 'gallery';
  for (const a of document.querySelectorAll('[data-view-link]')) {
    if (a.dataset.viewLink === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  toggleMenu(false);
  if (view === 'gallery') {
    closeCard();
    stopPlay();
    if (!$('#gallery').childElementCount) renderGallery();
  } else if (map) {
    requestAnimationFrame(() => map.resize());
  }
}

function toggleMenu(open) {
  const menu = $('#menu');
  menu.hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', String(open));
  if (open) closeCard();
}

// On phones the route toggle and timeline live in the menu.
function placeControls() {
  const mobile = isMobile.matches;
  (mobile ? $('#menuRouteSlot') : $('#routeSlot')).append($('#routeToggle'));
  (mobile ? $('#menuTimelineSlot') : $('#timelineSlot')).append($('#timeline'));
  closeCard();
  if (map) requestAnimationFrame(() => map.resize());
}

// ---------- boot ----------

async function main() {
  let photos = [];
  try {
    const res = await fetch('photos.json', { cache: 'no-cache' });
    photos = await res.json();
  } catch (err) {
    console.error('Could not load photos.json', err);
  }
  state.photos = photos;
  state.stackByKey = buildStacks(photos);
  state.stacks = [...state.stackByKey.values()];
  const years = photos.map(yearOf).filter(y => y !== null);
  if (years.length) {
    state.minYear = Math.min(...years);
    state.maxYear = Math.max(...years);
  }

  renderStats();
  setupRoute();
  setupTimeline();
  setupGallery();
  wireCardEvents($('#card'));
  wireCardEvents($('#sheet'));
  wireLightbox();
  $('#card').addEventListener('mouseenter', () => clearTimeout(hideTimer));
  $('#card').addEventListener('mouseleave', scheduleHide);
  $('#menuBtn').addEventListener('click', () => toggleMenu($('#menu').hidden));
  $('#menu').addEventListener('click', ev => { if (ev.target.id === 'menu') toggleMenu(false); });
  isMobile.addEventListener('change', placeControls);
  window.addEventListener('hashchange', route);

  placeControls();
  initMap();
  route();
}

main();
