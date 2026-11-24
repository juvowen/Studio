import './runway.css'
import './login.css'
import { configured, onAuth, signOut, supabase, userEmail } from './auth.js'

// The account page: sign in or create an account with email and password,
// straight against Supabase, then back to the page that sent you here
// (?next=…). No emails or links involved, as long as Supabase's "Confirm
// email" setting is off (Authentication → Sign In / Providers → Email).

const query = new URLSearchParams(location.search)
// Only pages of this site: never send people on to another website.
const next = (() => {
	try {
		const url = new URL(query.get('next') || './', location.href)
		return url.origin === location.origin && !url.pathname.endsWith('/login.html') ? url.href : new URL('./', location.href).href
	} catch {
		return new URL('./', location.href).href
	}
})()

const form = document.querySelector('.lg-form')
const tabs = document.querySelectorAll('.lg-tab')
const signupOnly = document.querySelectorAll('.lg-signup-only')
const submit = document.querySelector('.lg-submit')
const error = document.querySelector('.lg-error')
const switcher = document.querySelector('.lg-switch')
const password = form.elements.password
const card = document.querySelector('.lg-card:not(.lg-signed)')
const signed = document.querySelector('.lg-signed')

document.querySelector('.lg-why').textContent = query.get('why') || 'SIGN IN OR CREATE AN ACCOUNT.'

let mode = query.get('mode') === 'signup' ? 'signup' : 'signin'

function setMode(to) {
	mode = to
	for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode))
	for (const element of signupOnly) element.hidden = mode !== 'signup'
	form.elements.confirm.required = mode === 'signup'
	password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password'
	submit.textContent = mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'
	document.title = `"${mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'}" – Studio`
	switcher.replaceChildren(
		mode === 'signup' ? 'ALREADY HAVE AN ACCOUNT? ' : 'NEW HERE? ',
		Object.assign(document.createElement('button'), {
			type: 'button',
			textContent: mode === 'signup' ? 'SIGN IN' : 'CREATE AN ACCOUNT',
			onclick: () => setMode(mode === 'signup' ? 'signin' : 'signup'),
		}),
	)
	error.textContent = ''
}

for (const tab of tabs) tab.addEventListener('click', () => setMode(tab.dataset.mode))
setMode(mode)

document.querySelector('.lg-show').addEventListener('click', (event) => {
	const showing = password.type === 'text'
	password.type = showing ? 'password' : 'text'
	form.elements.confirm.type = password.type
	event.currentTarget.textContent = showing ? 'SHOW' : 'HIDE'
})

// Supabase's messages, in the site's words.
function explain(message) {
	const text = message.toLowerCase()
	if (text.includes('invalid login')) return 'WRONG EMAIL OR PASSWORD.'
	if (text.includes('email not confirmed'))
		return 'THIS ACCOUNT IS WAITING FOR EMAIL CONFIRMATION. (STUDIO: TURN OFF "CONFIRM EMAIL" IN SUPABASE.)'
	if (text.includes('already registered') || text.includes('already been registered')) return 'THERE IS ALREADY AN ACCOUNT WITH THIS EMAIL — SIGN IN INSTEAD.'
	if (text.includes('password')) return message.toUpperCase()
	if (text.includes('rate limit') || text.includes('too many')) return 'TOO MANY TRIES. WAIT A MINUTE AND TRY AGAIN.'
	if (text.includes('fetch')) return 'COULD NOT REACH THE SIGN-IN SERVICE. CHECK YOUR CONNECTION.'
	return message.toUpperCase()
}

form.addEventListener('submit', async (event) => {
	event.preventDefault()
	error.textContent = ''
	if (!configured) return (error.textContent = 'SIGN-IN IS NOT SET UP ON THIS SITE YET.')
	const email = form.elements.email.value.trim()
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return (error.textContent = 'ENTER A VALID EMAIL.')
	if (password.value.length < 8) return (error.textContent = 'THE PASSWORD NEEDS AT LEAST 8 CHARACTERS.')
	if (mode === 'signup' && password.value !== form.elements.confirm.value) return (error.textContent = 'THE PASSWORDS DO NOT MATCH.')

	submit.disabled = true
	submit.textContent = mode === 'signup' ? 'CREATING…' : 'SIGNING IN…'
	try {
		if (mode === 'signin') {
			const { error: failed } = await supabase.auth.signInWithPassword({ email, password: password.value })
			if (failed) throw failed
		} else {
			const { data, error: failed } = await supabase.auth.signUp({ email, password: password.value })
			if (failed) throw failed
			// Supabase hides whether an email is taken: a taken one comes back with no identities.
			if (data.user && !data.user.identities?.length) throw new Error('already registered')
			if (!data.session) throw new Error('Email not confirmed')
		}
		// onAuth below sends them on.
	} catch (failed) {
		error.textContent = explain(failed.message || String(failed))
	} finally {
		submit.disabled = false
		submit.textContent = mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'
	}
})

let arrived = false // already signed in when the page opened: show who, don't bounce
onAuth((session) => {
	if (!arrived) {
		arrived = true
		if (session && !query.get('next')) {
			card.hidden = true
			signed.hidden = false
			signed.querySelector('.lg-signed-email').textContent = userEmail().toUpperCase()
			return
		}
	}
	if (session) location.replace(next)
	else {
		card.hidden = false
		signed.hidden = true
	}
})

document.querySelector('.lg-signout').addEventListener('click', () => signOut())
form.elements.email.focus()
