// Click a piece of a runway look (the boots, the jacket...) to shop it.
// As soon as a look opens, Gemini marks its pieces (Backend/lookalikes.py,
// /api/pieces); each becomes a clickable spot on the picture. Clicking one opens
// the side panel with that piece cropped and two product lists from
// /api/piece/shop: SHOP THE ORIGINAL (the designer's own piece, new or resale)
// and LOOKALIKES from other brands.

import { cartButton } from './board-store.js'
import { askToSignIn, authHeaders, onAuth, signedIn } from './auth.js'

const SIGN_IN_WHY = 'SIGN IN TO FIND THE PIECES IN A LOOK AND SHOP THEM.'

const piecesFor = new Map() // picture -> request for its pieces
const productsFor = new Map() // picture + piece -> request for its products
const detailsFor = new Map() // picture + piece -> request for its products' photos and prices
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)

let state = { src: '', designer: '', show: '', pieces: [], chosen: -1 }
let viewer, frame, image, layer, panel, button

function element(tag, className, text) {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text != null) node.textContent = text
	return node
}

function link(text, href, className) {
	const a = element('a', className, text)
	a.href = href
	a.target = '_blank'
	a.rel = 'noopener'
	return a
}

async function getJSON(path, params) {
	const response = await fetch(`${path}?${new URLSearchParams(params)}`, { headers: authHeaders() })
	const data = await response.json().catch(() => ({}))
	if (response.status === 401) {
		askToSignIn(SIGN_IN_WHY)
		throw new Error('Sign in to find pieces.')
	}
	if (!response.ok) throw new Error(data.error || 'Gemini could not be reached.')
	return data
}

function remember(cache, key, load) {
	if (!cache.has(key)) {
		const request = load()
		request.catch(() => cache.delete(key)) // a failed try is asked again next time
		cache.set(key, request)
	}
	return cache.get(key)
}

const pieceImage = (index) => `/api/piece/image?${new URLSearchParams({ image: state.src, piece: index })}`
const shopping = (words) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(words)}`
const lens = (address) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(address)}`

/** Call once with the viewer dialog. */
export function setUpPieces(dialog) {
	viewer = dialog
	frame = viewer.querySelector('.art-view-frame')
	image = frame.querySelector('img')
	panel = viewer.querySelector('.rw-lookalikes')
	button = viewer.querySelector('.rw-find')
	layer = element('div', 'rw-hotspots')
	frame.append(layer)
	image.addEventListener('load', placeLayer)
	new ResizeObserver(placeLayer).observe(frame)
	button.addEventListener('click', () => {
		if (!signedIn()) askToSignIn(SIGN_IN_WHY)
		else if (state.pieces.length) viewer.classList.toggle('hide-pieces')
		else if (!button.disabled) findPieces()
	})
	// Signing in (or out) while a look is open.
	onAuth(() => {
		if (!state.src) return
		if (signedIn()) {
			if (!state.pieces.length) findPieces()
		} else openPieces(state.src, state.designer, state.show)
	})
}

/** Call whenever the viewer shows a new picture (`src` = the full-size address). */
export function openPieces(src, designer, show) {
	state = { src, designer, show, pieces: [], chosen: -1 }
	viewer.classList.remove('has-looks', 'hide-pieces')
	panel.replaceChildren()
	layer.replaceChildren()
	if (signedIn()) return findPieces()
	button.disabled = false
	button.classList.remove('is-loading')
	button.textContent = 'SIGN IN TO FIND PIECES ◎'
}

async function findPieces() {
	const { src } = state
	button.disabled = true
	button.textContent = 'FINDING PIECES…'
	button.classList.add('is-loading')
	let pieces
	try {
		pieces = await remember(piecesFor, src, () =>
			getJSON('/api/pieces', { image: src, designer: state.designer, show: state.show }),
		)
	} catch (error) {
		if (state.src !== src) return
		button.disabled = false
		button.classList.remove('is-loading')
		button.textContent = 'FIND PIECES — TRY AGAIN'
		button.title = error.message
		return
	}
	if (state.src !== src) return
	state.pieces = pieces
	button.classList.remove('is-loading')
	button.disabled = !pieces.length
	button.title = ''
	button.textContent = pieces.length ? `CLICK A PIECE ◎ ${String(pieces.length).padStart(2, '0')}` : 'NO PIECES FOUND'
	drawSpots()
}

// The picture is fitted inside the frame ("contain"), so the spots' layer is
// sized to the picture itself, not the frame.
function placeLayer() {
	if (!image.naturalWidth) return
	const scale = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight)
	const width = image.naturalWidth * scale
	const height = image.naturalHeight * scale
	Object.assign(layer.style, {
		left: `${image.offsetLeft + (image.clientWidth - width) / 2}px`,
		top: `${image.offsetTop + (image.clientHeight - height) / 2}px`,
		width: `${width}px`,
		height: `${height}px`,
	})
}

function drawSpots() {
	placeLayer()
	// Bigger pieces first, so smaller ones (a necklace on a jacket) sit on top.
	const order = state.pieces
		.map((piece, index) => ({ piece, index, area: (piece.box[2] - piece.box[0]) * (piece.box[3] - piece.box[1]) }))
		.sort((a, b) => b.area - a.area)
	layer.replaceChildren(
		...order.map(({ piece, index }) => {
			const [top, left, bottom, right] = piece.box
			const spot = element('button', 'rw-hotspot')
			spot.type = 'button'
			spot.dataset.index = index
			spot.setAttribute('aria-label', `Find ${piece.name}`)
			Object.assign(spot.style, {
				top: `${top / 10}%`,
				left: `${left / 10}%`,
				height: `${(bottom - top) / 10}%`,
				width: `${(right - left) / 10}%`,
			})
			spot.append(element('span', 'rw-hotspot-label', piece.name))
			spot.addEventListener('click', () => choosePiece(index))
			// Resting on a piece starts its search, so it is often ready by the click.
			let dwell
			spot.addEventListener('pointerenter', () => (dwell = setTimeout(() => shopFor(index).catch(() => {}), 350)))
			spot.addEventListener('pointerleave', () => clearTimeout(dwell))
			return spot
		}),
	)
}

async function choosePiece(index) {
	const piece = state.pieces[index]
	const { src } = state
	state.chosen = index
	viewer.classList.add('has-looks')
	for (const spot of layer.children) spot.classList.toggle('is-chosen', Number(spot.dataset.index) === index)

	const head = element('p', 'rw-piece-count', `PIECE ${String(index + 1).padStart(2, '0')} / ${String(state.pieces.length).padStart(2, '0')}`)
	const name = element('h4', 'rw-looks-title', piece.name)
	const crop = element('img', 'rw-piece-crop')
	crop.src = pieceImage(index)
	crop.alt = piece.name
	const about = element('p', 'rw-piece-about', piece.description)
	const original = section(`SHOP THE ORIGINAL — ${state.designer}`, shopping(`${state.designer} ${piece.search}`))
	const lookalikes = section('LOOKALIKES', shopping(piece.search))
	// Google Lens fetches the cropped piece itself, which it can only do on the public site.
	const extra = element('div', 'rw-piece-links')
	if (!isLocal) extra.append(link('MORE LOOKALIKES — GOOGLE LENS ↗', lens(new URL(pieceImage(index), location.href).href)))
	const others = element('div', 'rw-other-pieces')
	state.pieces.forEach((other, otherIndex) => {
		if (otherIndex === index) return
		const chip = element('button', 'rw-piece-chip')
		chip.type = 'button'
		const thumb = element('img')
		thumb.src = pieceImage(otherIndex)
		thumb.alt = ''
		chip.append(thumb, element('span', '', other.name))
		chip.addEventListener('click', () => choosePiece(otherIndex))
		others.append(chip)
	})
	const pin = cartButton(() => ({
		src: new URL(pieceImage(index), location.href).href,
		caption: `${state.designer} — ${piece.name}`,
	}))
	panel.replaceChildren(head, name, crop, pin, about, original.box, lookalikes.box, extra)
	if (others.children.length) panel.append(element('p', 'rw-piece-count', 'OTHER PIECES'), others)
	panel.scrollTop = 0

	let answer
	try {
		answer = await shopFor(index)
	} catch {
		answer = { original: [], lookalikes: [], source: null }
	}
	if (state.src !== src || state.chosen !== index) return
	original.fill(answer.original, answer.source, `NO ${state.designer} LISTING FOUND FOR SALE.`)
	lookalikes.fill(answer.lookalikes, answer.source, 'NO LOOKALIKES FOUND.')
	if (answer.source === 'gemini') fillDetails(index, src, panel)
}

function shopFor(index) {
	const { src, designer } = state
	return remember(productsFor, `${src}\n${index}`, () => getJSON('/api/piece/shop', { image: src, piece: index, designer }))
}

// One shopping section: a heading, product cards once they arrive, and the
// same search on Google Shopping underneath.
function section(title, searchLink) {
	const box = element('section', 'rw-shop')
	const grid = element('div', 'rw-shop-grid')
	const status = element('p', 'rw-looks-status is-loading', 'SEARCHING')
	box.append(element('h5', 'rw-shop-title', title), status, grid, link('SEE ALL ON GOOGLE SHOPPING ↗', searchLink, 'rw-shop-more'))
	return {
		box,
		fill(products, source, none) {
			status.classList.remove('is-loading')
			if (!source) {
				status.remove() // no product search on this server: the link below does the job
				return
			}
			if (!products.length) {
				status.textContent = none
				return
			}
			status.remove()
			grid.replaceChildren(...products.map(productCard))
		},
	}
}

function productCard(product) {
	const card = link('', product.url, 'rw-product')
	card.dataset.listed = product.url
	const picture = element('div', 'rw-product-picture')
	const site = new URL(product.url).hostname.replace(/^www\./, '')
	// Until (or unless) the shop's photo arrives: its logo and name.
	picture.append(element('span', 'rw-product-shop', product.store || site))
	if (site !== 'google.com') {
		const logo = element('img', 'rw-product-logo')
		logo.src = `https://www.google.com/s2/favicons?domain=${site}&sz=64`
		logo.alt = ''
		picture.prepend(logo)
	}
	picture.classList.add('is-shop')
	const price = element('span', 'rw-product-price', product.price || 'PRICE ON SITE')
	price.classList.toggle('is-missing', !product.price)
	card.append(picture, price, element('span', 'rw-product-title', product.title), element('span', 'rw-product-where', product.store))
	// Saves the product (its photo once it has one, else a note with its name and price).
	card.append(
		cartButton(
			() => {
				const price = card.querySelector('.rw-product-price').textContent
				const photo = card.querySelector('.rw-product-picture:not(.is-shop) img')?.src
				const caption = [price, product.store].filter(Boolean).join(' — ')
				return photo
					? { src: photo, caption, link: card.href }
					: { kind: 'note', text: `${product.title}\n${caption}`, color: '#ffffff', w: 220, h: 140, link: card.href }
			},
			{ className: 'wb-add wb-add--card', label: '+ CART' },
		),
	)
	if (product.image) showPhoto(card, product.image)
	return card
}

function showPhoto(card, address) {
	const photo = new Image()
	photo.alt = ''
	photo.referrerPolicy = 'no-referrer'
	photo.addEventListener('load', () => {
		const picture = card.querySelector('.rw-product-picture')
		picture.classList.remove('is-shop')
		picture.replaceChildren(photo)
	})
	photo.src = address
}

// Each product's photo, current price and exact page, read from the shops'
// pages after the list is shown (/api/piece/details).
async function fillDetails(index, src, cards) {
	let found
	try {
		found = await remember(detailsFor, `${src}\n${index}`, () => getJSON('/api/piece/details', { image: src, piece: index }))
	} catch {
		return
	}
	if (state.src !== src || state.chosen !== index) return
	for (const card of cards.querySelectorAll('.rw-product')) {
		const entry = found[card.dataset.listed]
		if (!entry) continue
		if (entry.url) card.href = entry.url
		if (entry.price) {
			const price = card.querySelector('.rw-product-price')
			price.textContent = entry.price
			price.classList.remove('is-missing')
		}
		if (entry.image) showPhoto(card, entry.image)
	}
}
