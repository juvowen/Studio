import { listCart, removeFromCart } from './board-store.js'

// The cart on Runway and Art Studio: a "CART · 03" button in the corner that
// opens a drawer of everything saved with "+ CART", ready to pull onto the
// White Board.

const pill = document.createElement('button')
pill.type = 'button'
pill.className = 'cart-pill'
pill.setAttribute('aria-haspopup', 'dialog')

const drawer = document.createElement('dialog')
drawer.className = 'cart-drawer'
drawer.setAttribute('aria-label', 'Your cart')
drawer.innerHTML = `
	<div class="cart-head">
		<span class="cart-title">"CART"</span>
		<button type="button" class="cart-close" aria-label="Close">CLOSE ×</button>
	</div>
	<p class="cart-hint">SAVED FROM RUNWAY AND ART STUDIO. PULL THEM ONTO A MOOD BOARD.</p>
	<ul class="cart-list"></ul>
	<a class="cart-go" href="./whiteboard.html">OPEN WHITE BOARD →</a>`
const list = drawer.querySelector('.cart-list')

document.body.append(pill, drawer)
pill.addEventListener('click', () => drawer.showModal())
drawer.querySelector('.cart-close').addEventListener('click', () => drawer.close())
drawer.addEventListener('click', (event) => event.target === drawer && drawer.close()) // the dimmed side

function row(entry) {
	const item = document.createElement('li')
	item.className = 'cart-row'
	const picture = document.createElement('div')
	picture.className = 'cart-thumb'
	if (entry.src) {
		const img = document.createElement('img')
		img.src = entry.src
		img.alt = ''
		img.loading = 'lazy'
		img.referrerPolicy = 'no-referrer'
		picture.append(img)
	} else picture.textContent = 'NOTE'
	const text = document.createElement('div')
	text.className = 'cart-text'
	text.textContent = entry.caption || entry.text || ''
	const actions = document.createElement('div')
	actions.className = 'cart-actions'
	if (entry.link) {
		const open = Object.assign(document.createElement('a'), { href: entry.link, target: '_blank', rel: 'noopener', textContent: 'OPEN ↗' })
		actions.append(open)
	}
	const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'REMOVE' })
	remove.addEventListener('click', () => removeFromCart(entry.id))
	actions.append(remove)
	text.append(actions)
	item.append(picture, text)
	return item
}

async function refresh() {
	let cart = []
	try {
		cart = await listCart()
	} catch {}
	pill.textContent = `CART · ${String(cart.length).padStart(2, '0')}`
	pill.classList.toggle('is-empty', !cart.length)
	list.replaceChildren(...cart.map(row))
	if (!cart.length) {
		const none = document.createElement('li')
		none.className = 'cart-none'
		none.textContent = 'NOTHING SAVED YET. USE "+ CART" ON A LOOK, A PIECE, A PRODUCT OR AN ARTWORK.'
		list.append(none)
	}
}

addEventListener('studio-cart', refresh)
addEventListener('focus', refresh)
refresh()
