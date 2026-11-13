import './runway.css'

// Opens on this show when someone clicks the Runway window.
const DEFAULT = { designer: 'OFF-WHITE', show: 'Fall 2020 Ready-to-Wear' }

const designerSelect = document.querySelector('#runway-designer')
const yearSelect = document.querySelector('#runway-year')
const showSelect = document.querySelector('#runway-show')
const designerHeading = document.querySelector('.rw-designer')
const seasonLabel = document.querySelector('.rw-season')
const countLabel = document.querySelector('.rw-count')
const statusLine = document.querySelector('.rw-status')
const grid = document.querySelector('.rw-grid')

let designer = ''
let shows = []
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

const yearOf = (show) => show.match(/\b(19|20)\d\d\b/)?.[0] ?? 'Other'

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
	const wanted = shows.find(({ show }) => show === wantedShow) ?? shows[0]
	const years = [...new Set(shows.map(({ show }) => yearOf(show)))]
	setOptions(yearSelect, years, yearOf(wanted.show))
	pickYear(wanted.show)
}

function pickYear(wantedShow) {
	const inYear = shows.filter(({ show }) => yearOf(show) === yearSelect.value).map(({ show }) => show)
	setOptions(showSelect, inYear, wantedShow)
	loadShow()
}

async function loadShow() {
	const ticket = ++latest
	const show = showSelect.value
	seasonLabel.textContent = show
	status('LOADING LOOKS', true)
	history.replaceState(null, '', `?${new URLSearchParams({ designer, show })}`)
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
			open.addEventListener('click', () => openViewer(src, index, images.length, show))

			const image = document.createElement('img')
			image.src = src
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
}

// The show's page on Vogue Runway, built the same way the scraper builds it.
function vogueLink(name, show) {
	const plain = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
	const brand = name.replace(/ /g, '-').replace(/\./g, '-').replace(/&/g, '').replace(/\+/g, '').replace(/--/g, '-')
	return `https://www.vogue.com/fashion-shows/${plain(show.replace(/ /g, '-'))}/${plain(brand)}`
}

// Large view: shows the grid picture at once, then swaps in Vogue's 2048px one.
function openViewer(src, index, total, show) {
	viewerIndex.textContent = `LOOK ${pad(index + 1)} / ${pad(total)}`
	viewerTitle.textContent = `"${designer}"`
	viewerMeta.textContent = show
	viewerLink.href = vogueLink(designer, show)
	viewerImage.alt = `${designer} ${show}, look ${index + 1}`
	viewerImage.src = src
	const largeSrc = src.replace('/w_1024,', '/w_2048,')
	if (largeSrc !== src) {
		const large = new Image()
		large.referrerPolicy = 'no-referrer'
		large.onload = () => {
			if (viewer.open && viewerImage.src === src) viewerImage.src = largeSrc
		}
		large.src = largeSrc
	}
	viewer.showModal()
}

viewer.querySelector('.art-view-close').addEventListener('click', () => viewer.close())
// Clicking anywhere except the Vogue link closes it.
viewer.addEventListener('click', (event) => {
	if (!event.target.closest('.art-view-link')) viewer.close()
})

// Selects the brand in the menu, adding it if the list has not loaded yet.
function showDesigner(name) {
	if (![...designerSelect.options].some((option) => option.value === name)) {
		designerSelect.prepend(new Option(name, name))
	}
	designerSelect.value = name
}

function group(label, names) {
	const optgroup = document.createElement('optgroup')
	optgroup.label = label
	optgroup.append(...names.map((name) => new Option(name, name)))
	return optgroup
}

designerSelect.addEventListener('change', () => pickDesigner(designerSelect.value))
yearSelect.addEventListener('change', () => pickYear())
showSelect.addEventListener('change', loadShow)

const query = new URLSearchParams(location.search)
const start = query.has('designer')
	? { designer: query.get('designer'), show: query.get('show') }
	: DEFAULT

// Ask for the opening show alongside the brand's show list instead of after it.
if (start.show) getShow(start.designer, start.show)

pickDesigner(start.designer, start.show)

api('designers')
	.then(({ popular, all }) => {
		designerSelect.replaceChildren(group('POPULAR', popular), group('ALL BRANDS A–Z', all))
		showDesigner(designer)
	})
	.catch(() => {})
