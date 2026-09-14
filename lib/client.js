/**
 * dsh-amp — the browser half: the Amp accounts settings page.
 *
 * Copy rule for this file: the page answers the user's questions — which accounts
 * exist, what is left on each, which one the next run will use, and how to change the
 * list. Implementation facts (a local ledger, which read costs a network round trip,
 * what an unreadable reading means) belong in the code and the plugin's diagnostics,
 * never in the UI.
 *
 * Why the file exists at all: `ctx.settings.register()` on the host only creates the
 * DATA namespace. The plugins settings tab's own contract is that "a plugin that ships
 * a browser half owns its own card", so a host-only plugin has settings no surface can
 * show.
 *
 * Writes go through the host's settings Remote (`remote.settings.update`) rather than
 * a bespoke route, so the same validation that guards every other settings surface
 * guards this one. The list is edited WHOLE against the full ordered ref list the route
 * returns — the page displays only a slice, and a slice written back would silently
 * drop the rest.
 *
 * Loaded by `window.__ModuleLoader__`, not imported — see `dsh.client` in package.json.
 */
window.__ModuleLoader__.load({
	id: 'dsh-amp',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		const React = require('react')

		const NS = 'dsh-amp'
		const API = '/api/dsh-amp'
		const DEFAULT_LIMIT = 12

		const COPY = {
			en: {
				nav: 'Amp accounts',
				title: 'Amp accounts',
				intro: 'Amp runs use an account that still has credit; one that runs out is skipped automatically. Add or remove accounts here.',
				refresh: 'Refresh balances',
				showAll: 'Show all',
				loading: 'Loading…',
				showing: 'Showing {shown} of {total}',
				nextUp: 'next to be used',
				spent: 'out of credit',
				unread: 'not read yet',
				unreadable: 'unavailable',
				remove: 'Remove',
				add: 'Add',
				addPlaceholder: 'Credential name, e.g. AMP_API_KEY_30',
				empty: 'No accounts configured yet. Add one below.',
				failed: 'Could not load the accounts',
				writeFailed: 'Could not save',
				noRemote: 'This build cannot save: the settings connection is unavailable.',
				editingUnavailable:
					'Editing is unavailable: this host provides no settings connection (or it is not ready yet). Restarting only helps when the service exists but failed to mount.',
				driftStale: 'This page is served by an older build than the source tree. Run deploy.sh, then restart the harness.',
				driftUnknown: 'This build cannot be compared with a source tree, which is normal for a packaged install.',
			},
			zh: {
				nav: 'Amp 账号',
				title: 'Amp 账号',
				intro: 'Amp 任务会自动使用还有余额的账号，用完的账号会被跳过。你可以在这里增删账号。',
				refresh: '刷新余额',
				showAll: '显示全部',
				loading: '读取中…',
				showing: '显示 {shown} / {total}',
				nextUp: '下一个使用',
				spent: '已用完',
				unread: '未读取',
				unreadable: '读取失败',
				remove: '移除',
				add: '添加',
				addPlaceholder: '凭据名，例如 AMP_API_KEY_30',
				empty: '还没有配置账号，在下面添加。',
				failed: '无法读取账号',
				writeFailed: '保存失败',
				noRemote: '这个构建无法保存：设置连接不可用。',
				editingUnavailable: '不能编辑：本宿主未提供 settings 服务（或尚未就绪）。只有「服务存在但挂载失败」时重启才有用。',
				driftStale: '这个页面由旧构建提供：源码已改但安装副本未更新。先跑 deploy.sh，再重启宿主。',
				driftUnknown: '这个构建没有可比较的源码树（打包安装时属正常）。',
			},
		}

		const styles = {
			section: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, color: 'var(--dsw-alias-label-primary)' },
			title: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500 },
			intro: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary)' },
			bar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginTop: 4 },
			count: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
			actions: { display: 'flex', gap: 8 },
			button: {
				padding: '5px 12px',
				fontSize: 13,
				lineHeight: '18px',
				borderRadius: 8,
				border: '1px solid var(--dsw-alias-border-l2)',
				background: 'transparent',
				color: 'inherit',
				cursor: 'pointer',
			},
			linkButton: {
				padding: '2px 6px',
				fontSize: 12,
				lineHeight: '16px',
				borderRadius: 6,
				border: '1px solid transparent',
				background: 'transparent',
				color: 'var(--dsw-alias-label-tertiary)',
				cursor: 'pointer',
			},
			list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, overflow: 'hidden' },
			row: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' },
			rowSep: { borderTop: '1px solid var(--dsw-alias-border-l2)' },
			who: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
			name: { fontSize: 14, lineHeight: '20px', overflowWrap: 'anywhere' },
			ref: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
			badge: { flex: 'none', fontSize: 11, lineHeight: '16px', padding: '2px 7px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)' },
			amount: { flex: 'none', minWidth: 64, textAlign: 'right', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, lineHeight: '20px' },
			addRow: { display: 'flex', gap: 8, marginTop: 4 },
			input: {
				flex: 1,
				minWidth: 0,
				padding: '6px 10px',
				fontSize: 13,
				lineHeight: '18px',
				borderRadius: 8,
				border: '1px solid var(--dsw-alias-border-l2)',
				background: 'transparent',
				color: 'inherit',
			},
			note: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
			error: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)' },
		}

		/**
		 * What one row tells the user. "Which account runs next" is the question this
		 * page exists for, so it wins over everything except a spent account.
		 */
		function statusOf(account, isNext) {
			if (account.exhausted === true) return 'spent'
			if (account.assumed !== true && account.readable !== true) return 'unreadable'
			if (isNext) return 'nextUp'
			if (account.assumed === true) return 'unread'
			return 'ok'
		}

		const STATUS_COLOR = {
			nextUp: 'var(--dsw-alias-state-success-primary)',
			spent: 'var(--dsw-alias-state-error-primary)',
			unreadable: 'var(--dsw-alias-state-warning-primary)',
			unread: 'var(--dsw-alias-label-tertiary)',
			ok: 'var(--dsw-alias-label-tertiary)',
		}

		function amountOf(account) {
			if (typeof account.remaining !== 'number') return '—'
			if (account.exhausted === true) return '$0.00'
			return `$${account.remaining.toFixed(2)}`
		}

		async function request(path) {
			const response = await fetch(path, { cache: 'no-store', headers: { 'x-dsh-amp': '1' } })
			const body = await response.json().catch(() => null)
			if (!response.ok || body === null || body.ok !== true) {
				throw new Error(body && typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
			}
			return body
		}

		function AccountRow({ account, isNext, first, t, onRemove, canEdit }) {
			const status = statusOf(account, isNext)
			const label = status === 'ok' ? null : t(status)
			return React.createElement(
				'li',
				{ style: first === true ? styles.row : { ...styles.row, ...styles.rowSep } },
				React.createElement(
					'div',
					{ style: styles.who },
					React.createElement('span', { style: styles.name }, account.email ?? account.ref),
					account.email === undefined ? null : React.createElement('span', { style: styles.ref }, account.ref),
				),
				label === null ? null : React.createElement('span', { style: { ...styles.badge, color: STATUS_COLOR[status] } }, label),
				React.createElement('span', { style: styles.amount }, amountOf(account)),
				canEdit ? React.createElement('button', { style: styles.linkButton, onClick: () => onRemove(account.ref) }, t('remove')) : null,
			)
		}

		function AmpAccountsPage(props) {
			const t = props.t
			const write = props.write
			const [phase, setPhase] = React.useState({ kind: 'loading' })
			const [busy, setBusy] = React.useState(false)
			const [limit, setLimit] = React.useState(DEFAULT_LIMIT)
			const [allRefs, setAllRefs] = React.useState([])
			const [draft, setDraft] = React.useState('')
			const [writeError, setWriteError] = React.useState(null)
			const mounted = React.useRef(true)

			const load = React.useCallback((nextLimit, doRefresh) => {
				if (!mounted.current) return
				setBusy(true)
				setPhase({ kind: 'loading' })
				const parts = []
				if (nextLimit !== undefined) parts.push(`limit=${String(nextLimit)}`)
				if (doRefresh === true) parts.push('refresh=1')
				const query = parts.length === 0 ? '' : `?${parts.join('&')}`
				request(`${API}/accounts${query}`)
					.then((body) => {
						if (!mounted.current) return
						setAllRefs(Array.isArray(body.allRefs) ? body.allRefs : [])
						setPhase({ kind: 'ready', body })
					})
					.catch((error) => {
						if (mounted.current) setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
					})
					.finally(() => {
						if (mounted.current) setBusy(false)
					})
			}, [])

			React.useEffect(() => {
				mounted.current = true
				load(DEFAULT_LIMIT, false)
				return () => {
					mounted.current = false
				}
			}, [load])

			/** Save the WHOLE list; `allRefs` is the full ordered set, never the slice. */
			const commit = (nextRefs, after) => {
				if (typeof write !== 'function') {
					setWriteError(t('noRemote'))
					return
				}
				setBusy(true)
				setWriteError(null)
				write(nextRefs)
					.then(() => {
						if (!mounted.current) return
						if (typeof after === 'function') after()
						load(limit, false)
					})
					.catch((error) => {
						if (mounted.current) {
							setBusy(false)
							setWriteError(`${t('writeFailed')}：${error instanceof Error ? error.message : String(error)}`)
						}
					})
			}

			const add = () => {
				const name = draft.trim()
				if (name === '') return
				if (allRefs.includes(name)) {
					setWriteError(`${t('writeFailed')}：${name}`)
					return
				}
				commit([...allRefs, name], () => setDraft(''))
			}

			// Editing requires BOTH a settings connection and a trustworthy full ref list.
			// A page that offered Remove while `allRefs` was empty would write an empty
			// list back and delete every account. A namespace the host row could not register
			// disables editing too: the save would land somewhere this plugin does not read.
			const settingsError = phase.kind === 'ready' ? phase.body.settingsError : undefined
			const canEdit =
				typeof write === 'function' && phase.kind === 'ready' && phase.body.allRefsAvailable === true && settingsError === undefined

			const bar = React.createElement(
				'div',
				{ style: styles.bar },
				React.createElement(
					'span',
					{ style: styles.count },
					phase.kind === 'ready'
						? t('showing').replace('{shown}', String(phase.body.shown)).replace('{total}', String(phase.body.total))
						: '',
				),
				React.createElement(
					'div',
					{ style: styles.actions },
					phase.kind === 'ready' && phase.body.shown < phase.body.total
						? React.createElement(
								'button',
								{
									style: styles.button,
									disabled: busy,
									onClick: () => {
										setLimit(0)
										load(0, false)
									},
								},
								t('showAll'),
							)
						: null,
					React.createElement('button', { style: styles.button, disabled: busy, onClick: () => load(limit, true) }, t('refresh')),
				),
			)

			const addRow = canEdit
				? React.createElement(
						'div',
						{ style: styles.addRow },
						React.createElement('input', {
							style: styles.input,
							value: draft,
							placeholder: t('addPlaceholder'),
							disabled: busy,
							onChange: (event) => setDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') add()
							},
						}),
						React.createElement('button', { style: styles.button, disabled: busy || draft.trim() === '', onClick: add }, t('add')),
					)
				: phase.kind === 'ready'
					? React.createElement('p', { style: styles.note }, t('editingUnavailable'))
					// Before the body arrives there is nothing to say about editing: claiming it is
					// unavailable while the page is still LOADING is simply false.
					: null

			let body
			if (phase.kind === 'error') {
				body = React.createElement('p', { style: styles.error }, `${t('failed')}：${phase.message}`)
			} else if (phase.kind === 'loading') {
				body = React.createElement('p', { style: styles.note }, t('loading'))
			} else if (phase.body.accounts.length === 0) {
				body = React.createElement('p', { style: styles.note }, t('empty'))
			} else {
				const accounts = phase.body.accounts
				// Which account will ACTUALLY be used is the pool's answer, sent with the payload:
				// this half used to re-derive it from "first not exhausted" and drifted from the real
				// policy (floor, headroom, cooling, assumed grants).
				const nextUp = phase.body.next?.byMode?.medium ?? phase.body.next?.byMode?.low
				let nextIndex = -1
				if (nextUp !== undefined && nextUp !== null) {
					nextIndex = accounts.findIndex((account) => account.ref === nextUp.ref)
				} else {
					for (let i = 0; i < accounts.length; i += 1) {
						if (accounts[i].exhausted !== true) {
							nextIndex = i
							break
						}
					}
				}
				body = React.createElement(
					'ul',
					{ style: styles.list },
					accounts.map((account, index) =>
						React.createElement(AccountRow, {
							key: account.ref,
							account,
							isNext: index === nextIndex,
							first: index === 0,
							t,
							canEdit: canEdit,
							onRemove: (ref) => commit(allRefs.filter((value) => value !== ref)),
						}),
					),
				)
			}

			return React.createElement(
				'section',
				{ style: styles.section },
				React.createElement('h2', { style: styles.title }, t('title')),
				React.createElement('p', { style: styles.intro }, t('intro')),
				phase.kind === 'ready' && phase.body.source && phase.body.source.drift === 'STALE'
					? React.createElement('p', { style: styles.error }, t('driftStale'))
					: null,
				// "Cannot compare" must not LOOK like "confirmed current": silence would let a
				// packaged install silently read as healthy. It is neutral, not alarming.
				phase.kind === 'ready' && phase.body.source && phase.body.source.drift === 'unknown'
					? React.createElement('p', { style: styles.note }, t('driftUnknown'))
					: null,
				// A namespace the host row could not register: say what is broken and that
				// nothing on this page will apply. Silence here is the failure that mattered.
				settingsError === undefined ? null : React.createElement('p', { style: styles.error }, settingsError),
				bar,
				body,
				addRow,
				writeError === null ? null : React.createElement('p', { style: styles.error }, writeError),
			)
		}

		const inject = ['slots', 'locale', 'remote']

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-amp: client dictionaries')
			const t = ctx.locale.bind(NS)
			/**
			 * The write half, only when the settings Remote is really there.
			 *
			 * `remote.settings` is a NESTED contribution: the top-level `remote` service can
			 * exist while that namespace contribution is still mounting (or failed), and then
			 * `ctx.remote.settings.update(...)` throws SYNCHRONOUSLY — before returning a
			 * promise, so a caller's `.catch` never sees it and the page stays busy forever.
			 * Resolving it here turns that into the read-only degradation this page documents.
			 */
			const settingsRemote = ctx.get('remote.settings')
			const write =
				settingsRemote !== undefined && typeof settingsRemote.update === 'function'
					? (refs) => settingsRemote.update(NS, { accountRefs: refs }, undefined)
					: undefined
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register({ name: 'settings.section', id: NS, order: 12, label: () => t('nav') }, () =>
					React.createElement(AmpAccountsPage, { t, write }),
				),
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
