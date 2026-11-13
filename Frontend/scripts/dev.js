// `npm run dev`: starts the Python backend (Backend/server.py) and Vite together.
// Ctrl+C stops both.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const backendDir = fileURLToPath(new URL('../../Backend/', import.meta.url))
const viteArgs = process.argv.slice(2)

function portInUse(port) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1')
		socket.once('connect', () => (socket.destroy(), resolve(true)))
		socket.once('error', () => resolve(false))
	})
}

const children = []

if (await portInUse(8000)) {
	console.log('Backend already running on port 8000, using it.')
} else {
	children.push(
		spawn(`${backendDir}.venv/bin/python`, ['-W', 'ignore', '-u', 'server.py'], {
			cwd: backendDir,
			stdio: 'inherit',
		}),
	)
}

children.push(spawn('npx', ['vite', ...viteArgs], { stdio: 'inherit' }))

function stop() {
	for (const child of children) child.kill()
	process.exit()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const child of children) child.on('exit', stop)
