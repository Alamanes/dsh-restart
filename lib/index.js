/**
 * dsh-restart — host half.
 *
 * Two surfaces reach the same operation:
 *
 *   POST /dsh-restart/restart   { sessionId? }  → { ok, sessions }
 *   tool restart_dsh                             → { ok, sessions }
 *
 * The operation fully quits the DSH desktop app and launches it again. That
 * cannot be done from inside this process: plugins run in the desktop host
 * child (`ELECTRON_RUN_AS_NODE=1`), while the window, the single-instance lock
 * and the app bundle belong to the parent Electron main process. So the work is
 * handed to a detached shell script that outlives both: it waits for the HTTP
 * response to leave, terminates the main process, reaps the host child and any
 * lingering helpers, then reopens the app bundle.
 *
 * Before quitting, the sessions that are *running* (and are not the session
 * that asked for the restart) are written to `pending.json`. On the next boot
 * this half reads that file, resumes each recorded session and drops an
 * ordinary user-role "继续工作。" follow-up into its inbox, so work that was
 * interrupted by the restart picks itself back up.
 *
 * Why the parent pid is trustworthy: the desktop main process spawns this host
 * as a direct child, so `process.ppid` is exactly the process that owns the
 * window and the port. Why the app path is trustworthy: the host is started
 * from the Electron executable itself, so `process.execPath` is
 * `<bundle>.app/Contents/MacOS/<name>` and the bundle is its prefix.
 *
 * @module dsh-restart
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name; keep it equal to the package name so diagnostics agree. */
export const name = 'dsh-restart'

/** Services the tool cannot exist without. */
export const inject = ['tools']

/** The one route the browser half posts to. */
const RESTART_ROUTE = '/dsh-restart/restart'

/** Refuse a request body larger than this instead of buffering it. */
const MAX_BODY_BYTES = 16 * 1024

/** The message dropped into every resumed session. */
const RESUME_MESSAGE = '继续工作。'

/** How long the shell script waits before killing anything, in seconds. */
const KILL_DELAY_SECONDS = 0.4

/** The environment variable that relocates the harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Expand a configured path's `~` prefix against the OS home directory. */
function expandHome(value) {
	if (value === '~') return homedir()
	if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
	return value
}

/** The harness home this process is running against. */
function dshHome() {
	const configured = process.env[DSH_HOME_ENV]
	return typeof configured === 'string' && configured.trim() !== ''
		? path.resolve(expandHome(configured.trim()))
		: path.join(homedir(), '.dsh')
}

/** This plugin's private state directory. */
function stateDirectory() {
	return path.join(dshHome(), 'dsh-restart')
}

/** Where the sessions interrupted by the next restart are recorded. */
function pendingFile() {
	return path.join(stateDirectory(), 'pending.json')
}

/** Read the recorded restart payload, or `null` when there is none or it is unreadable. */
function readPending() {
	try {
		const parsed = JSON.parse(readFileSync(pendingFile(), 'utf8'))
		return parsed !== null && typeof parsed === 'object' ? parsed : null
	} catch {
		return null
	}
}

/** Persist the restart payload that the next boot consumes. */
function writePending(payload) {
	mkdirSync(stateDirectory(), { recursive: true })
	writeFileSync(pendingFile(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/** Drop the payload so a later boot does not replay it. */
function clearPending() {
	try {
		rmSync(pendingFile(), { force: true })
	} catch {
		// A missing file is the ordinary case; nothing else to do here.
	}
}

/**
 * The desktop app bundle this process belongs to, or `null` when DSH is not
 * running inside the desktop shell.
 *
 * The desktop main process starts the host from the Electron executable in
 * Node mode, so `process.execPath` is `<bundle>.app/Contents/MacOS/<name>`.
 * A `dsh web` process has no such prefix.
 *
 * @returns the absolute `.app` path, or `null`.
 */
function desktopAppPath() {
	if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null
	const executable = String(process.execPath ?? '')
	const marker = '.app/Contents/MacOS/'
	const index = executable.indexOf(marker)
	if (index === -1) return null
	return executable.slice(0, index + 4)
}

/** Quote one value for a POSIX shell script. */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Write the detached restart script.
 *
 * The script is a separate process on purpose: the instant it kills the main
 * process this plugin's own process dies too, so anything that still has to
 * run afterwards cannot live here.
 *
 * Order matters. The main process goes first so it never observes its host
 * child dying (that path raises the desktop crash-recovery dialog); the host
 * child is reaped next, then any helper process still holding the app bundle.
 * Only after the port is free does `open -a` start a fresh instance.
 *
 * @param appPath - the `.app` bundle to relaunch.
 * @returns the script's absolute path.
 */
function writeRestartScript(appPath) {
	const script = [
		'#!/bin/sh',
		'# dsh-restart: fully quit DSH and relaunch it. Generated per request.',
		`sleep ${KILL_DELAY_SECONDS}`,
		'main=$1',
		'host=$2',
		`app=${shellQuote(appPath)}`,
		'kill -TERM "$main" 2>/dev/null',
		'i=0',
		'while [ "$i" -lt 50 ]; do',
		'  kill -0 "$main" 2>/dev/null || break',
		'  sleep 0.1',
		'  i=$((i + 1))',
		'done',
		'kill -KILL "$main" 2>/dev/null',
		'kill -KILL "$host" 2>/dev/null',
		'sleep 0.2',
		'pkill -KILL -f "$app/Contents" 2>/dev/null',
		'sleep 0.2',
		'open -a "$app"',
		'',
	].join('\n')
	const file = path.join(stateDirectory(), 'restart.sh')
	mkdirSync(stateDirectory(), { recursive: true })
	writeFileSync(file, script, { encoding: 'utf8', mode: 0o755 })
	return file
}

/**
 * Every live agent that is running a turn right now, except the requester.
 *
 * The requester is skipped because its own turn is the one being interrupted
 * on purpose — the user (or the model) chose to restart from it.
 *
 * @param ctx - plugin context.
 * @param requesterId - the session that asked for the restart, if known.
 * @returns the session ids to resume after the restart.
 */
function runningSessionIds(ctx, requesterId) {
	const ids = []
	let agents
	try {
		agents = ctx.agents.list()
	} catch {
		return ids
	}
	for (const agent of agents) {
		if (typeof agent?.id !== 'string' || agent.id === '') continue
		if (agent.id === requesterId) continue
		if (agent.status !== 'running') continue
		ids.push(agent.id)
	}
	return ids
}

/**
 * Record the sessions to resume and hand the quit-and-relaunch to a detached
 * script.
 *
 * @param ctx - plugin context.
 * @param requesterId - the session that asked for the restart, if known.
 * @returns the operation result.
 */
function performRestart(ctx, requesterId) {
	const appPath = desktopAppPath()
	if (appPath === null) {
		return { ok: false, reason: 'not-desktop', sessions: [] }
	}

	const sessions = runningSessionIds(ctx, requesterId)
	writePending({ sessions, message: RESUME_MESSAGE, at: Date.now() })

	const script = writeRestartScript(appPath)
	const child = spawn('/bin/sh', [script, String(process.ppid), String(process.pid)], {
		cwd: stateDirectory(),
		detached: true,
		stdio: 'ignore',
		env: process.env,
	})
	child.unref()

	ctx.logger.info(`dsh-restart: quitting ${appPath} (main pid ${process.ppid}, host pid ${process.pid}, resuming ${sessions.length})`)
	return { ok: true, sessions }
}

/**
 * Resume one recorded session and wake it with the follow-up.
 *
 * A session that is already live is left alone: the user may have reopened it
 * first, and resuming twice would fight for the same log. A session that no
 * longer exists is reported and skipped.
 *
 * @param ctx - plugin context carrying the agent registry.
 * @param id - the session id to resume.
 * @param message - the follow-up text.
 */
async function resumeSession(ctx, id, message) {
	if (ctx.agents.get(id) !== undefined) return
	try {
		const handle = await ctx.agents.resume({ resumeSessionId: id })
		handle.agent.followup({
			content: [{ type: 'text', text: message }],
			source: { kind: 'user' },
		})
		ctx.logger.info(`dsh-restart: resumed ${id}`)
	} catch (error) {
		ctx.logger.warn(`dsh-restart: cannot resume ${id}: ${String((error && error.message) || error)}`)
	}
}

/**
 * Consume the payload written by the previous process.
 *
 * Runs shortly after boot so the agent loop and session persistence are fully
 * wired before a session is loaded. The file is removed before resuming, so a
 * session that fails to resume is not retried on every later boot.
 *
 * @param ctx - plugin context carrying the agent registry.
 */
function scheduleRestore(ctx) {
	const pending = readPending()
	if (pending === null) return
	clearPending()

	const ids = Array.isArray(pending.sessions) ? pending.sessions.filter((id) => typeof id === 'string' && id !== '') : []
	if (ids.length === 0) return
	const message = typeof pending.message === 'string' && pending.message !== '' ? pending.message : RESUME_MESSAGE

	const timer = setTimeout(() => {
		void (async () => {
			for (const id of ids) await resumeSession(ctx, id, message)
		})()
	}, 1500)
	timer.unref?.()
}

/** Answer one request with JSON. */
function sendJson(res, status, payload) {
	try {
		const body = Buffer.from(JSON.stringify(payload))
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': String(body.length),
			'Cache-Control': 'no-store',
		})
		res.end(body)
	} catch {
		try {
			res.end()
		} catch {
			// The socket is already gone; there is nothing left to answer on.
		}
	}
}

/** Read and parse a bounded JSON body; an empty body is an empty object. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('error', reject)
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8').trim()
			if (raw === '') return resolve({})
			try {
				resolve(JSON.parse(raw))
			} catch {
				reject(new Error('request body is not JSON'))
			}
		})
	})
}

/**
 * Serve one restart request.
 *
 * Only POST is served, and only for a same-origin request: the route kills the
 * whole application, so it must not be reachable from another page.
 *
 * @param ctx - plugin context.
 * @returns the route handler.
 */
function restartHandler(ctx) {
	return async (req, res) => {
		if (String(req.method || 'GET').toUpperCase() !== 'POST') {
			return sendJson(res, 405, { ok: false, reason: 'method' })
		}
		const headers = req.headers || {}
		if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
			return sendJson(res, 403, { ok: false, reason: 'refused' })
		}

		let body
		try {
			body = await readJsonBody(req)
		} catch (error) {
			return sendJson(res, 400, { ok: false, reason: 'bad-request', message: String((error && error.message) || error) })
		}

		const requesterId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
		const result = performRestart(ctx, requesterId)
		if (!result.ok) {
			ctx.logger.warn('dsh-restart: restart refused — this process is not the desktop app host')
			return sendJson(res, 400, result)
		}
		sendJson(res, 200, result)
	}
}

/**
 * Mount the route and the tool.
 *
 * `webServer` is injected locally rather than declared, so this plugin still
 * applies in a composition without a web server; the browser half then simply
 * has nowhere to post.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (web) => {
		web.effect(() => web.webServer.register({ kind: 'exact', path: RESTART_ROUTE, handler: restartHandler(ctx) }))
		web.logger.info(`dsh-restart: serving ${RESTART_ROUTE}`)
	})

	ctx.tools.register(defineTool({
		name: 'restart_dsh',
		description: 'Fully quit and relaunch the running DSH desktop app. Use this when a change cannot take effect without a complete restart (for example a newly installed plugin, a plugin client bundle, or an edited profile patch). The current turn is terminated immediately, and any other session that was running resumes automatically with a "继续工作。" message right after the app comes back.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean', required: true, description: 'Whether the restart was scheduled.' },
					sessions: { type: 'array', items: { type: 'string' }, required: true, description: 'Session ids that will resume after the restart.' },
					reason: { type: 'string', description: 'Why the restart was refused, when ok is false.' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `DSH 正在彻底重启，${value.sessions.length} 个运行中的其他会话将在重启后继续。`
					: `无法重启：${value.reason === 'not-desktop' ? '当前不是桌面应用宿主。' : String(value.reason)}`,
			}],
		},
		async execute(_args, exec) {
			return performRestart(ctx, exec.agent?.id)
		},
	}))

	ctx.inject(['agents'], (sub) => {
		scheduleRestore(sub)
	})
}
