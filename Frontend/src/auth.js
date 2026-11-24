import { createClient } from '@supabase/supabase-js'

// Accounts (Supabase, email and password on login.html). Piece lookups, the
// cart and the White Board are for signed-in people only; the rest of the site
// is open to everyone.
// SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY come from Backend/.env at build
// time (vite.config.js). The publishable key is meant to be in web pages:
// Supabase's own rules decide what it may do.
const SUPABASE_URL = __SUPABASE_URL__
const SUPABASE_KEY = __SUPABASE_PUBLISHABLE_KEY__

/** False when the site was built without the Supabase settings: everyone is signed out. */
export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY)
if (!configured) console.warn('Sign-in is off: SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY were not set when the site was built.')

export const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

let current = null // the signed-in session, or null
const ready = configured
	? supabase.auth.getSession().then(({ data }) => {
			current = data.session
			return current
		})
	: Promise.resolve(null)
const listeners = new Set()
supabase?.auth.onAuthStateChange((_event, session) => {
	const changed = (session?.user.id ?? null) !== (current?.user.id ?? null)
	current = session
	if (changed) listeners.forEach((listener) => listener(session))
})

/** The session once known (null when signed out). */
export const session = () => ready.then(() => current)
export const signedIn = () => Boolean(current)
export const userId = () => current?.user.id ?? null
export const userEmail = () => current?.user.email ?? ''

/** Calls `listener(session)` now and whenever someone signs in or out. */
export function onAuth(listener) {
	listeners.add(listener)
	ready.then(() => listener(current))
}

/** For the backend: proves who is asking (piece lookups need it). */
export const authHeaders = () => (current ? { Authorization: `Bearer ${current.access_token}` } : {})

export const signOut = () => supabase?.auth.signOut()

// ---- Sending people to the account page and back -----------------------------------------
const loginUrl = (why) => {
	const url = new URL('./login.html', location.href)
	url.searchParams.set('next', location.href)
	if (why) url.searchParams.set('why', why)
	return url.href
}

/** Takes the visitor to the sign-in page; they come back here once signed in. */
export function askToSignIn(why = 'SIGN IN TO CONTINUE.') {
	location.href = loginUrl(why)
}

/** "SIGN IN" / "EMAIL · SIGN OUT" for a page's top bar. */
export function accountLink() {
	const box = document.createElement('span')
	box.className = 'acct'
	onAuth((signedIn) => {
		if (!signedIn) {
			const link = Object.assign(document.createElement('a'), { href: loginUrl(), textContent: 'SIGN IN', className: 'acct-in' })
			link.addEventListener('click', () => (link.href = loginUrl())) // the page's address may have changed
			box.replaceChildren(link)
			return
		}
		const out = Object.assign(document.createElement('button'), { type: 'button', textContent: 'SIGN OUT', className: 'acct-out' })
		out.addEventListener('click', () => signOut())
		box.replaceChildren(Object.assign(document.createElement('span'), { className: 'acct-email', textContent: userEmail().toUpperCase() }), out)
	})
	return box
}
