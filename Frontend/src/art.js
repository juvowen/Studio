import './runway.css'

// Artworks come from the Art Institute of Chicago's public collection,
// looked up by the backend (Backend/server.py, /api/art/...), which also
// passes the pictures through. Only public-domain works with images are shown.
// NYC art events come from the city's NYC Parks events feed (NYC Open Data).
//
// Three menus, one active view: an artist, a period (locks the artist menu),
// or NYC events (locks both).
const DEFAULT_ARTIST = 35809 // Claude Monet

const artistSelect = document.querySelector('#art-artist')
const periodSelect = document.querySelector('#art-period')
const eventsSelect = document.querySelector('#art-events')
const artistLock = document.querySelector('.art-lock[data-for="artist"]')
const periodLock = document.querySelector('.art-lock[data-for="period"]')
const nameHeading = document.querySelector('#art-name')
const lifeLabel = document.querySelector('.art-life')
const countLabel = document.querySelector('.rw-count')
const statusLine = document.querySelector('.rw-status')
const grid = document.querySelector('.art-grid')
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
		lifeLabel.textContent = 'NYC — NEXT 14 DAYS'
		document.title = '"NYC ART EVENTS" – Studio'
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
	artistSelect.disabled = locked || !artistsReady
	if (!artistsReady) return // the list fills in and re-applies this when it arrives
	artistSelect.querySelector('option[value=""]')?.remove()
	if (locked) {
		artistSelect.prepend(new Option('ALL ARTISTS', ''))
		artistSelect.value = ''
	} else {
		artistSelect.value = String(lastArtist)
	}
}

async function show(kind, id) {
	const ticket = ++latest
	current = { kind, id, page: 0, total: 0, shown: 0 }
	if (kind === 'artist') lastArtist = id
	if (kind !== 'events') lastWorks = { kind, id }
	lockMenus()
	grid.replaceChildren()
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
	status(events.length ? '' : 'NO ART EVENTS OF THIS KIND IN THE NEXT 14 DAYS.')
	countLabel.textContent = events.length ? `${pad(events.length)} EVENTS` : ''
	grid.replaceChildren(...events.map((event, index) => eventCard(event, index + 1)))
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
		blank.textContent = dayFormat.format(parts(event.dates[0].start))
		link.append(blank)
	}

	const caption = document.createElement('figcaption')
	const index = document.createElement('span')
	index.className = 'art-index'
	index.textContent = `${pad(number)} / ${event.borough ?? 'NYC'}`
	const title = document.createElement('strong')
	title.className = 'art-title'
	title.textContent = `"${event.title}"`
	const date = document.createElement('span')
	date.className = 'art-when'
	date.textContent = eventDates(event)
	const place = document.createElement('span')
	place.className = 'art-meta'
	place.textContent = event.location || event.park
	caption.append(index, title, date, place)

	figure.append(link, caption)
	return figure
}

function openEvent(event, number) {
	viewerIndex.textContent = `${pad(number)} / ${pad(current.total)} — ${event.borough ?? 'NYC'}`
	viewerTitle.textContent = `"${event.title}"`
	const dates = event.dates.map(when)
	viewerMeta.textContent = [
		dates.length > 1 ? `${dates.length} DATES: ${dates.join(' / ')}` : dates[0],
		event.location || event.park,
		event.description,
	]
		.filter(Boolean)
		.join(' — ')
	viewerLink.href = event.link
	viewerLink.textContent = 'VIEW ON NYC PARKS ↗'
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
function openViewer(work, number) {
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
	if (!event.target.closest('.art-view-link')) viewer.close()
})

artistSelect.addEventListener('change', () => {
	if (artistSelect.value) show('artist', Number(artistSelect.value))
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
artistSelect.append(new Option('LOADING ARTISTS…', 'loading'))
artistSelect.disabled = true
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
		eventsSelect.replaceChildren(
			new Option('OFF', ''),
			...list.map(({ id, name, events }) => new Option(`${name} (${events})`, id)),
		)
		eventsSelect.value = current.kind === 'events' ? current.id : ''
		if (current.kind === 'events') showHeading()
	})
	.catch(() => {
		eventsSelect.replaceChildren(new Option('EVENTS COULD NOT BE LOADED', ''))
	})

api('artists')
	.then((people) => {
		artists = new Map(people.map((artist) => [artist.id, artist]))
		artistsReady = true
		artistSelect.replaceChildren(...people.map(({ id, name, works }) => new Option(`${name} (${works})`, id)))
		if (!artists.has(lastArtist)) {
			const name = current.kind === 'artist' ? nameHeading.textContent.replaceAll('"', '') : ''
			artistSelect.prepend(new Option(name || `ARTIST ${lastArtist}`, lastArtist))
		}
		lockArtists(current.kind !== 'artist')
		if (current.kind === 'artist') showHeading()
	})
	.catch(() => {
		artistSelect.replaceChildren(new Option('ARTISTS COULD NOT BE LOADED', ''))
	})
