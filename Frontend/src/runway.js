import './runway.css'
import './music.js'
import { openPieces, setUpPieces } from './lookalikes.js'
import { cartButton } from './board-store.js'
import './cart.js'
import { accountLink } from './auth.js'

// Opens on this show when someone clicks the Runway window.
const DEFAULT = { designer: 'OFF-WHITE', show: 'Fall 2020 Ready-to-Wear' }

const designerSelect = document.querySelector('#runway-designer') // the brand search box
const lineSelect = document.querySelector('#runway-line')
const yearSelect = document.querySelector('#runway-year')
const showSelect = document.querySelector('#runway-show')
const designerHeading = document.querySelector('.rw-designer')
const seasonLabel = document.querySelector('.rw-season')
const countLabel = document.querySelector('.rw-count')
const statusLine = document.querySelector('.rw-status')
const grid = document.querySelector('.rw-grid')

let designer = ''
let shows = [] // every show of the brand
let lineShows = [] // the ones in the chosen line
const viewer = document.querySelector('.art-view')
const viewerImage = viewer.querySelector('img')
const viewerIndex = viewer.querySelector('.art-view-index')
const viewerTitle = viewer.querySelector('#rw-view-title')
const viewerMeta = viewer.querySelector('.art-view-meta')
const viewerLink = viewer.querySelector('.art-view-link')

let latest = 0 // ignores answers to requests the visitor has since replaced
const showImages = new Map() // picture lists already asked for, by brand and show

async function api(path, params = {}) {
	// The backend answers from memory, so always ask it rather than the browser cache.
	const response = await fetch(`/api/${path}?${new URLSearchParams(params)}`, { cache: 'no-store' })
	const data = await response.json().catch(() => ({}))
	if (!response.ok) throw new Error(data.error || 'Vogue Runway could not be reached.')
	return data
}

function getShow(name, show) {
	const key = `${name}\n${show}`
	if (!showImages.has(key)) {
		const request = api('show', { designer: name, show })
		request.catch(() => showImages.delete(key))
		showImages.set(key, request)
	}
	return showImages.get(key)
}

// Quietly asks for the shows the visitor is likely to pick next, two at a
// time, so switching to them is instant. A newer pick replaces the queue.
let prefetchQueue = []
let prefetching = 0
function prefetch(name, list) {
	prefetchQueue = list.filter((show) => !showImages.has(`${name}\n${show}`)).map((show) => [name, show])
	while (prefetching < 2 && prefetchQueue.length) prefetchNext()
}
function prefetchNext() {
	const next = prefetchQueue.shift()
	if (!next) return
	prefetching++
	getShow(...next)
		.catch(() => {})
		.finally(() => {
			prefetching--
			prefetchNext()
		})
}

// The grid shows looks at most ~300px wide, so 640px pictures are sharp enough
// at half the download of the 1024px ones; the large view still gets 2048px.
const thumbnail = (src) => src.replace('/w_1024,', '/w_640,')

const yearOf = (show) => show.match(/\b(19|20)\d\d\b/)?.[0] ?? 'Other'

// Vogue names men's shows "… Menswear"; Ready-to-Wear, Resort, Pre-Fall and
// Couture are the women's (sometimes co-ed) collections.
const lineOf = (show) => (/menswear/i.test(show) ? 'MENSWEAR' : 'WOMENSWEAR')
const LINE_KEY = 'runway-line'

function savedLine() {
	try {
		return localStorage.getItem(LINE_KEY)
	} catch {
		return null
	}
}

function setOptions(select, values, selected) {
	select.replaceChildren(...values.map((value) => new Option(value, value)))
	select.disabled = values.length === 0
	if (values.includes(selected)) select.value = selected
}

const quoted = (text) => `"${text}"`
const pad = (number) => String(number).padStart(2, '0')

function status(text, loading = false) {
	statusLine.textContent = text
	statusLine.classList.toggle('is-loading', loading)
	grid.replaceChildren()
	countLabel.textContent = ''
}

async function pickDesigner(name, wantedShow) {
	const ticket = ++latest
	designer = name
	shows = []
	showDesigner(name)
	setOptions(yearSelect, [])
	setOptions(showSelect, [])
	designerHeading.textContent = quoted(name)
	seasonLabel.textContent = ''
	status('LOADING SHOWS', true)
	try {
		shows = await api('shows', { designer: name })
	} catch (error) {
		if (ticket === latest) status(error.message)
		return
	}
	if (ticket !== latest) return
	pickLine(wantedShow)
	// Also the newest show of each line, which the line menu jumps to.
	const firsts = ['MENSWEAR', 'WOMENSWEAR'].map((line) => shows.find(({ show }) => lineOf(show) === line)?.show)
	prefetch(name, [...prefetchQueue.map(([, show]) => show), ...firsts.filter(Boolean)])
}

function pickLine(wantedShow) {
	const line = lineSelect.value
	lineShows = line === 'ALL' ? shows : shows.filter(({ show }) => lineOf(show) === line)
	if (lineShows.length === 0) {
		latest++
		setOptions(yearSelect, [])
		setOptions(showSelect, [])
		seasonLabel.textContent = ''
		status(`NO ${line} SHOWS FOR ${designer}`)
		return
	}
	const wanted = lineShows.find(({ show }) => show === wantedShow) ?? lineShows[0]
	const years = [...new Set(lineShows.map(({ show }) => yearOf(show)))]
	setOptions(yearSelect, years, yearOf(wanted.show))
	pickYear(wanted.show)
}

function pickYear(wantedShow) {
	const inYear = lineShows.filter(({ show }) => yearOf(show) === yearSelect.value).map(({ show }) => show)
	setOptions(showSelect, inYear, wantedShow)
	loadShow()
	// The other shows that year, then the next year's.
	const years = [...yearSelect.options].map((option) => option.value)
	const nextYear = years[years.indexOf(yearSelect.value) + 1]
	const later = lineShows.filter(({ show }) => yearOf(show) === nextYear).map(({ show }) => show)
	prefetch(designer, [...inYear, ...later])
}

async function loadShow() {
	const ticket = ++latest
	const show = showSelect.value
	seasonLabel.textContent = show
	status('LOADING LOOKS', true)
	const reopen = Number(new URLSearchParams(location.search).get('look')) // e.g. back from signing in
	history.replaceState(null, '', `?${new URLSearchParams({ designer, line: lineSelect.value, show })}`)
	let images
	try {
		images = await getShow(designer, show)
	} catch (error) {
		if (ticket === latest) status(error.message)
		return
	}
	if (ticket !== latest) return
	statusLine.textContent = ''
	statusLine.classList.remove('is-loading')
	countLabel.textContent = `${pad(images.length)} LOOKS`
	document.title = `"${designer}" ${show} – Studio`
	grid.replaceChildren(
		...images.map((src, index) => {
			const look = document.createElement('figure')
			look.className = 'rw-look'

			const open = document.createElement('button')
			open.type = 'button'
			open.className = 'rw-look-open'
			open.addEventListener('click', () => openViewer(thumbnail(src), src, index, images.length, show))

			const image = document.createElement('img')
			image.src = thumbnail(src)
			image.alt = `${designer} ${show}, look ${index + 1}`
			image.loading = 'lazy'
			image.decoding = 'async'
			image.referrerPolicy = 'no-referrer'
			open.append(image)

			const caption = document.createElement('figcaption')
			const number = document.createElement('span')
			number.textContent = `LOOK ${pad(index + 1)}`
			const total = document.createElement('span')
			total.textContent = `/${pad(images.length)}`
			caption.append(number, total)

			look.append(open, caption)
			return look
		}),
	)
	if (reopen >= 1 && reopen <= images.length) grid.querySelectorAll('.rw-look-open')[reopen - 1].click()
}

// The show's page on Vogue Runway, built the same way the scraper builds it.
function vogueLink(name, show) {
	const plain = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
	const brand = name.replace(/ /g, '-').replace(/\./g, '-').replace(/&/g, '').replace(/\+/g, '').replace(/--/g, '-')
	return `https://www.vogue.com/fashion-shows/${plain(show.replace(/ /g, '-'))}/${plain(brand)}`
}

// Large view: shows the grid picture at once, then swaps in Vogue's 2048px one.
let viewerLook = null // what "+ CART" saves from the viewer
viewer.querySelector('.rw-view-actions').prepend(cartButton(() => viewerLook))

function openViewer(src, fullSrc, index, total, show) {
	const address = new URL(location.href)
	address.searchParams.set('look', index + 1)
	history.replaceState(null, '', address)
	viewerLook = {
		src: fullSrc,
		caption: `${designer} — ${show} — LOOK ${pad(index + 1)}`,
		link: vogueLink(designer, show),
	}
	viewerIndex.textContent = `LOOK ${pad(index + 1)} / ${pad(total)}`
	viewerTitle.textContent = `"${designer}"`
	viewerMeta.textContent = show
	viewerLink.href = vogueLink(designer, show)
	viewerImage.alt = `${designer} ${show}, look ${index + 1}`
	viewerImage.src = src
	const largeSrc = fullSrc.replace('/w_1024,', '/w_2048,')
	if (largeSrc !== src) {
		const large = new Image()
		large.referrerPolicy = 'no-referrer'
		large.onload = () => {
			if (viewer.open && viewerImage.src === src) viewerImage.src = largeSrc
		}
		large.src = largeSrc
	}
	viewer.showModal()
	openPieces(fullSrc, designer, show)
}

viewer.querySelector('.art-view-close').addEventListener('click', () => viewer.close())
viewer.addEventListener('close', () => {
	const address = new URL(location.href)
	address.searchParams.delete('look')
	history.replaceState(null, '', address)
})
setUpPieces(viewer)
// Clicking anywhere except the links, the pieces and their panel closes it.
viewer.addEventListener('click', (event) => {
	if (!event.target.closest('.art-view-link, .rw-find, .rw-hotspot, .rw-lookalikes, .wb-add, .wb-toast')) viewer.close()
})

// ---- Brand search -------------------------------------------------------
const brandList = document.querySelector('#runway-brands')
let brands = { popular: [], all: [] }
let options = [] // the list items that can be picked, in order
let active = -1 // the one the arrow keys are on

// "Off White", "offwhite" and "OFF-WHITE" all find OFF-WHITE; accents are ignored.
const fold = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const squash = (text) => fold(text).replace(/[^a-z0-9]/g, '')

// Brands that start with the search come first, then ones with a word that
// does, then any other match.
function search(text) {
	const wanted = fold(text).trim()
	const tight = squash(text)
	if (!tight) return []
	const ranked = []
	for (const name of brands.all) {
		const loose = fold(name)
		const squashed = squash(name)
		let rank
		if (squashed.startsWith(tight)) rank = 0
		else if (loose.split(/[^a-z0-9]+/).some((word) => word.startsWith(wanted))) rank = 1
		else if (squashed.includes(tight)) rank = 2
		else continue
		ranked.push({ name, rank })
	}
	return ranked.sort((a, b) => a.rank - b.rank).map(({ name }) => name)
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

function heading(text, className = 'rw-brands-group') {
	const item = document.createElement('li')
	item.className = className
	item.setAttribute('role', 'presentation')
	item.textContent = text
	return item
}

function choice(name, text) {
	const item = document.createElement('li')
	item.id = `rw-brand-${options.length}`
	item.setAttribute('role', 'option')
	item.setAttribute('aria-selected', 'false')
	item.dataset.name = name
	item.classList.toggle('is-current', name === designer)
	item.append(...highlighted(name, text))
	options.push(item)
	return item
}

function openBrands(text = '') {
	options = []
	active = -1
	const items = []
	if (!text.trim()) {
		if (brands.popular.length) items.push(heading('POPULAR'), ...brands.popular.map((name) => choice(name, '')))
		if (brands.all.length) items.push(heading('ALL BRANDS A–Z'), ...brands.all.map((name) => choice(name, '')))
		if (!items.length) items.push(heading('LOADING BRANDS', 'rw-brands-empty'))
	} else {
		const found = search(text)
		const shown = found.slice(0, 80)
		items.push(...shown.map((name) => choice(name, text)))
		if (!found.length) items.push(heading(brands.all.length ? 'NO BRAND MATCHES' : 'LOADING BRANDS', 'rw-brands-empty'))
		else if (found.length > shown.length) items.push(heading(`${found.length - shown.length} MORE — KEEP TYPING`, 'rw-brands-empty'))
		if (found.length) setActive(0)
	}
	brandList.replaceChildren(...items)
	brandList.hidden = false
	designerSelect.setAttribute('aria-expanded', 'true')
	if (!text.trim()) options.find((item) => item.dataset.name === designer)?.scrollIntoView({ block: 'center' })
}

function closeBrands() {
	brandList.hidden = true
	brandList.replaceChildren()
	options = []
	active = -1
	designerSelect.setAttribute('aria-expanded', 'false')
	designerSelect.removeAttribute('aria-activedescendant')
}

function setActive(index) {
	options[active]?.setAttribute('aria-selected', 'false')
	active = index
	const item = options[active]
	if (!item) return designerSelect.removeAttribute('aria-activedescendant')
	item.setAttribute('aria-selected', 'true')
	item.scrollIntoView({ block: 'nearest' })
	designerSelect.setAttribute('aria-activedescendant', item.id)
}

function chooseBrand(name) {
	closeBrands()
	if (name !== designer) pickDesigner(name)
	else showDesigner(name)
	designerSelect.blur()
}

// Puts the current brand back in the box.
function showDesigner(name) {
	designerSelect.value = name
}

designerSelect.addEventListener('focus', () => {
	designerSelect.select()
	openBrands()
})
designerSelect.addEventListener('input', () => openBrands(designerSelect.value))
designerSelect.addEventListener('blur', () => {
	closeBrands()
	showDesigner(designer)
})
designerSelect.addEventListener('keydown', (event) => {
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault()
		if (brandList.hidden) return openBrands(designerSelect.value === designer ? '' : designerSelect.value)
		if (!options.length) return
		const step = event.key === 'ArrowDown' ? 1 : -1
		setActive(active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length)
	} else if (event.key === 'Enter') {
		event.preventDefault()
		const item = options[active] ?? options[0]
		if (item) chooseBrand(item.dataset.name)
	} else if (event.key === 'Escape') {
		event.preventDefault()
		closeBrands()
		showDesigner(designer)
		designerSelect.blur()
	}
})
// pointerdown keeps the box focused, so the list is still there for the click.
brandList.addEventListener('pointerdown', (event) => event.preventDefault())
brandList.addEventListener('click', (event) => {
	const item = event.target.closest('[role="option"]')
	if (item) chooseBrand(item.dataset.name)
})
lineSelect.addEventListener('change', () => {
	try {
		localStorage.setItem(LINE_KEY, lineSelect.value)
	} catch {}
	if (shows.length) pickLine(showSelect.value)
})
yearSelect.addEventListener('change', () => pickYear())
showSelect.addEventListener('change', loadShow)

const query = new URLSearchParams(location.search)
const start = query.has('designer')
	? { designer: query.get('designer'), show: query.get('show') }
	: DEFAULT

const line = query.get('line') ?? savedLine()
if ([...lineSelect.options].some((option) => option.value === line)) lineSelect.value = line
if (start.show && lineSelect.value !== 'ALL' && lineOf(start.show) !== lineSelect.value) start.show = null

// Ask for the opening show alongside the brand's show list instead of after it.
if (start.show) getShow(start.designer, start.show)

pickDesigner(start.designer, start.show)

api('designers')
	.then(({ popular, all }) => {
		brands = { popular, all }
		if (!brandList.hidden) openBrands(designerSelect.value === designer ? '' : designerSelect.value)
	})
	.catch(() => {})

// SIGN IN / SIGN OUT in the top bar.
document.querySelector('.rw-top-end').prepend(accountLink())
