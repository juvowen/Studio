import './runway.css'
import './music.js'
import { showMuseums, hideMuseums } from './museums.js'
import { cartButton } from './board-store.js'
import './cart.js'

// Artworks come from the Art Institute of Chicago's public collection,
// looked up by the backend (Backend/server.py, /api/art/...), which also
// passes the pictures through. Only public-domain works with images are shown.
// NYC art events: gallery and museum exhibitions read from their own websites
// (Backend/galleries.py), optional Google Events results (SerpApi key), and the
// city's NYC Parks events feed (NYC Open Data).
//
// Three menus, one active view: an artist, a period (locks the artist menu),
// or NYC events (locks both).
const DEFAULT_ARTIST = 35809 // Claude Monet

const artistInput = document.querySelector('#art-artist') // the artist search box
const artistList = document.querySelector('#art-artists')
const periodSelect = document.querySelector('#art-period')
const eventsSelect = document.querySelector('#art-events')
const artistLock = document.querySelector('.art-lock[data-for="artist"]')
const periodLock = document.querySelector('.art-lock[data-for="period"]')
const nameHeading = document.querySelector('#art-name')
const lifeLabel = document.querySelector('.art-life')
const countLabel = document.querySelector('.rw-count')
const statusLine = document.querySelector('.rw-status')
const grid = document.querySelector('.art-grid')
const museumPanel = document.querySelector('.art-museum')
const moreButton = document.querySelector('.art-more')
const viewer = document.querySelector('.art-view')
const viewerImage = viewer.querySelector('img')
const viewerIndex = viewer.querySelector('.art-view-index')
const viewerTitle = viewer.querySelector('#art-view-title')
const viewerMeta = viewer.querySelector('.art-view-meta')
const viewerLink = viewer.querySelector('.art-view-link')

let artists = new Map() // id -> { id, name, born, died, works }
let periods = new Map() // id -> { id, name, start, end, works }
let eventTypes = new Map() // id -> { id, name, events }
let artistsReady = false
let artistsFailed = false
let lastArtist = DEFAULT_ARTIST // where "All periods" goes back to
let lastWorks = { kind: 'artist', id: DEFAULT_ARTIST } // where events "Off" goes back to
// What the grid shows: an artist (id is a number), a period or an event type (ids are keys).
let current = { kind: 'artist', id: null, page: 0, total: 0, shown: 0 }
let latest = 0 // ignores answers to requests the visitor has since replaced

const pad = (number) => String(number).padStart(2, '0')
const count = (number) => (number < 1000 ? pad(number) : number.toLocaleString('en-US'))

async function api(path, params = {}) {
	const response = await fetch(`/api/art/${path}?${new URLSearchParams(params)}`, { cache: 'no-store' })
	const data = await response.json().catch(() => ({}))
	if (!response.ok) throw new Error(data.error || 'The Art Institute of Chicago could not be reached.')
	return data
}

function status(text, loading = false) {
	statusLine.textContent = text
	statusLine.classList.toggle('is-loading', loading)
}

function showHeading() {
	if (current.kind === 'events') {
		const type = eventTypes.get(current.id)
		nameHeading.textContent = current.id === 'all' || !type ? '"NYC ART EVENTS"' : `"${type.name}"`
		lifeLabel.textContent =
			current.id === 'museums-map'
				? 'WHERE TO FIND THEM'
				: type?.address
					? type.area.toUpperCase()
					: type?.group === 'NYC PARKS' ? 'NYC PARKS — NEXT 14 DAYS' : type?.group === 'GALLERIES' || type?.group === 'MUSEUMS' ? 'ON VIEW NOW & OPENING SOON' : 'NYC — NOW & NEXT'
		document.title = `${nameHeading.textContent} – Studio`
		return
	}
	const entry = current.kind === 'artist' ? artists.get(current.id) : periods.get(current.id)
	if (!entry) return
	nameHeading.textContent = `"${entry.name}"`
	if (current.kind === 'artist') {
		lifeLabel.textContent = entry.born ? (entry.died ? `${entry.born}–${entry.died}` : `B. ${entry.born}`) : ''
	} else {
		lifeLabel.textContent = entry.end ? `${entry.start}–${entry.end - 1}` : `${entry.start}–`
	}
	document.title = `"${entry.name}" – Studio`
}

// While a period is chosen the artist menu is switched off; while events are
// on, the artist and period menus both are.
function lockMenus() {
	const why = current.kind === 'events' ? '— OFF WHILE NYC EVENTS ARE ON' : '— OFF WHILE A PERIOD IS CHOSEN'
	artistLock.textContent = why
	periodLock.textContent = why
	lockArtists(current.kind !== 'artist')
	periodLock.hidden = current.kind !== 'events'
	periodSelect.disabled = current.kind === 'events'
	periodSelect.value = current.kind === 'period' ? current.id : ''
	eventsSelect.value = current.kind === 'events' ? current.id : ''
}

function lockArtists(locked) {
	artistLock.hidden = !locked
	artistInput.disabled = locked
	if (locked) closeArtists()
	showArtistName()
}

// Puts the chosen artist's name back in the box (or ALL ARTISTS while locked).
function showArtistName() {
	if (current.kind !== 'artist') {
		artistInput.value = 'ALL ARTISTS'
		return
	}
	const fromHeading = nameHeading.textContent.replaceAll('"', '')
	artistInput.value = artists.get(lastArtist)?.name ?? fromHeading
}

// ---- Artist search -------------------------------------------------------
let artistOptions = [] // the list items that can be picked, in order
let activeArtist = -1 // the one the arrow keys are on

// "Monet", "claude monet" and "Cézanne"/"cezanne" all match; accents are ignored.
const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const squash = (text) => fold(text).replace(/[^a-z0-9]/g, '')

// Names that start with the search come first, then ones with a word that
// does (a surname), then any other match; ties go to artists with more works.
function searchArtists(text) {
	const wanted = fold(text).trim()
	const tight = squash(text)
	if (!tight) return []
	const ranked = []
	for (const artist of artists.values()) {
		const loose = fold(artist.name)
		const squashed = squash(artist.name)
		let rank
		if (squashed.startsWith(tight)) rank = 0
		else if (loose.split(/[^a-z0-9]+/).some((word) => word.startsWith(wanted))) rank = 1
		else if (squashed.includes(tight)) rank = 2
		else continue
		ranked.push({ artist, rank })
	}
	return ranked.sort((a, b) => a.rank - b.rank || b.artist.works - a.artist.works).map(({ artist }) => artist)
}

// Underlines the searched letters when they appear as typed.
function highlighted(name, text) {
	const wanted = fold(text).trim()
	const at = wanted ? fold(name).indexOf(wanted) : -1
	if (at < 0 || fold(name).length !== name.length) return [document.createTextNode(name)]
	const mark = document.createElement('mark')
	mark.textContent = name.slice(at, at + wanted.length)
	return [name.slice(0, at), mark, name.slice(at + wanted.length)]
}

function listHeading(text, className = 'rw-brands-group') {
	const item = document.createElement('li')
	item.className = className
	item.setAttribute('role', 'presentation')
	item.textContent = text
	return item
}

function artistChoice(artist, text) {
	const item = document.createElement('li')
	item.id = `art-artist-${artistOptions.length}`
	item.setAttribute('role', 'option')
	item.setAttribute('aria-selected', 'false')
	item.dataset.id = artist.id
	item.classList.toggle('is-current', current.kind === 'artist' && artist.id === lastArtist)
	const works = document.createElement('span')
	works.className = 'art-artist-works'
	works.textContent = ` (${artist.works})`
	item.append(...highlighted(artist.name, text), works)
	artistOptions.push(item)
	return item
}

function openArtists(text = '') {
	artistOptions = []
	activeArtist = -1
	const items = []
	if (!artistsReady) {
		items.push(listHeading(artistsFailed ? 'ARTISTS COULD NOT BE LOADED' : 'LOADING ARTISTS', 'rw-brands-empty'))
	} else if (!text.trim()) {
		const most = [...artists.values()].sort((a, b) => b.works - a.works).slice(0, 12)
		items.push(listHeading('MOST WORKS'), ...most.map((artist) => artistChoice(artist, '')))
		items.push(listHeading('ALL ARTISTS A–Z'), ...[...artists.values()].map((artist) => artistChoice(artist, '')))
	} else {
		const found = searchArtists(text)
		const shown = found.slice(0, 80)
		items.push(...shown.map((artist) => artistChoice(artist, text)))
		if (!found.length) items.push(listHeading('NO ARTIST MATCHES', 'rw-brands-empty'))
		else if (found.length > shown.length) items.push(listHeading(`${found.length - shown.length} MORE — KEEP TYPING`, 'rw-brands-empty'))
		if (found.length) setActiveArtist(0)
	}
	artistList.replaceChildren(...items)
	artistList.hidden = false
	artistInput.setAttribute('aria-expanded', 'true')
	if (!text.trim()) {
		// Scroll to the current artist in the A–Z part, not the "most works" part.
		artistOptions.findLast((item) => item.classList.contains('is-current'))?.scrollIntoView({ block: 'center' })
	}
}

function closeArtists() {
	artistList.hidden = true
	artistList.replaceChildren()
	artistOptions = []
	activeArtist = -1
	artistInput.setAttribute('aria-expanded', 'false')
	artistInput.removeAttribute('aria-activedescendant')
}

function setActiveArtist(index) {
	artistOptions[activeArtist]?.setAttribute('aria-selected', 'false')
	activeArtist = index
	const item = artistOptions[activeArtist]
	if (!item) return artistInput.removeAttribute('aria-activedescendant')
	item.setAttribute('aria-selected', 'true')
	item.scrollIntoView({ block: 'nearest' })
	artistInput.setAttribute('aria-activedescendant', item.id)
}

function chooseArtist(id) {
	closeArtists()
	if (id !== lastArtist || current.kind !== 'artist') show('artist', id)
	artistInput.blur()
	showArtistName()
}

async function show(kind, id) {
	const ticket = ++latest
	current = { kind, id, page: 0, total: 0, shown: 0 }
	if (kind === 'artist') lastArtist = id
	if (kind !== 'events') lastWorks = { kind, id }
	lockMenus()
	grid.replaceChildren()
	hideMuseums(museumPanel)
	moreButton.hidden = true
	countLabel.textContent = ''
	nameHeading.textContent = ''
	lifeLabel.textContent = ''
	showHeading()
	status(kind === 'events' ? 'LOADING EVENTS' : 'LOADING WORKS', true)
	history.replaceState(null, '', `?${kind}=${id}`)
	await (kind === 'events' ? loadEvents(ticket) : loadPage(ticket))
}

async function loadEvents(ticket) {
	let events
	try {
		events = await api('events', { type: current.id })
	} catch (error) {
		if (ticket === latest) status(error.message)
		return
	}
	if (ticket !== latest) return
	current.total = events.length
	current.shown = events.length
	current.loaded = true
	if (isMuseumView()) drawMuseums()
	if (current.id === 'museums-map') {
		status('')
		return
	}
	emptyNote(events.length)
	countLabel.textContent = events.length ? `${pad(events.length)} ${events.length === 1 ? 'EVENT' : 'EVENTS'}` : ''
	grid.replaceChildren(...events.map((event, index) => eventCard(event, index + 1)))
}

// What to say under an empty list. A museum's page may arrive before the
// museum list does, so this runs again once it has.
function emptyNote(found) {
	const type = eventTypes.get(current.id)
	if (found) status('')
	else if (type?.url) museumLink(type)
	else status('NOTHING LISTED HERE RIGHT NOW. GALLERY LISTINGS REFRESH EVERY FEW HOURS.')
}

// The museum map: every museum, or one museum's address and directions.
const isMuseumView = () => current.kind === 'events' && (current.id === 'museums-map' || current.id.startsWith('museum-'))

function drawMuseums() {
	const museums = [...eventTypes.values()].filter((type) => type.address)
	if (!museums.length) return // shown once the museum list arrives
	showMuseums(museumPanel, museums, current.id, pickMuseum)
	if (current.id === 'museums-map') countLabel.textContent = `${pad(museums.length)} MUSEUMS`
}

function pickMuseum(id) {
	eventsSelect.value = id
	show('events', id)
	museumPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// A museum whose exhibitions are not read here: point to its own page.
function museumLink(type) {
	const why = type.readable
		? 'NO EXHIBITIONS READ FROM THIS MUSEUM RIGHT NOW. '
		: `${type.name.toUpperCase()}'S EXHIBITIONS CAN'T BE LISTED HERE. `
	const link = document.createElement('a')
	link.href = type.url
	link.target = '_blank'
	link.rel = 'noopener'
	link.textContent = `SEE CURRENT EXHIBITIONS AT ${type.name.toUpperCase()} ↗`
	statusLine.replaceChildren(why, link)
	statusLine.classList.remove('is-loading')
}

// Event times are New York times without a zone; show them as written.
function parts(stamp) {
	const [, y, m, d, h, min] = stamp.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/).map(Number)
	return new Date(Date.UTC(y, m - 1, d, h, min))
}
const dayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })

function when(date) {
	const start = parts(date.start)
	const day = dayFormat.format(start)
	if (!date.end) return `${day}, ${timeFormat.format(start)}`
	return `${day}, ${timeFormat.format(start)}–${timeFormat.format(parts(date.end))}`
}

// Gallery dates come as YYYY-MM-DD.
function onDay(day) {
	const [y, m, d] = day.split('-').map(Number)
	return dayFormat.format(new Date(Date.UTC(y, m - 1, d)))
}

// One line saying when, for any kind of event.
function whenLine(event) {
	if (event.source === 'gallery') {
		if (event.opening) return `OPENS ${onDay(event.start)} — THROUGH ${onDay(event.end)}`
		return event.start ? `${onDay(event.start)} – ${onDay(event.end)}` : `THROUGH ${onDay(event.end)}`
	}
	if (event.source === 'discovered') return event.when || ''
	return eventDates(event)
}

// The small label above a card's title.
function placeLabel(event) {
	if (event.source === 'gallery') return `${event.venue} — ${event.area}`
	return event.borough ?? event.area ?? 'NYC'
}

function eventDates(event) {
	const more = event.dates.length - 1
	return more ? `${when(event.dates[0])} + ${more} MORE DATE${more > 1 ? 'S' : ''}` : when(event.dates[0])
}

function eventCard(event, number) {
	const figure = document.createElement('figure')
	figure.className = 'rw-look art-work art-event'

	const link = document.createElement('a')
	link.href = event.link
	link.target = '_blank'
	link.rel = 'noopener'
	link.title = 'View larger'
	link.addEventListener('click', (clicked) => {
		if (clicked.metaKey || clicked.ctrlKey || clicked.shiftKey || clicked.button !== 0) return
		clicked.preventDefault()
		openEvent(event, number)
	})
	if (event.image) {
		const image = document.createElement('img')
		image.src = event.image
		image.alt = ''
		image.loading = 'lazy'
		image.decoding = 'async'
		image.referrerPolicy = 'no-referrer'
		link.append(image)
	} else {
		const blank = document.createElement('div')
		blank.className = 'art-event-blank'
		blank.textContent = event.source === 'parks' ? dayFormat.format(parts(event.dates[0].start)) : event.venue || 'NYC'
		link.append(blank)
	}

	const caption = document.createElement('figcaption')
	const index = document.createElement('span')
	index.className = 'art-index'
	index.textContent = `${pad(number)} / ${placeLabel(event)}`
	const title = document.createElement('strong')
	title.className = 'art-title'
	title.textContent = `"${event.title}"`
	const date = document.createElement('span')
	date.className = 'art-when'
	date.textContent = whenLine(event)
	const place = document.createElement('span')
	place.className = 'art-meta'
	place.textContent = event.source === 'parks' ? event.location || event.park : event.source === 'discovered' ? event.venue : ''
	if (event.opening) figure.classList.add('is-opening')
	caption.append(index, title, date, place)

	figure.append(link, caption)
	return figure
}

function openEvent(event, number) {
	pinWork.hidden = !event.image
	viewerWork = event.image ? { src: event.image, caption: [event.title, event.venue].filter(Boolean).join(' — '), link: event.link } : null
	viewerIndex.textContent = `${pad(number)} / ${pad(current.total)} — ${placeLabel(event)}`
	viewerTitle.textContent = `"${event.title}"`
	if (event.source === 'parks') {
		const dates = event.dates.map(when)
		viewerMeta.textContent = [
			dates.length > 1 ? `${dates.length} DATES: ${dates.join(' / ')}` : dates[0],
			event.location || event.park,
			event.description,
		]
			.filter(Boolean)
			.join(' — ')
	} else {
		viewerMeta.textContent = [whenLine(event), event.venue, event.description].filter(Boolean).join(' — ')
	}
	viewerLink.href = event.link
	viewerLink.textContent =
		event.source === 'gallery' ? `VIEW AT ${event.venue.toUpperCase()} ↗` : event.source === 'discovered' ? 'VIEW EVENT ↗' : 'VIEW ON NYC PARKS ↗'
	viewer.classList.add('is-event')
	viewerImage.hidden = !event.image
	if (event.image) {
		viewerImage.alt = ''
		viewerImage.src = event.image
	} else {
		viewerImage.removeAttribute('src')
	}
	viewer.showModal()
}

async function loadPage(ticket) {
	moreButton.disabled = true
	let result
	try {
		result = await api('works', { [current.kind]: current.id, page: current.page + 1 })
	} catch (error) {
		if (ticket === latest) {
			status(error.message)
			moreButton.disabled = false
		}
		return
	}
	if (ticket !== latest) return
	current.page += 1
	current.total = result.total
	status(result.total ? '' : `NO WORKS FOUND FOR THIS ${current.kind.toUpperCase()}.`)
	countLabel.textContent = result.total ? `${count(result.total)} WORKS` : ''
	if (current.kind === 'artist' && !nameHeading.textContent && result.works[0]?.artist) {
		nameHeading.textContent = `"${result.works[0].artist}"`
		if (document.activeElement !== artistInput) showArtistName()
	}

	grid.append(...result.works.map((work) => card(work, ++current.shown)))
	moreButton.hidden = current.shown >= current.total
	moreButton.disabled = false
	moreButton.textContent = `LOAD MORE ↓  ${count(current.shown)} / ${count(current.total)}`
}

function card(work, number) {
	const figure = document.createElement('figure')
	figure.className = 'rw-look art-work'

	const link = document.createElement('a')
	link.href = work.link
	link.target = '_blank'
	link.rel = 'noopener'
	link.title = 'View larger'
	link.addEventListener('click', (event) => {
		// Cmd/Ctrl/Shift-click still opens the museum page in a new tab.
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
		event.preventDefault()
		openViewer(work, number)
	})

	const image = document.createElement('img')
	image.src = work.image
	image.alt = work.alt || `${work.title} by ${work.artist}`
	image.loading = 'lazy'
	image.decoding = 'async'
	link.append(image)

	const caption = document.createElement('figcaption')
	const index = document.createElement('span')
	index.className = 'art-index'
	index.textContent = `${pad(number)} / ${work.type ?? ''}`
	const title = document.createElement('strong')
	title.className = 'art-title'
	title.textContent = `"${work.title}"`
	const meta = document.createElement('span')
	meta.className = 'art-meta'
	// In a period the artist changes from piece to piece, so name them.
	const byline = current.kind === 'period' ? work.artist : null
	meta.textContent = [byline, work.date, work.medium].filter(Boolean).join(' — ')
	caption.append(index, title, meta)

	figure.append(link, caption)
	return figure
}

// Large view: shows the list picture at once, then swaps in the bigger one.
let viewerWork = null // what "+ CART" saves from the viewer
const pinWork = cartButton(() => viewerWork)
viewer.querySelector('.art-view-caption').append(pinWork)

function openViewer(work, number) {
	viewerWork = {
		// The size already loaded in the grid: the museum's large one takes half a minute.
		src: new URL(work.image, location.href).href,
		caption: [work.title, work.artist, work.date].filter(Boolean).join(' — '),
		link: work.link,
	}
	pinWork.hidden = false
	viewerLink.textContent = 'VIEW AT THE ART INSTITUTE ↗'
	viewer.classList.remove('is-event')
	viewerImage.hidden = false
	viewerIndex.textContent = `${count(number)} / ${count(current.total)} — ${work.type ?? ''}`
	viewerTitle.textContent = `"${work.title}"`
	viewerMeta.textContent = [work.artist, work.date, work.medium].filter(Boolean).join(' — ')
	viewerLink.href = work.link
	viewerImage.alt = work.alt || `${work.title} by ${work.artist}`
	viewerImage.src = work.image
	const large = new Image()
	large.onload = () => {
		if (viewer.open && viewerImage.src.endsWith(work.image)) viewerImage.src = large.src
	}
	large.src = `${work.image}?size=large`
	viewer.showModal()
}

viewer.querySelector('.art-view-close').addEventListener('click', () => viewer.close())
// Clicking anywhere except the museum link closes it.
viewer.addEventListener('click', (event) => {
	if (!event.target.closest('.art-view-link, .wb-add, .wb-toast')) viewer.close()
})

artistInput.addEventListener('focus', () => {
	artistInput.select()
	openArtists()
})
artistInput.addEventListener('input', () => openArtists(artistInput.value))
artistInput.addEventListener('blur', () => {
	closeArtists()
	showArtistName()
})
artistInput.addEventListener('keydown', (event) => {
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault()
		if (artistList.hidden) return openArtists()
		if (!artistOptions.length) return
		const step = event.key === 'ArrowDown' ? 1 : -1
		const n = artistOptions.length
		setActiveArtist(activeArtist < 0 ? (step > 0 ? 0 : n - 1) : (activeArtist + step + n) % n)
	} else if (event.key === 'Enter') {
		event.preventDefault()
		const item = artistOptions[activeArtist] ?? (artistInput.value.trim() ? artistOptions[0] : null)
		if (item) chooseArtist(Number(item.dataset.id))
	} else if (event.key === 'Escape') {
		event.preventDefault()
		closeArtists()
		artistInput.blur()
	}
})
// pointerdown keeps the box focused, so the list is still there for the click.
artistList.addEventListener('pointerdown', (event) => event.preventDefault())
artistList.addEventListener('click', (event) => {
	const item = event.target.closest('[role="option"]')
	if (item) chooseArtist(Number(item.dataset.id))
})
periodSelect.addEventListener('change', () => {
	if (periodSelect.value) show('period', periodSelect.value)
	else show('artist', lastArtist)
})
eventsSelect.addEventListener('change', () => {
	if (eventsSelect.value) show('events', eventsSelect.value)
	else show(lastWorks.kind, lastWorks.id)
})
moreButton.addEventListener('click', () => loadPage(latest))

const query = new URLSearchParams(location.search)
lastArtist = Number(query.get('artist')) || DEFAULT_ARTIST
if (query.get('events')) {
	eventsSelect.append(new Option('LOADING…', query.get('events')))
	show('events', query.get('events'))
} else if (query.get('period')) {
	// Shown as soon as the period list confirms it exists.
	periodSelect.append(new Option('LOADING…', query.get('period')))
	show('period', query.get('period'))
} else {
	show('artist', lastArtist)
}

api('periods')
	.then((list) => {
		periods = new Map(list.map((period) => [period.id, period]))
		periodSelect.replaceChildren(
			new Option('ALL PERIODS', ''),
			...list.map(({ id, name, works }) => new Option(`${name} (${works.toLocaleString('en-US')})`, id)),
		)
		periodSelect.value = current.kind === 'period' ? current.id : ''
		if (current.kind === 'period') showHeading()
	})
	.catch(() => {})

api('event-types')
	.then((list) => {
		eventTypes = new Map(list.map((type) => [type.id, type]))
		// Options grouped under GALLERIES / DISCOVERED / NYC PARKS headings.
		const groups = new Map()
		const top = []
		for (const { id, name, events, group, url } of list) {
			const label = id === 'museums-map' ? `${name} ◎` : events || !url ? `${name} (${events})` : name
			const option = new Option(label, id)
			if (!group) top.push(option)
			else {
				if (!groups.has(group)) {
					const optgroup = document.createElement('optgroup')
					optgroup.label = group
					groups.set(group, optgroup)
				}
				groups.get(group).append(option)
			}
		}
		eventsSelect.replaceChildren(new Option('OFF', ''), ...top, ...groups.values())
		eventsSelect.value = current.kind === 'events' ? current.id : ''
		if (current.kind === 'events') showHeading()
		if (isMuseumView()) drawMuseums()
		if (isMuseumView() && current.loaded && current.id !== 'museums-map') emptyNote(current.total)
	})
	.catch(() => {
		eventsSelect.replaceChildren(new Option('EVENTS COULD NOT BE LOADED', ''))
	})

api('artists')
	.then((people) => {
		artists = new Map(people.map((artist) => [artist.id, artist]))
		artistsReady = true
		if (current.kind === 'artist') showHeading()
		if (document.activeElement === artistInput) openArtists(artistInput.value)
		else showArtistName()
	})
	.catch(() => {
		artistsFailed = true
		if (document.activeElement === artistInput) openArtists()
	})
