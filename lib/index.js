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
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name; keep it equal to the package name so diagnostics agree. */
export const name = 'dsh-restart'

/**
 * Services this plugin cannot exist without.
 *
 * `agents` is declared rather than reached through a local `ctx.inject`
 * callback: the restart route and the tool read the live agent registry, and a
 * bare `ctx.agents` on the plugin context is undefined without this
 * declaration — the resulting TypeError used to be swallowed into an empty
 * session list, so a restart recorded nothing to resume.
 */
export const inject = ['tools', 'agents']

/** The one route the browser half posts to. */
const RESTART_ROUTE = '/dsh-restart/restart'

/** Refuse a request body larger than this instead of buffering it. */
const MAX_BODY_BYTES = 16 * 1024

/** The message dropped into every resumed session. */
const RESUME_MESSAGE = '继续工作。'

/** How long to wait after boot before the first resume attempt, in milliseconds. */
const RESTORE_DELAY_MS = 1500

/** Delay between resume attempts, in milliseconds. */
const RESTORE_RETRY_MS = 1000

/** How many times one session is retried before the restore gives up. */
const RESTORE_MAX_ATTEMPTS = 20

/** How long the shell script waits before killing anything, in seconds. */
const KILL_DELAY_SECONDS = 0.8

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

/** Append one line to the plugin's own log, next to the relaunch script's log. */
function appendLog(line) {
	try {
		mkdirSync(stateDirectory(), { recursive: true })
		appendFileSync(path.join(stateDirectory(), 'restart.log'), `${new Date().toISOString()} restorer ${line}\n`, 'utf8')
	} catch {
		// A log that cannot be written must not abort the restore.
	}
}

/** Wait for the given number of milliseconds. */
function delay(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		timer.unref?.()
	})
}

/**
 * Build the follow-up message the agent inbox accepts.
 *
 * A message needs an identity and a role of its own: the inbox deduplicates by
 * id, and the transcript renders user messages by role. Sending a bare
 * `{ content, source }` leaves it without either.
 *
 * @param text - the message text.
 * @returns a complete user-role message.
 */
function userMessage(text) {
	return {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'user' },
	}
}

/**
 * Whether a failed resume can never succeed by waiting longer.
 *
 * A session that was deleted between the restart and the boot is the ordinary
 * permanent case; every other failure may simply mean the agent factory or the
 * persistence backend was not wired yet.
 *
 * @param error - the thrown value.
 * @returns true when the id is not worth retrying.
 */
function isPermanentResumeFailure(error) {
	const text = String((error && error.message) || error)
	return /not found|no such|ENOENT|missing session|does not exist/i.test(text)
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
	const logFile = path.join(stateDirectory(), 'restart.log')
	const script = [
		'#!/bin/sh',
		'# dsh-restart: fully quit DSH and relaunch it. Generated per request.',
		`LOG=${shellQuote(logFile)}`,
		`log() { printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }`,
		`sleep ${KILL_DELAY_SECONDS}`,
		'main=$1',
		'host=$2',
		`app=${shellQuote(appPath)}`,
		'log "begin main=$main host=$host script=$$"',
		'# LaunchServices treats a process that carries the app\'s own bundle identity as',
		'# the app itself, so `open -a` only attempts to activate the (now dead)',
		'# instance and returns 0 without starting anything. Drop every app-scoped',
		'# variable before asking to open the bundle again.',
		'unset __CFBundleIdentifier',
		'unset __CFBundleName',
		'unset __CFBundleVersion',
		'unset __CFBundleShortVersionString',
		'unset XPC_SERVICE_NAME',
		'unset XPC_FLAGS',
		'unset LaunchInstanceID',
		'export PATH=/usr/bin:/bin:/usr/sbin:/sbin',
		'# The turns were cancelled before this script was started, so the desktop',
		'# quit inspection sees an idle host and the termination runs through the',
		'# normal quit path instead of raising its confirmation box. A refused TERM',
		'# leaves the app running; the kill below is the last resort and the reason',
		'# a restart may look like a crash afterwards.',
		'kill -TERM "$main" 2>/dev/null',
		'i=0',
		'while [ "$i" -lt 60 ]; do',
		'  kill -0 "$main" 2>/dev/null || break',
		'  sleep 0.1',
		'  i=$((i + 1))',
		'done',
		'if kill -0 "$main" 2>/dev/null; then',
		'  log "TERM ignored after $i ticks; forcing kill"',
		'  kill -KILL "$main" 2>/dev/null',
		'  kill -KILL "$host" 2>/dev/null',
		'else',
		'  log "main exited gracefully after $i ticks"',
		'fi',
		'sleep 0.5',
		'pkill -KILL -f "$app/Contents" 2>/dev/null',
		'log "helpers purged"',
		'sleep 0.6',
		'/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" /usr/bin/open -a "$app" >>"$LOG" 2>&1',
		'log "open rc=$?"',
		'sleep 2',
		'if pgrep -f "$app/Contents/MacOS/DeepSeek Harness( |$)" >/dev/null 2>&1; then',
		'  log "relaunch confirmed"',
		'else',
		'  log "open did not start it; falling back"',
		'  /usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" /usr/bin/open -n -a "$app" >>"$LOG" 2>&1',
		'  log "open -n rc=$?"',
		'  sleep 2',
		'  if pgrep -f "$app/Contents/MacOS/DeepSeek Harness( |$)" >/dev/null 2>&1; then',
		'    log "relaunch confirmed after fallback"',
		'  else',
		'    log "still down; executing the bundle binary directly"',
		'    nohup /usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" "$app/Contents/MacOS/DeepSeek Harness" >>"$LOG" 2>&1 &',
		'    log "direct pid=$!"',
		'  fi',
		'fi',
		'log "done"',
		'',
	].join('\n')
	const file = path.join(stateDirectory(), 'restart.sh')
	mkdirSync(stateDirectory(), { recursive: true })
	writeFileSync(file, script, { encoding: 'utf8', mode: 0o755 })
	return file
}

/**
 * Every live agent that is running a turn right now, the requester included.
 *
 * The requester used to be skipped because it asked for the restart on
 * purpose, but its turn is exactly the one the restart tears down: dropping it
 * from the list is why a restart started from a running session came back with
 * an interrupted turn and nothing to continue it. Recording it makes the
 * session pick its own work back up; a requester that was idle is never in the
 * list, so a plain button press does not inject a message into an idle chat.
 *
 * @param ctx - plugin context.
 * @returns the session ids to resume after the restart.
 */
function runningSessionIds(ctx) {
	const ids = []
	const agents = ctx.get('agents')
	if (agents === undefined) return ids
	let live
	try {
		live = agents.list()
	} catch {
		return ids
	}
	for (const agent of live) {
		if (typeof agent?.id !== 'string' || agent.id === '') continue
		if (agent.status !== 'running') continue
		ids.push(agent.id)
	}
	return ids
}

/**
 * Stop every piece of work the desktop quit inspector treats as active.
 *
 * The shell asks the host what quitting would interrupt and, when anything
 * still looks active, raises a native confirmation box. Cancelling the turns
 * alone is not enough: running background jobs keep the host busy and are what
 * made the restart pop that box. Jobs are cancelled here and the host is given
 * a short window to settle before the quit signal is sent.
 *
 * @param ctx - plugin context.
 */
async function stopRunningTurns(ctx) {
	const agents = ctx.get('agents')
	const jobs = ctx.get('jobs')
	const live = (() => {
		try {
			return agents?.list() ?? []
		} catch {
			return []
		}
	})()

	for (const agent of live) {
		if (agent?.status !== 'running') continue
		try {
			agent.cancel({ kind: 'user' })
		} catch {
			// A turn that already settled needs no cancel.
		}
	}

	const scopes = [undefined, ...live.map((agent) => agent?.id).filter((id) => typeof id === 'string')]
	const killJobs = () => {
		for (const scope of scopes) {
			let listed
			try {
				listed = jobs?.list(scope) ?? []
			} catch {
				continue
			}
			for (const job of listed) {
				if (job?.status !== 'running' && job?.status !== 'stopping') continue
				try {
					jobs.kill(job.id, scope, 'dsh-restart')
				} catch {
					// A job that already settled needs no cancel.
				}
			}
		}
	}

	const deadline = Date.now() + 2000
	killJobs()
	while (Date.now() < deadline) {
		const busyAgents = live.some((agent) => agent?.status === 'running' || (agent?.inbox?.nextTurn?.length ?? 0) > 0 || (agent?.inbox?.nextStep?.length ?? 0) > 0)
		let busyJobs = false
		for (const scope of scopes) {
			try {
				if ((jobs?.list(scope) ?? []).some((job) => job?.status === 'running' || job?.status === 'stopping')) {
					busyJobs = true
					break
				}
			} catch {
				// Treat an unreadable job registry as idle.
			}
		}
		if (!busyAgents && !busyJobs) return
		killJobs()
		await delay(100)
	}
}

/**
 * Record the sessions to resume and hand the quit-and-relaunch to a detached
 * script.
 *
 * @param ctx - plugin context.
 * @param requesterId - the session that asked for the restart, if known.
 * @returns the operation result.
 */
async function performRestart(ctx, requesterId) {
	const appPath = desktopAppPath()
	if (appPath === null) {
		return { ok: false, reason: 'not-desktop', sessions: [] }
	}

	const sessions = runningSessionIds(ctx)
	writePending({ sessions, message: RESUME_MESSAGE, requester: requesterId ?? null, at: Date.now() })
	appendLog(`restart requested by ${requesterId ?? 'unknown'}; resuming ${sessions.length} session(s)`)
	await stopRunningTurns(ctx)
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
 * The provider/model pair a restored agent runs on, mirroring what the window
 * passes when it resumes a session itself.
 *
 * Without it the resumed agent has no route at all and every request fails
 * with "has no provider/model".
 *
 * @param ctx - plugin context.
 * @returns the default selection, or `undefined` when the service is absent.
 */
function restoreAgentOptions(ctx) {
	try {
		const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
		if (typeof selection?.provider !== 'string' || selection.provider === '') return undefined
		if (typeof selection.model !== 'string' || selection.model === '') return undefined
		return {
			provider: selection.provider,
			model: selection.model,
			...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
		}
	} catch {
		return undefined
	}
}

/**
 * The agent preset a stored session was last using, when it can be read.
 *
 * The preset mounts the tool set and prompt sections the session expects; a
 * resume without it hands the agent a much thinner context than the one it was
 * running with.
 *
 * @param ctx - plugin context.
 * @param id - the stored session id.
 * @returns the preset id, or `undefined` when it cannot be determined.
 */
async function storedPreset(ctx, id) {
	const query = ctx.get('sessionQuery')
	if (query === undefined) return undefined
	let observation
	try {
		observation = await query.observeSession(id)
		const preset = observation?.projections?.values?.agentPreset
		return typeof preset === 'string' && preset !== '' ? preset : undefined
	} catch {
		return undefined
	} finally {
		try {
			observation?.[Symbol.dispose]?.()
		} catch {
			// A release failure must not turn into a restore failure.
		}
	}
}

/**
 * Build the per-agent setup hook that re-mounts the stored preset.
 *
 * Mounting is best effort: a preset that was removed while the app was down
 * leaves the agent without its tools rather than preventing the resume.
 *
 * @param ctx - plugin context.
 * @param id - the stored session id.
 * @returns the setup hook, or `undefined` when there is nothing to mount.
 */
async function restoreSetup(ctx, id) {
	const presets = ctx.get('agentPresets')
	if (presets === undefined || typeof presets.mount !== 'function') return undefined
	const presetId = await storedPreset(ctx, id)
	if (presetId === undefined) return undefined
	return async (agentCtx) => {
		try {
			await presets.mount(agentCtx, presetId)
		} catch {
			// Recovery continues on the base composition.
		}
	}
}

/**
 * Wake one recorded session with the follow-up, retrying until the boot has
 * finished wiring the agent factory and the persistence backend.
 *
 * A session that is already live is not skipped any more: the window restores
 * the session it had open as soon as it connects, which can beat this restore
 * and leave the agent registered but idle. In that case the follow-up is what
 * makes the interrupted turn continue, so it is delivered to the live agent
 * instead of resuming a second copy of it.
 *
 * @param ctx - plugin context carrying the agent registry.
 * @param id - the session id to resume.
 * @param message - the follow-up text.
 */
async function resumeSession(ctx, id, message) {
	let lastError
	for (let attempt = 1; attempt <= RESTORE_MAX_ATTEMPTS; attempt += 1) {
		try {
			const live = ctx.agents.get(id)
			if (live !== undefined) {
				live.followup(userMessage(message))
			} else {
				const agentOptions = restoreAgentOptions(ctx)
				const setup = await restoreSetup(ctx, id)
				const handle = await ctx.agents.resume({
					resumeSessionId: id,
					...(agentOptions === undefined ? {} : { agentOptions }),
					...(setup === undefined ? {} : { setup }),
				})
				handle.agent.followup(userMessage(message))
			}
			appendLog(`resumed ${id} on attempt ${attempt}`)
			ctx.logger.info(`dsh-restart: resumed ${id}`)
			return
		} catch (error) {
			lastError = error
			if (isPermanentResumeFailure(error)) break
			await delay(RESTORE_RETRY_MS)
		}
	}
	const reason = String((lastError && lastError.message) || lastError)
	appendLog(`cannot resume ${id}: ${reason}`)
	ctx.logger.warn(`dsh-restart: cannot resume ${id}: ${reason}`)
}

/**
 * Consume the payload written by the previous process.
 *
 * Runs shortly after boot so the agent loop and session persistence are fully
 * wired before a session is loaded. The file is removed before resuming, so a
 * restart is never replayed by every later boot; a failed resume is retried
 * inside this process for a bounded window instead.
 *
 * @param ctx - plugin context carrying the agent registry.
 */
function scheduleRestore(ctx) {
	const pending = readPending()
	if (pending === null) return
	clearPending()

	const ids = Array.isArray(pending.sessions) ? pending.sessions.filter((id) => typeof id === 'string' && id !== '') : []
	if (ids.length === 0) {
		appendLog(`nothing to restore (requester ${pending.requester ?? 'unknown'})`)
		return
	}
	appendLog(`restoring ${ids.length} session(s): ${ids.join(', ')}`)
	const message = typeof pending.message === 'string' && pending.message !== '' ? pending.message : RESUME_MESSAGE

	const timer = setTimeout(() => {
		void Promise.all(ids.map((id) => resumeSession(ctx, id, message)))
	}, RESTORE_DELAY_MS)
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
		const result = await performRestart(ctx, requesterId)
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
		description: 'Fully quit and relaunch the running DSH desktop app. Use this when a change cannot take effect without a complete restart (for example a newly installed plugin, a plugin client bundle, or an edited profile patch). The current turn is terminated immediately, and every session that was running — this one included — resumes automatically with a "继续工作。" message right after the app comes back.',
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
					? value.sessions.length > 0
						? `DSH 正在彻底重启，${value.sessions.length} 个运行中的会话将在重启后自动继续。`
						: 'DSH 正在彻底重启，没有正在运行的会话需要恢复。'
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
