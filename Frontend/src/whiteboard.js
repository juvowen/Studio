import './runway.css'
import './whiteboard.css'
import {
	currentBoard,
	deleteBoard,
	getBoard,
	getFile,
	listBoards,
	newBoard,
	newId,
	onBoardChange,
	pictureRatio,
	freeSpot,
	fromCart,
	listCart,
	removeFromCart,
	saveBoard,
	saveFile,
	setCurrent,
} from './board-store.js'

// White Board: a mood board for the idea phase. Pictures, notes and colour
// swatches on a free canvas; drag to move, corner to resize, top handle to
// rotate; drag empty space to pan, ⌘/Ctrl + scroll (or − / +) to zoom.

const canvas = document.querySelector('.wb-canvas')
const world = document.querySelector('.wb-world')
const empty = document.querySelector('.wb-empty')
const dropHint = document.querySelector('.wb-drop')
const nameInput = document.querySelector('.wb-name')
const picker = document.querySelector('.wb-pick')
const fileInput = document.querySelector('.wb-files')
const zoomLabel = document.querySelector('.wb-zoom')
const selectionBar = document.querySelector('.wb-selection')
const colorInput = document.querySelector('.wb-color')
const openLink = document.querySelector('.wb-open')
const savedLabel = document.querySelector('.wb-saved')
const cartPanel = document.querySelector('.wb-cart')
const cartList = document.querySelector('.wb-cart-list')
const cartToggle = document.querySelector('.wb-cart-toggle')

const NOTE_COLORS = ['#fff6a8', '#ffffff', '#ffd6e0', '#d7ecff', '#dff5d8']
const MIN = 40

let board = null
let selected = null // the selected item's id
let deleted = new Set() // ids removed here, so a merge does not bring them back
const fileUrls = new Map() // uploaded picture id -> object URL

// ---- Saving ------------------------------------------------------------------
let saveTimer
function changed() {
	markCart()
	savedLabel.textContent = 'SAVING…'
	clearTimeout(saveTimer)
	saveTimer = setTimeout(save, 300)
	updateEmpty()
}

async function save() {
	clearTimeout(saveTimer)
	if (!board) return
	try {
		await saveBoard(board)
		savedLabel.textContent = 'SAVED IN THIS BROWSER'
		refreshPicker()
	} catch {
		savedLabel.textContent = 'NOT SAVED — BROWSER STORAGE IS OFF OR FULL'
	}
}

// Another tab pinned something (or this tab came back into view): take in
// items added elsewhere without losing anything changed here.
async function merge() {
	if (!board) return
	const stored = await getBoard(board.id)
	if (!stored) return
	const here = new Set(board.items.map((item) => item.id))
	const added = stored.items.filter((item) => !here.has(item.id) && !deleted.has(item.id))
	if (!added.length) return
	board.items.push(...added)
	added.forEach(draw)
	updateEmpty()
	await save()
}

onBoardChange((id) => id === board?.id && merge())
addEventListener('focus', merge)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && merge())
addEventListener('pagehide', save)

// ---- Boards --------------------------------------------------------------------
async function open(id) {
	await save()
	board = (id && (await getBoard(id))) || (await currentBoard())
	setCurrent(board.id)
	selected = null
	deleted = new Set()
	nameInput.value = board.name
	world.replaceChildren()
	board.items.forEach(draw)
	applyView()
	updateEmpty()
	showSelection()
	await refreshPicker()
}

async function refreshPicker() {
	const boards = await listBoards()
	picker.replaceChildren(...boards.map((b) => new Option(`${b.name} (${b.items.length})`, b.id)))
	picker.value = board.id
}

nameInput.addEventListener('input', () => {
	board.name = nameInput.value.trim() || 'UNTITLED BOARD'
	changed()
})
nameInput.addEventListener('change', refreshPicker)
picker.addEventListener('change', () => open(picker.value))

// ---- View: pan and zoom ----------------------------------------------------------
function applyView() {
	const { x, y, scale } = board.view
	world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
	canvas.style.backgroundPosition = `${x}px ${y}px`
	canvas.style.backgroundSize = `${24 * scale}px ${24 * scale}px`
	zoomLabel.textContent = `${Math.round(scale * 100)}%`
}

function zoomAt(factor, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
	const view = board.view
	const scale = Math.min(4, Math.max(0.15, view.scale * factor))
	view.x = cx - ((cx - view.x) * scale) / view.scale
	view.y = cy - ((cy - view.y) * scale) / view.scale
	view.scale = scale
	applyView()
	changed()
}

function fit() {
	if (!board.items.length) {
		board.view = { x: 0, y: 0, scale: 1 }
		applyView()
		return changed()
	}
	const left = Math.min(...board.items.map((i) => i.x))
	const top = Math.min(...board.items.map((i) => i.y))
	const right = Math.max(...board.items.map((i) => i.x + i.w))
	const bottom = Math.max(...board.items.map((i) => i.y + i.h))
	const pad = 60
	const scale = Math.min(2, (canvas.clientWidth - pad * 2) / (right - left), (canvas.clientHeight - pad * 2) / (bottom - top))
	board.view = {
		scale,
		x: (canvas.clientWidth - (right - left) * scale) / 2 - left * scale,
		y: (canvas.clientHeight - (bottom - top) * scale) / 2 - top * scale,
	}
	applyView()
	changed()
}

canvas.addEventListener(
	'wheel',
	(event) => {
		event.preventDefault()
		const rect = canvas.getBoundingClientRect()
		if (event.ctrlKey || event.metaKey) {
			zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX - rect.left, event.clientY - rect.top)
		} else {
			board.view.x -= event.deltaX
			board.view.y -= event.deltaY
			applyView()
			changed()
		}
	},
	{ passive: false },
)

/** A point on the screen, in board coordinates. */
function toBoard(clientX, clientY) {
	const rect = canvas.getBoundingClientRect()
	const { x, y, scale } = board.view
	return { x: (clientX - rect.left - x) / scale, y: (clientY - rect.top - y) / scale }
}

const middle = () => {
	const rect = canvas.getBoundingClientRect()
	return toBoard(rect.left + rect.width / 2, rect.top + rect.height / 2)
}

// ---- Items ---------------------------------------------------------------------------
const topZ = () => Math.max(0, ...board.items.map((item) => item.z || 0))
const find = (id) => board.items.find((item) => item.id === id)
const node = (id) => world.querySelector(`[data-id="${id}"]`)

function place(item) {
	const element = node(item.id)
	if (!element) return
	Object.assign(element.style, {
		left: `${item.x}px`,
		top: `${item.y}px`,
		width: `${item.w}px`,
		height: `${item.h}px`,
		zIndex: item.z || 0,
		transform: `rotate(${item.rot || 0}deg)`,
	})
}

async function pictureSrc(item) {
	if (!item.file) return item.src
	if (!fileUrls.has(item.file)) {
		const blob = await getFile(item.file)
		if (!blob) return ''
		fileUrls.set(item.file, URL.createObjectURL(blob))
	}
	return fileUrls.get(item.file)
}

function draw(item) {
	const element = document.createElement('div')
	element.className = `wb-item wb-${item.kind}`
	element.dataset.id = item.id
	element.tabIndex = -1

	if (item.kind === 'image') {
		const img = document.createElement('img')
		img.alt = item.caption || ''
		img.draggable = false
		img.referrerPolicy = 'no-referrer'
		pictureSrc(item).then((src) => (img.src = src))
		img.addEventListener('error', () => element.classList.add('is-broken'))
		element.append(img)
		if (item.caption) element.append(Object.assign(document.createElement('span'), { className: 'wb-caption', textContent: item.caption }))
	} else if (item.kind === 'note') {
		const text = document.createElement('div')
		text.className = 'wb-text'
		text.textContent = item.text || ''
		text.spellcheck = false
		text.addEventListener('input', () => {
			item.text = text.innerText
			changed()
		})
		text.addEventListener('blur', () => (text.contentEditable = 'false'))
		element.style.background = item.color
		element.append(text)
	} else if (item.kind === 'swatch') {
		const label = document.createElement('span')
		label.className = 'wb-hex'
		label.textContent = item.color.toUpperCase()
		element.style.setProperty('--swatch', item.color)
		element.append(label)
	}

	const rotate = Object.assign(document.createElement('span'), { className: 'wb-rotate', title: 'Rotate' })
	const resize = Object.assign(document.createElement('span'), { className: 'wb-resize', title: 'Resize' })
	element.append(rotate, resize)
	world.append(element)
	place(item)
}

function add(item, { roomy = true } = {}) {
	// Placed at the open spot nearest where it was asked for, so new things do not pile up.
	if (roomy) Object.assign(item, freeSpot(board.items, { x: item.x + item.w / 2, y: item.y + item.h / 2 }, item.w, item.h))
	item = { id: newId(), rot: 0, z: topZ() + 1, ...item }
	board.items.push(item)
	draw(item)
	select(item.id)
	changed()
	return item
}

function remove(id) {
	const item = find(id)
	if (!item) return
	board.items = board.items.filter((other) => other !== item)
	deleted.add(id)
	node(id)?.remove()
	if (selected === id) select(null)
	changed()
}

function select(id) {
	selected = id
	for (const element of world.children) element.classList.toggle('is-selected', element.dataset.id === id)
	showSelection()
}

function showSelection() {
	const item = selected && find(selected)
	selectionBar.hidden = !item
	if (!item) return
	colorInput.hidden = item.kind === 'image'
	if (item.color) colorInput.value = toHex(item.color)
	openLink.hidden = !item.link
	if (item.link) openLink.href = item.link
}

function toHex(color) {
	if (/^#[0-9a-f]{6}$/i.test(color)) return color
	const probe = document.createElement('canvas').getContext('2d')
	probe.fillStyle = color
	return probe.fillStyle
}

// ---- Adding ------------------------------------------------------------------------
async function addPicture(src, extra = {}, at = middle()) {
	const ratio = (await pictureRatio(src)) || 0.8
	const w = Math.min(320, 320 * Math.min(1, ratio))
	return add({ kind: 'image', src, x: at.x - w / 2, y: at.y - w / ratio / 2, w, h: w / ratio, rot: tilt(), ...extra })
}

const tilt = () => Math.round((Math.random() - 0.5) * 6)

/** Keeps uploads small enough for the browser: at most 1600px, as WebP. */
async function shrink(file) {
	try {
		const bitmap = await createImageBitmap(file)
		const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
		const drawing = document.createElement('canvas')
		drawing.width = Math.round(bitmap.width * scale)
		drawing.height = Math.round(bitmap.height * scale)
		drawing.getContext('2d').drawImage(bitmap, 0, 0, drawing.width, drawing.height)
		const blob = await new Promise((resolve) => drawing.toBlob(resolve, 'image/webp', 0.9))
		return { blob: blob || file, ratio: bitmap.width / bitmap.height }
	} catch {
		return { blob: file, ratio: 0.8 }
	}
}

async function addFiles(files, at = middle()) {
	let offset = 0
	for (const file of files) {
		if (!file.type.startsWith('image/')) continue
		const { blob, ratio } = await shrink(file)
		const id = await saveFile(blob)
		const w = Math.min(320, 320 * Math.min(1, ratio))
		add({ kind: 'image', file: id, caption: '', x: at.x - w / 2 + offset, y: at.y - w / ratio / 2 + offset, w, h: w / ratio, rot: tilt() })
		offset += 30
	}
}

function addNote(at = middle(), text = '') {
	const color = NOTE_COLORS[board.items.filter((i) => i.kind === 'note').length % NOTE_COLORS.length]
	const item = add({ kind: 'note', text, color, x: at.x - 110, y: at.y - 80, w: 220, h: 160, rot: tilt() })
	if (!text) editNote(item.id)
}

function editNote(id) {
	const text = node(id)?.querySelector('.wb-text')
	if (!text) return
	text.contentEditable = 'true'
	text.focus()
	getSelection().selectAllChildren(text)
	getSelection().collapseToEnd()
}

function addSwatch(at = middle()) {
	const palette = ['#111111', '#c8102e', '#e8dcc8', '#2f4f3e', '#1f3a93', '#d4a017', '#7a5c58']
	const color = palette[board.items.filter((i) => i.kind === 'swatch').length % palette.length]
	add({ kind: 'swatch', color, x: at.x - 60, y: at.y - 75, w: 120, h: 150, rot: 0 })
}

const looksLikePicture = (text) => /^https?:\/\/\S+\.(jpe?g|png|gif|webp|avif)(\?\S*)?$/i.test(text) || /^data:image\//.test(text)

async function addLink(text, at = middle()) {
	text = text.trim()
	if (!text) return
	if (/^https?:\/\//i.test(text) || /^data:image\//.test(text)) {
		// Try it as a picture first; if it is not one, pin it as a note with the link.
		if (looksLikePicture(text) || (await pictureRatio(text))) return addPicture(text, { link: /^https?:/.test(text) ? text : '' }, at)
		return addNote(at, text)
	}
	addNote(at, text)
}

// ---- Toolbar ---------------------------------------------------------------------
async function onAction(event) {
	const act = event.target.closest('button')?.dataset.act
	if (!act) return
	const item = selected && find(selected)
	switch (act) {
		case 'new-board': {
			await save()
			const fresh = await newBoard()
			await open(fresh.id)
			nameInput.select()
			break
		}
		case 'delete-board':
			if (!confirm(`Delete "${board.name}" and everything on it? This cannot be undone.`)) return
			await deleteBoard(board.id)
			board = null
			setCurrent('')
			await open(null)
			break
		case 'image':
			fileInput.click()
			break
		case 'note':
			addNote()
			break
		case 'swatch':
			addSwatch()
			break
		case 'link': {
			const text = prompt('Paste a picture address (or any link / text to pin as a note):')
			if (text) addLink(text)
			break
		}
		case 'zoom-in':
			zoomAt(1.25)
			break
		case 'zoom-out':
			zoomAt(0.8)
			break
		case 'zoom-reset':
			zoomAt(1 / board.view.scale)
			break
		case 'fit':
			fit()
			break
		case 'cart':
			showCart(cartPanel.hidden)
			break
		case 'duplicate':
			if (item) add({ ...item, id: newId(), x: item.x + 30, y: item.y + 30, z: topZ() + 1 }, { roomy: false })
			break
		case 'front':
			if (item) {
				item.z = topZ() + 1
				place(item)
				changed()
			}
			break
		case 'delete':
			if (item) remove(item.id)
			break
	}
}
document.querySelector('.wb-bar').addEventListener('click', onAction)
selectionBar.addEventListener('click', onAction)

fileInput.addEventListener('change', () => {
	addFiles([...fileInput.files])
	fileInput.value = ''
})

colorInput.addEventListener('input', () => {
	const item = selected && find(selected)
	if (!item || item.kind === 'image') return
	item.color = colorInput.value
	const element = node(item.id)
	if (item.kind === 'note') element.style.background = item.color
	else {
		element.style.setProperty('--swatch', item.color)
		element.querySelector('.wb-hex').textContent = item.color.toUpperCase()
	}
	changed()
})

// ---- Dragging: move, resize, rotate, pan -------------------------------------------------
let gesture = null

canvas.addEventListener('pointerdown', (event) => {
	if (event.button !== 0) return
	const element = event.target.closest('.wb-item')
	const editing = event.target.closest('.wb-text[contenteditable="true"]')
	if (editing) return
	canvas.focus({ preventScroll: true })
	if (!element) {
		select(null)
		gesture = { mode: 'pan', startX: event.clientX, startY: event.clientY, view: { ...board.view } }
	} else {
		const item = find(element.dataset.id)
		select(item.id)
		const start = toBoard(event.clientX, event.clientY)
		const mode = event.target.closest('.wb-resize') ? 'resize' : event.target.closest('.wb-rotate') ? 'rotate' : 'move'
		gesture = { mode, item, start, from: { ...item } }
		if (mode === 'move' && item.z !== topZ()) {
			item.z = topZ() + 1
			place(item)
		}
	}
	canvas.setPointerCapture(event.pointerId)
	canvas.classList.add('is-dragging')
	event.preventDefault()
})

canvas.addEventListener('pointermove', (event) => {
	if (!gesture) return
	if (gesture.mode === 'pan') {
		board.view.x = gesture.view.x + event.clientX - gesture.startX
		board.view.y = gesture.view.y + event.clientY - gesture.startY
		return applyView()
	}
	const { item, start, from } = gesture
	const now = toBoard(event.clientX, event.clientY)
	if (gesture.mode === 'move') {
		item.x = from.x + now.x - start.x
		item.y = from.y + now.y - start.y
	} else if (gesture.mode === 'resize') {
		// Measured along the item's own (rotated) axes.
		const angle = ((from.rot || 0) * Math.PI) / 180
		const dx = now.x - start.x
		const dy = now.y - start.y
		const along = dx * Math.cos(angle) + dy * Math.sin(angle)
		const across = -dx * Math.sin(angle) + dy * Math.cos(angle)
		item.w = Math.max(MIN, from.w + along)
		item.h = Math.max(MIN, from.h + across)
		if (item.kind === 'image' && !event.shiftKey) item.h = item.w * (from.h / from.w) // keep the picture's shape
	} else if (gesture.mode === 'rotate') {
		const cx = from.x + from.w / 2
		const cy = from.y + from.h / 2
		let degrees = (Math.atan2(now.y - cy, now.x - cx) * 180) / Math.PI + 90
		if (!event.shiftKey) degrees = Math.round(degrees / 5) * 5 // Shift for free rotation
		item.rot = ((degrees + 540) % 360) - 180
	}
	place(item)
})

function endGesture() {
	if (!gesture) return
	gesture = null
	canvas.classList.remove('is-dragging')
	changed()
}
canvas.addEventListener('pointerup', endGesture)
canvas.addEventListener('pointercancel', endGesture)

canvas.addEventListener('dblclick', (event) => {
	const element = event.target.closest('.wb-item')
	if (!element) return addNote(toBoard(event.clientX, event.clientY))
	const item = find(element.dataset.id)
	if (item.kind === 'note') editNote(item.id)
	else if (item.kind === 'swatch') colorInput.click()
	else if (item.link) window.open(item.link, '_blank', 'noopener')
})

// ---- Keyboard, paste, drop ---------------------------------------------------------------
document.addEventListener('keydown', (event) => {
	const typing = event.target.closest('input, textarea, select, [contenteditable="true"]')
	if (typing) {
		if (event.key === 'Escape') event.target.blur()
		return
	}
	const item = selected && find(selected)
	if ((event.key === 'Delete' || event.key === 'Backspace') && item) {
		event.preventDefault()
		remove(item.id)
	} else if (event.key === 'Escape') select(null)
	else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && item) {
		event.preventDefault()
		add({ ...item, id: newId(), x: item.x + 30, y: item.y + 30, z: topZ() + 1 }, { roomy: false })
	} else if (item && event.key.startsWith('Arrow')) {
		event.preventDefault()
		const step = event.shiftKey ? 20 : 2
		if (event.key === 'ArrowLeft') item.x -= step
		if (event.key === 'ArrowRight') item.x += step
		if (event.key === 'ArrowUp') item.y -= step
		if (event.key === 'ArrowDown') item.y += step
		place(item)
		changed()
	} else if (item?.kind === 'note' && event.key === 'Enter') {
		event.preventDefault()
		editNote(item.id)
	}
})

document.addEventListener('paste', (event) => {
	if (event.target.closest('input, textarea, [contenteditable="true"]')) return
	const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
	if (files.length) {
		event.preventDefault()
		return addFiles(files)
	}
	const text = event.clipboardData.getData('text/plain')
	if (text) {
		event.preventDefault()
		addLink(text)
	}
})

let dragDepth = 0
canvas.addEventListener('dragenter', (event) => {
	event.preventDefault()
	dragDepth++
	dropHint.hidden = false
})
canvas.addEventListener('dragleave', () => {
	if (--dragDepth <= 0) {
		dragDepth = 0
		dropHint.hidden = true
	}
})
canvas.addEventListener('dragover', (event) => event.preventDefault())
canvas.addEventListener('drop', (event) => {
	event.preventDefault()
	dragDepth = 0
	dropHint.hidden = true
	const at = toBoard(event.clientX, event.clientY)
	// Something dragged in from the cart.
	const fromCartId = event.dataTransfer.getData(CART_TYPE)
	if (fromCartId) return placeFromCart(fromCartId, at)
	const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))
	if (files.length) return addFiles(files, at)
	// A picture dragged from another web page.
	const html = event.dataTransfer.getData('text/html')
	const fromHtml = html && new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.src
	const url = fromHtml || event.dataTransfer.getData('text/uri-list').split('\n').find((line) => line && !line.startsWith('#'))
	if (url) return addLink(url, at)
	const text = event.dataTransfer.getData('text/plain')
	if (text) addLink(text, at)
})

// ---- Cart: things saved on Runway and Art Studio, pulled onto the board ----------------
const CART_TYPE = 'application/x-studio-cart'
const CART_OPEN = 'whiteboard-cart-open'
let cart = []

async function placeFromCart(id, at = middle()) {
	const entry = cart.find((e) => e.id === id)
	if (!entry) return
	const item = fromCart(entry)
	add({ ...item, x: at.x - item.w / 2, y: at.y - item.h / 2, rot: tilt() })
}

function cartTile(entry) {
	const tile = document.createElement('li')
	tile.className = 'wb-cart-tile'
	tile.dataset.id = entry.id
	tile.draggable = true
	tile.title = 'Drag onto the board, or click to add'
	if (entry.src) {
		const img = document.createElement('img')
		img.src = entry.src
		img.alt = ''
		img.draggable = false
		img.loading = 'lazy'
		img.referrerPolicy = 'no-referrer'
		tile.append(img)
	} else tile.append(Object.assign(document.createElement('span'), { className: 'wb-cart-note', textContent: entry.text }))
	tile.append(Object.assign(document.createElement('span'), { className: 'wb-cart-caption', textContent: entry.caption || '' }))
	tile.append(Object.assign(document.createElement('span'), { className: 'wb-cart-on', textContent: 'ON BOARD' }))
	const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'wb-cart-remove', textContent: '×' })
	remove.setAttribute('aria-label', 'Remove from cart')
	remove.addEventListener('click', (event) => {
		event.stopPropagation()
		removeFromCart(entry.id)
	})
	tile.append(remove)
	tile.addEventListener('click', () => placeFromCart(entry.id))
	tile.addEventListener('dragstart', (event) => {
		event.dataTransfer.setData(CART_TYPE, entry.id)
		event.dataTransfer.effectAllowed = 'copy'
	})
	return tile
}

async function refreshCart() {
	try {
		cart = await listCart()
	} catch {
		cart = []
	}
	cartToggle.textContent = `CART · ${String(cart.length).padStart(2, '0')}`
	cartList.replaceChildren(...cart.map(cartTile))
	if (!cart.length) {
		const none = document.createElement('li')
		none.className = 'wb-cart-none'
		none.innerHTML =
			'YOUR CART IS EMPTY.<br />SAVE LOOKS, PIECES AND PRODUCTS ON <a href="./runway.html">RUNWAY</a> AND WORKS ON <a href="./art-studio.html">ART STUDIO</a> WITH "+ CART".'
		cartList.append(none)
	}
	markCart()
}

// "ON BOARD" on the cart things this board already uses.
function markCart() {
	if (!board) return
	const used = new Set(board.items.map((item) => item.cartId).filter(Boolean))
	for (const tile of cartList.querySelectorAll('.wb-cart-tile')) tile.classList.toggle('is-used', used.has(tile.dataset.id))
}

function showCart(open) {
	cartPanel.hidden = !open
	cartToggle.setAttribute('aria-expanded', String(open))
	document.body.classList.toggle('has-cart', open)
	try {
		localStorage.setItem(CART_OPEN, open ? '1' : '0')
	} catch {}
}

cartPanel.querySelector('[data-act="cart"]').addEventListener('click', () => showCart(false))
addEventListener('studio-cart', refreshCart)
addEventListener('focus', refreshCart)
{
	let open = true
	try {
		open = localStorage.getItem(CART_OPEN) !== '0'
	} catch {}
	showCart(open)
	refreshCart()
}

function updateEmpty() {
	empty.hidden = Boolean(board?.items.length)
}

open(new URLSearchParams(location.search).get('board'))
