import './music.css'

// The studio's music player: a music logo in the corner of every page.
// Visitors add their own MP3s; the files are kept in this browser (IndexedDB),
// so they're still there on the next visit. Each page is its own document, so
// the track, position and play state are saved as the visitor moves between
// pages, and the next page carries on from the same spot.
//
// Browsers can refuse to start sound on a new page before the visitor touches
// it. When that happens the music resumes on the first click or key press.

const DB_NAME = 'studio-music'
const STORE = 'tracks'
const STATE_KEY = 'studio-music-state' // { id, time, playing } for this tab

// ---- storage -------------------------------------------------------------

let dbPromise
function db() {
	dbPromise ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1)
		request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
	return dbPromise
}

async function run(mode, action) {
	const store = (await db()).transaction(STORE, mode).objectStore(STORE)
	return new Promise((resolve, reject) => {
		const request = action(store)
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

const loadTracks = () => run('readonly', (s) => s.getAll())
const saveTrack = (track) => run('readwrite', (s) => s.put(track))
const deleteTrack = (id) => run('readwrite', (s) => s.delete(id))

function readState() {
	try {
		return JSON.parse(sessionStorage.getItem(STATE_KEY)) || {}
	} catch {
		return {}
	}
}

function writeState() {
	try {
		const track = tracks[index]
		sessionStorage.setItem(
			STATE_KEY,
			JSON.stringify({ id: track?.id, time: audio.currentTime || 0, playing: wantsToPlay }),
		)
	} catch {
		// Storage can be blocked; the player still works on this page.
	}
}

// ---- markup --------------------------------------------------------------

const NOTE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V5.2l11-2.2v12.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.8" fill="currentColor"/><circle cx="17.5" cy="15.2" r="2.8" fill="currentColor"/></svg>`

const root = document.createElement('div')
root.className = 'mz'
root.innerHTML = `
	<section class="mz-panel" id="mz-panel" aria-label="Music" hidden>
		<div class="mz-head">
			<span>"MUSIC"</span>
			<button class="mz-close" type="button" aria-label="Close music">×</button>
		</div>
		<p class="mz-now" aria-live="polite"></p>
		<div class="mz-controls">
			<button class="mz-prev" type="button" aria-label="Previous track">◀◀</button>
			<button class="mz-play" type="button" aria-label="Play">PLAY</button>
			<button class="mz-next" type="button" aria-label="Next track">▶▶</button>
		</div>
		<input class="mz-seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="Position" />
		<ol class="mz-list" aria-label="Tracks"></ol>
		<label class="mz-add">
			+ ADD MP3S
			<input type="file" accept="audio/mpeg,.mp3" multiple />
		</label>
	</section>
	<button class="mz-logo" type="button" aria-label="Music" aria-expanded="false" aria-controls="mz-panel">
		${NOTE}
		<span class="mz-bars" aria-hidden="true"><i></i><i></i><i></i></span>
	</button>
`
document.body.append(root)

const panel = root.querySelector('.mz-panel')
const logo = root.querySelector('.mz-logo')
const closeButton = root.querySelector('.mz-close')
const nowLine = root.querySelector('.mz-now')
const playButton = root.querySelector('.mz-play')
const prevButton = root.querySelector('.mz-prev')
const nextButton = root.querySelector('.mz-next')
const seek = root.querySelector('.mz-seek')
const list = root.querySelector('.mz-list')
const fileInput = root.querySelector('.mz-add input')

// ---- player --------------------------------------------------------------

const audio = new Audio()
audio.preload = 'auto'

let tracks = [] // { id, name, blob, added }
let index = -1
let objectUrl = ''
let wantsToPlay = false // what the visitor asked for, even if the browser is holding off

function trackName(file) {
	return file.name.replace(/\.mp3$/i, '')
}

function load(i, time = 0) {
	index = i
	if (objectUrl) URL.revokeObjectURL(objectUrl)
	objectUrl = ''
	const track = tracks[i]
	if (!track) {
		audio.removeAttribute('src')
		audio.load()
		render()
		return
	}
	objectUrl = URL.createObjectURL(track.blob)
	audio.src = objectUrl
	if (time > 0) {
		audio.addEventListener('loadedmetadata', () => (audio.currentTime = Math.min(time, audio.duration || time)), {
			once: true,
		})
	}
	render()
}

function play() {
	if (!tracks.length) return
	if (index < 0) load(0)
	wantsToPlay = true
	audio.play().catch(waitForGesture)
	render()
	writeState()
}

function pause() {
	wantsToPlay = false
	audio.pause()
	render()
	writeState()
}

function step(by) {
	if (!tracks.length) return
	load((index + by + tracks.length) % tracks.length)
	if (wantsToPlay) play()
	else writeState()
}

// Autoplay was blocked: start on the visitor's first interaction with the page.
function waitForGesture() {
	const resume = (event) => {
		removeEventListener('pointerdown', resume, true)
		removeEventListener('keydown', resume, true)
		// A click on the play button handles itself.
		if (event.target.closest?.('.mz-play')) return
		if (wantsToPlay) audio.play().catch(() => {})
	}
	addEventListener('pointerdown', resume, true)
	addEventListener('keydown', resume, true)
}

async function addFiles(files) {
	const fresh = [...files].filter((f) => f.type === 'audio/mpeg' || /\.mp3$/i.test(f.name))
	if (!fresh.length) return
	const now = Date.now()
	const added = fresh.map((file, n) => ({
		id: `${now}-${n}-${Math.random().toString(36).slice(2, 8)}`,
		name: trackName(file),
		blob: file,
		added: now + n,
	}))
	tracks.push(...added)
	render()
	try {
		await Promise.all(added.map(saveTrack))
	} catch {
		nowLine.textContent = 'COULD NOT SAVE — PLAYING THIS PAGE ONLY'
	}
	// Start right away with the first new song when nothing is playing.
	if (!wantsToPlay) {
		load(tracks.indexOf(added[0]))
		play()
	}
}

async function removeTrack(i) {
	const [gone] = tracks.splice(i, 1)
	deleteTrack(gone.id).catch(() => {})
	if (i === index) {
		const keepPlaying = wantsToPlay
		audio.pause()
		load(tracks.length ? i % tracks.length : -1)
		if (keepPlaying && tracks.length) play()
		else wantsToPlay = false
	} else if (i < index) {
		index -= 1
	}
	render()
	writeState()
}

// ---- view ----------------------------------------------------------------

function formatTime(s) {
	if (!Number.isFinite(s)) return '0:00'
	return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function render() {
	const track = tracks[index]
	const playing = wantsToPlay && !!track
	root.classList.toggle('is-playing', playing && !audio.paused)
	playButton.textContent = playing ? 'PAUSE' : 'PLAY'
	playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play')
	for (const b of [playButton, prevButton, nextButton]) b.disabled = !tracks.length
	seek.disabled = !track
	nowLine.textContent = track
		? `${String(index + 1).padStart(2, '0')} / ${track.name}`
		: tracks.length
			? 'PRESS PLAY'
			: 'NO SONGS YET — ADD YOUR MP3S'
	logo.title = track ? `Music: ${track.name}` : 'Music'

	list.replaceChildren(
		...tracks.map((t, i) => {
			const item = document.createElement('li')
			if (i === index) item.className = 'is-current'
			const pick = document.createElement('button')
			pick.type = 'button'
			pick.className = 'mz-track'
			pick.textContent = t.name
			pick.addEventListener('click', () => {
				if (i === index) return wantsToPlay ? pause() : play()
				load(i)
				play()
			})
			const remove = document.createElement('button')
			remove.type = 'button'
			remove.className = 'mz-remove'
			remove.textContent = '×'
			remove.setAttribute('aria-label', `Remove ${t.name}`)
			remove.addEventListener('click', () => removeTrack(i))
			item.append(pick, remove)
			return item
		}),
	)
}

function renderTime() {
	if (!document.activeElement?.isSameNode(seek)) {
		seek.max = String(audio.duration || 0)
		seek.value = String(audio.currentTime || 0)
	}
	const track = tracks[index]
	if (track) {
		nowLine.textContent = `${String(index + 1).padStart(2, '0')} / ${track.name} — ${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`
	}
}

function setOpen(open) {
	panel.hidden = !open
	logo.setAttribute('aria-expanded', String(open))
}

// ---- wiring --------------------------------------------------------------

logo.addEventListener('click', () => setOpen(panel.hidden))
closeButton.addEventListener('click', () => setOpen(false))
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && !panel.hidden) setOpen(false)
})
document.addEventListener('click', (e) => {
	// The path, not e.target: the track list re-renders, detaching the clicked button.
	if (!panel.hidden && !e.composedPath().includes(root)) setOpen(false)
})

playButton.addEventListener('click', () => (wantsToPlay ? pause() : play()))
prevButton.addEventListener('click', () => (audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1)))
nextButton.addEventListener('click', () => step(1))
seek.addEventListener('input', () => (audio.currentTime = Number(seek.value)))
fileInput.addEventListener('change', () => {
	addFiles(fileInput.files)
	fileInput.value = ''
})

// Let visitors drop MP3s onto the open panel too.
panel.addEventListener('dragover', (e) => e.preventDefault())
panel.addEventListener('drop', (e) => {
	e.preventDefault()
	addFiles(e.dataTransfer.files)
})

audio.addEventListener('ended', () => step(1))
audio.addEventListener('play', render)
audio.addEventListener('pause', render)
audio.addEventListener('loadedmetadata', renderTime)

let lastSaved = 0
audio.addEventListener('timeupdate', () => {
	renderTime()
	if (Date.now() - lastSaved > 1000) {
		lastSaved = Date.now()
		writeState()
	}
})
// Save the exact spot when leaving for Runway, Art Studio or the front page.
addEventListener('pagehide', writeState)

// Coming back with the browser's Back button can restore a frozen page.
addEventListener('pageshow', (e) => {
	if (e.persisted && wantsToPlay && audio.paused) audio.play().catch(waitForGesture)
})

// ---- start ---------------------------------------------------------------

async function start() {
	try {
		tracks = (await loadTracks()).sort((a, b) => a.added - b.added)
	} catch {
		tracks = []
	}
	const saved = readState()
	const at = tracks.findIndex((t) => t.id === saved.id)
	if (at >= 0) {
		load(at, saved.time || 0)
		if (saved.playing) play()
	} else {
		render()
	}
}

start()
