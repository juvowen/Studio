// White Board storage, shared by the White Board page and the "+ CART" buttons
// elsewhere on the site. Boards and the cart live in this browser (IndexedDB),
// with uploaded pictures kept as files, so nothing needs an account or a server.
//
// The cart: things saved from Runway and Art Studio, to pull onto boards.
// A cart entry: { id, added, kind, src, ratio, caption, link, text, color }
//
// A board: { id, name, created, updated, view: { x, y, scale }, items: [...] }
// An item: { id, kind: 'image' | 'note' | 'swatch', x, y, w, h, rot, z,
//            src (a picture address) or file (an uploaded picture's id),
//            text, color, caption, link }

const DB = 'studio-whiteboard'
const CURRENT = 'whiteboard-current' // the board last worked on
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('studio-whiteboard') : null

let opening
function db() {
	opening ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 2)
		request.onupgradeneeded = () => {
			const stores = request.result.objectStoreNames
			if (!stores.contains('boards')) request.result.createObjectStore('boards', { keyPath: 'id' })
			if (!stores.contains('files')) request.result.createObjectStore('files')
			if (!stores.contains('cart')) request.result.createObjectStore('cart', { keyPath: 'id' })
		}
		request.onsuccess = () => {
			// Another tab with a newer version of the site: let it upgrade, reconnect later.
			request.result.onversionchange = () => {
				request.result.close()
				opening = null
			}
			resolve(request.result)
		}
		request.onerror = () => reject(request.error)
		request.onblocked = () => console.warn('White Board storage is waiting for other Studio tabs to reload.')
	})
	return opening
}

async function run(store, mode, work) {
	const database = await db()
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(store, mode)
		const result = work(transaction.objectStore(store))
		transaction.oncomplete = () => resolve(result?.result ?? result)
		transaction.onerror = () => reject(transaction.error)
	})
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export const listBoards = async () =>
	(await run('boards', 'readonly', (store) => store.getAll())).sort((a, b) => b.updated - a.updated)

export const getBoard = (id) => run('boards', 'readonly', (store) => store.get(id))

export async function saveBoard(board, { quiet = false } = {}) {
	board.updated = Date.now()
	await run('boards', 'readwrite', (store) => store.put(board))
	if (!quiet) channel?.postMessage({ board: board.id })
}

export async function deleteBoard(id) {
	const board = await getBoard(id)
	await run('boards', 'readwrite', (store) => store.delete(id))
	for (const item of board?.items ?? []) if (item.file) await run('files', 'readwrite', (store) => store.delete(item.file))
	channel?.postMessage({ board: id })
}

export async function newBoard(name) {
	const count = (await listBoards()).length
	const board = {
		id: newId(),
		name: name || `BOARD ${String(count + 1).padStart(2, '0')}`,
		created: Date.now(),
		updated: Date.now(),
		view: { x: 0, y: 0, scale: 1 },
		items: [],
	}
	await saveBoard(board)
	return board
}

export function currentId() {
	try {
		return localStorage.getItem(CURRENT)
	} catch {
		return null
	}
}

export function setCurrent(id) {
	try {
		localStorage.setItem(CURRENT, id)
	} catch {}
}

/** The board being worked on: the last one opened, else the newest, else a new one. */
export async function currentBoard() {
	const id = currentId()
	const board = (id && (await getBoard(id))) || (await listBoards())[0] || (await newBoard())
	setCurrent(board.id)
	return board
}

export const saveFile = (blob) => {
	const id = newId()
	return run('files', 'readwrite', (store) => store.put(blob, id)).then(() => id)
}

export const getFile = (id) => run('files', 'readonly', (store) => store.get(id))

export function onBoardChange(listener) {
	channel?.addEventListener('message', (event) => listener(event.data.board))
}

/** Width / height of a picture, or null if it does not load within a few seconds. */
export function pictureRatio(src) {
	return new Promise((resolve) => {
		const image = new Image()
		const timer = setTimeout(() => resolve(null), 5000)
		image.onload = () => {
			clearTimeout(timer)
			resolve(image.naturalWidth / image.naturalHeight || null)
		}
		image.onerror = () => {
			clearTimeout(timer)
			resolve(null)
		}
		image.referrerPolicy = 'no-referrer'
		image.src = src
	})
}

/** The open place nearest `center` for a w × h item, looking outward in rings. */
export function freeSpot(items, center, w, h) {
	const gap = 24
	const clear = (x, y) =>
		items.every((o) => x + w + gap <= o.x || o.x + o.w + gap <= x || y + h + gap + 20 <= o.y || o.y + o.h + gap + 20 <= y)
	for (let ring = 0; ring < 12; ring++) {
		const steps = Math.max(1, ring * 8)
		for (let n = 0; n < steps; n++) {
			const angle = (n / steps) * Math.PI * 2
			const x = center.x - w / 2 + Math.cos(angle) * ring * (w * 0.6 + gap)
			const y = center.y - h / 2 + Math.sin(angle) * ring * (h * 0.45 + gap)
			if (clear(x, y)) return { x, y }
		}
	}
	const step = (items.length % 8) * 28 // a very full board: overlap a little, in a cascade
	return { x: center.x - w / 2 + step, y: center.y - h / 2 + step }
}

// ---- Cart ------------------------------------------------------------------------
export const listCart = async () => (await run('cart', 'readonly', (store) => store.getAll())).sort((a, b) => b.added - a.added)

/** Saves something to the cart (once: the same picture is not saved twice). */
export async function addToCart(item) {
	const cart = await listCart()
	const same = cart.find((entry) => (item.src ? entry.src === item.src : entry.text === item.text && entry.link === item.link))
	if (same) return { entry: same, count: cart.length, already: true }
	const ratio = item.src ? await pictureRatio(item.src) : null
	const entry = { kind: 'image', ...item, id: newId(), added: Date.now(), ratio }
	await run('cart', 'readwrite', (store) => store.put(entry))
	channel?.postMessage({ cart: true })
	return { entry, count: cart.length + 1, already: false }
}

export async function removeFromCart(id) {
	await run('cart', 'readwrite', (store) => store.delete(id))
	channel?.postMessage({ cart: true })
	dispatchEvent(new Event('studio-cart'))
}

export function onCartChange(listener) {
	channel?.addEventListener('message', (event) => event.data.cart && listener())
}

/** A board item made from a cart entry, sized for the board. */
export function fromCart(entry) {
	if (entry.kind === 'note') return { kind: 'note', text: entry.text, color: entry.color || '#ffffff', w: 220, h: 150, link: entry.link, cartId: entry.id }
	const w = 240
	return { kind: 'image', src: entry.src, caption: entry.caption, link: entry.link, w, h: entry.ratio ? w / entry.ratio : w * 1.25, cartId: entry.id }
}

// ---- "+ CART" buttons --------------------------------------------------------------
// The same window, too: BroadcastChannel only tells other tabs.
const cartChanged = () => dispatchEvent(new Event('studio-cart'))
onCartChange(cartChanged)

let toast
function say(text) {
	toast ??= Object.assign(document.createElement('div'), { className: 'wb-toast', role: 'status' })
	if (!toast.isConnected || toast.parentElement !== (document.querySelector('dialog[open]') ?? document.body))
		(document.querySelector('dialog[open]') ?? document.body).append(toast)
	toast.replaceChildren(
		`${text} `,
		Object.assign(document.createElement('a'), { href: './whiteboard.html', textContent: 'OPEN WHITE BOARD ↗' }),
	)
	toast.classList.add('is-shown')
	clearTimeout(say.timer)
	say.timer = setTimeout(() => toast.classList.remove('is-shown'), 3200)
}

/** A small button that saves `item()` (called at click time) to the cart. */
export function cartButton(item, { className = 'wb-add', label = '+ CART' } = {}) {
	const button = document.createElement('button')
	button.type = 'button'
	button.className = className
	button.textContent = label
	button.title = 'Save to your cart, to use on the White Board'
	button.addEventListener('click', async (event) => {
		event.preventDefault()
		event.stopPropagation()
		button.disabled = true
		try {
			const { count, already } = await addToCart(item())
			cartChanged()
			say(already ? 'ALREADY IN YOUR CART.' : `ADDED TO CART (${count}).`)
			button.textContent = '✓ IN CART'
		} catch {
			button.textContent = 'COULD NOT SAVE'
		}
		setTimeout(() => {
			button.textContent = label
			button.disabled = false
		}, 1800)
	})
	return button
}

export { cartChanged }
