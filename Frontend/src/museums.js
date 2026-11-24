import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Where to find NYC's museums: a map with every museum on it, plus each one's
// address and directions. Places come from the backend (/api/art/event-types,
// the MUSEUMS group), which keeps their addresses and coordinates.

const NYC = [40.758, -73.95]
let map = null
let pins = null
const pinById = new Map()

export const directions = (museum) =>
	`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${museum.name}, ${museum.address}`)}`
const appleMaps = (museum) =>
	`https://maps.apple.com/?q=${encodeURIComponent(museum.name)}&address=${encodeURIComponent(museum.address)}`

function link(text, href) {
	const a = document.createElement('a')
	a.href = href
	a.target = '_blank'
	a.rel = 'noopener'
	a.textContent = text
	return a
}

function setUpMap(element) {
	if (map) return
	map = L.map(element, { scrollWheelZoom: false, zoomControl: true, attributionControl: true })
	// OpenStreetMap's own tiles, turned grey in runway.css so the black pins stand out.
	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	}).addTo(map)
	pins = L.layerGroup().addTo(map)
	// Scroll zooms only once the map is clicked, so the page still scrolls past it.
	map.on('click', () => map.scrollWheelZoom.enable())
	map.on('mouseout', () => map.scrollWheelZoom.disable())
}

function popup(museum, onPick, focused) {
	const box = document.createElement('div')
	box.className = 'art-pin'
	const name = document.createElement('strong')
	name.textContent = museum.name
	const address = document.createElement('span')
	address.textContent = museum.address
	box.append(name, address, link('DIRECTIONS ↗', directions(museum)))
	if (!focused) {
		const open = document.createElement('button')
		open.type = 'button'
		open.textContent = 'SHOW THIS MUSEUM →'
		open.addEventListener('click', () => onPick(museum.id))
		box.append(open)
	}
	return box
}

/**
 * Fills `panel` with the map and either every museum's address (no focus) or
 * one museum's details (focus = its id). `onPick(id)` switches to a museum.
 */
export function showMuseums(panel, museums, focus, onPick) {
	const places = museums.filter((museum) => museum.lat != null)
	const focused = places.find((museum) => museum.id === focus)
	panel.hidden = false
	const mapBox = panel.querySelector('.art-map')
	const info = panel.querySelector('.art-museum-info')
	setUpMap(mapBox)
	map.invalidateSize()

	pins.clearLayers()
	pinById.clear()
	for (const museum of places) {
		const isFocus = museum === focused
		const pin = L.circleMarker([museum.lat, museum.lng], {
			radius: isFocus ? 10 : 6,
			color: '#fff',
			weight: 2,
			fillColor: '#000',
			fillOpacity: focused && !isFocus ? 0.35 : 1,
		})
			.bindTooltip(museum.name, { direction: 'top', offset: [0, -6], className: 'art-pin-tip' })
			.bindPopup(() => popup(museum, onPick, isFocus))
			.addTo(pins)
		pinById.set(museum.id, pin)
		if (isFocus) pin.bringToFront()
	}

	if (focused) {
		map.setView([focused.lat, focused.lng], 15)
		info.replaceChildren(museumDetails(focused))
	} else {
		map.fitBounds(L.latLngBounds(places.map((museum) => [museum.lat, museum.lng])), { padding: [24, 24] })
		info.replaceChildren(museumList(places, onPick))
	}
}

export function hideMuseums(panel) {
	panel.hidden = true
	map?.closePopup()
}

function museumDetails(museum) {
	const box = document.createElement('div')
	box.className = 'art-museum-card is-focus'
	const address = document.createElement('p')
	address.className = 'art-museum-address'
	address.textContent = museum.address
	const area = document.createElement('p')
	area.className = 'art-museum-area'
	area.textContent = museum.area.toUpperCase()
	const links = document.createElement('p')
	links.className = 'art-museum-links'
	links.append(
		link('DIRECTIONS (GOOGLE MAPS) ↗', directions(museum)),
		link('APPLE MAPS ↗', appleMaps(museum)),
		link('EXHIBITIONS ON THEIR SITE ↗', museum.url),
	)
	box.append(address, area, links)
	return box
}

function museumList(museums, onPick) {
	const list = document.createElement('ol')
	list.className = 'art-museum-list'
	museums.forEach((museum, index) => {
		const item = document.createElement('li')
		item.className = 'art-museum-card'
		const number = document.createElement('span')
		number.className = 'art-museum-number'
		number.textContent = String(index + 1).padStart(2, '0')
		const name = document.createElement('button')
		name.type = 'button'
		name.className = 'art-museum-name'
		name.textContent = museum.name
		name.addEventListener('click', () => onPick(museum.id))
		const address = document.createElement('p')
		address.className = 'art-museum-address'
		address.textContent = museum.address
		const area = document.createElement('p')
		area.className = 'art-museum-area'
		area.textContent = museum.area.toUpperCase()
		const links = document.createElement('p')
		links.className = 'art-museum-links'
		links.append(link('DIRECTIONS ↗', directions(museum)), link('THEIR SITE ↗', museum.url))
		// Hovering a museum in the list points it out on the map.
		item.addEventListener('mouseenter', () => pinById.get(museum.id)?.setRadius(10).openTooltip())
		item.addEventListener('mouseleave', () => pinById.get(museum.id)?.setRadius(6).closeTooltip())
		item.append(number, name, address, area, links)
		list.append(item)
	})
	return list
}
